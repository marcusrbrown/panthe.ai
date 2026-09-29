// S14: export, a corrupted copy, import, and restore: an import makes a new
// slot, a changed byte is rejected, and a restore branches the same history
// and journal while the active world is untouched.

import {
  copyFileSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { check, corruptArchiveBytes } from "../helpers";
import {
  hashEventPrefix,
  integrityCheck,
  readClockRow,
  readJournal,
  readMaxSequence,
  slotStorePath,
  withWorldDb,
} from "../world-db";
import { fmt, readFrame, waitForTicks } from "./api";
import type { Recorder, Story } from "./context";
import { historyDigestOf, journalOf } from "./direct";

export async function stepArchives(
  recorder: Recorder,
  story: Story,
): Promise<void> {
  await recorder.run(
    "S14",
    "Export, corrupt copy, import, restore",
    "An export imports into a new slot; a copy with one changed byte is rejected and creates no slot; restoring the snapshot makes a branch slot holding the same history and the same proposal journal (ids, order, terminal outcomes) up to the snapshot while the active world is untouched.",
    async (step) => {
      const exportPath = join(story.root, "export.sqlite");
      const sequenceBefore = (await readFrame(story.sidecar)).frame.sequence;
      const exported = await story.sidecar.request("POST", "/export", {
        path: exportPath,
      });
      check(
        exported.status === 200,
        "POST /export answers",
        `${exported.status} ${fmt(exported.body)}`,
      );
      const manifest = (
        exported.body as {
          manifest: {
            eventSequence: number;
            worldId: string;
            contentHash: string;
          };
        }
      ).manifest;
      const { frame } = await readFrame(story.sidecar);
      check(
        manifest.worldId === frame.worldId,
        "the manifest names this world",
        manifest.worldId,
      );
      check(
        manifest.eventSequence >= sequenceBefore,
        "the export is pinned at a committed sequence no earlier than the request",
        `${manifest.eventSequence} vs ${sequenceBefore}`,
      );

      const corruptPath = join(story.root, "export-corrupt.sqlite");
      if (story.options.control === "archive") {
        // Positive control: an unchanged "corrupted" copy must be caught by the same check that would have rejected it.
        copyFileSync(exportPath, corruptPath);
      } else {
        writeFileSync(
          corruptPath,
          corruptArchiveBytes(readFileSync(exportPath), "income-earned"),
        );
      }

      const slotsBefore = (await story.sidecar.request("GET", "/slots"))
        .body as { slots: unknown[] };
      check(
        slotsBefore.slots.length === 0,
        "no slot exists before any import",
        fmt(slotsBefore),
      );

      const imported = await story.sidecar.request("POST", "/import", {
        archivePath: exportPath,
      });
      check(
        imported.status === 200,
        "importing the original export succeeds",
        `${imported.status} ${fmt(imported.body)}`,
      );
      const importedSlot = (
        imported.body as { result: { slotId: string; slotPath: string } }
      ).result;
      const slotsAfterImport = (
        (await story.sidecar.request("GET", "/slots")).body as {
          slots: { slotId: string }[];
        }
      ).slots;
      check(
        slotsAfterImport.length === 1 &&
          slotsAfterImport[0]?.slotId === importedSlot.slotId,
        "the import made exactly one new slot",
        fmt(slotsAfterImport),
      );

      const rejected = await story.sidecar.request("POST", "/import", {
        archivePath: corruptPath,
      });
      check(
        rejected.status === 422,
        "importing the corrupted copy is rejected",
        rejected.status === 200
          ? "status 200: the copy was imported into a new slot"
          : `status ${rejected.status} ${fmt(rejected.body)}`,
      );
      check(
        fmt(rejected.body).includes("content hash"),
        "the rejection names the failed content hash",
        fmt(rejected.body),
      );
      const slotsAfterReject = (
        (await story.sidecar.request("GET", "/slots")).body as {
          slots: unknown[];
        }
      ).slots;
      check(
        slotsAfterReject.length === 1,
        "the rejected import created no slot",
        fmt(slotsAfterReject),
      );
      // Filesystem check: /slots lists slots, not staging leftovers.
      const staged = readdirSync(join(story.dataDir, "slots")).filter((name) =>
        name.startsWith(".staging-"),
      );
      check(
        staged.length === 0,
        "the rejected import left no staging directory",
        fmt(staged),
      );

      await waitForTicks(story, 3, "the active world moves past the snapshot");
      const activeBeforeRestore = {
        max: (await readFrame(story.sidecar)).frame.sequence,
        prefix: historyDigestOf(story, manifest.eventSequence),
      };
      const restored = await story.sidecar.request("POST", "/restore", {
        archivePath: exportPath,
      });
      check(
        restored.status === 200,
        "restoring the snapshot succeeds",
        `${restored.status} ${fmt(restored.body)}`,
      );
      const branch = (
        restored.body as { result: { slotId: string; slotPath: string } }
      ).result;
      check(
        branch.slotId !== importedSlot.slotId,
        "the restore made a new branch slot, not the imported one",
        branch.slotId,
      );

      // Direct reads: a slot's store is served by no endpoint (/slots only lists them).
      const inspect = (slotPath: string) =>
        withWorldDb(slotStorePath(slotPath), (db) => ({
          max: readMaxSequence(db),
          clock: readClockRow(db),
          prefix: hashEventPrefix(db, manifest.eventSequence),
          integrity: integrityCheck(db),
          journal: readJournal(db),
        }));
      const importedView = inspect(importedSlot.slotPath);
      const branchView = inspect(branch.slotPath);
      for (const [label, view] of [
        ["imported slot", importedView],
        ["branch slot", branchView],
      ] as const) {
        check(
          view.integrity === "ok",
          `the ${label} passes integrity_check`,
          view.integrity,
        );
        check(
          view.max === manifest.eventSequence,
          `the ${label} holds exactly the snapshot's events`,
          `${view.max} vs ${manifest.eventSequence}`,
        );
        check(
          view.prefix === activeBeforeRestore.prefix,
          `the ${label}'s history matches the active world's byte for byte`,
          "digest differs",
        );
      }
      // The journal travels with the snapshot: same ids, order, and terminal
      // outcomes for everything consumed by then; entries still pending at
      // export may have been consumed since in the active world.
      const activeJournal = journalOf(story);
      for (const [label, view] of [
        ["imported slot", importedView],
        ["branch slot", branchView],
      ] as const) {
        check(
          view.journal.length > 0 &&
            view.journal.length <= activeJournal.length,
          `the ${label} carries the proposal journal`,
          `${view.journal.length} rows of ${activeJournal.length}`,
        );
        for (const row of view.journal) {
          const live = activeJournal[row.inputOrder - 1];
          check(
            live?.proposalId === row.proposalId &&
              live.observationId === row.observationId &&
              live.targetTick === row.targetTick &&
              (row.consumedTick === undefined ||
                (live.consumedTick === row.consumedTick &&
                  live.outcome === row.outcome &&
                  live.reason === row.reason)),
            `the ${label}'s journal entry ${row.inputOrder} matches the active world's, outcome included`,
            fmt([row, live]),
          );
        }
      }
      const activeNow = await readFrame(story.sidecar);
      check(
        branchView.clock.tick < activeNow.state.tick,
        "the branch is a snapshot of the past; the active world has moved on",
        `${branchView.clock.tick} vs ${activeNow.state.tick}`,
      );
      const activeAfter = {
        max: activeNow.frame.sequence,
        prefix: historyDigestOf(story, manifest.eventSequence),
      };
      check(
        activeAfter.max >= activeBeforeRestore.max,
        "the active world kept committing through the restore",
        `${activeBeforeRestore.max} -> ${activeAfter.max}`,
      );
      check(
        activeAfter.prefix === activeBeforeRestore.prefix,
        "the restore left the active world's history untouched",
        "digest changed",
      );
      step.done(
        `export at sequence ${manifest.eventSequence}; import made 1 slot; corrupted copy rejected (${rejected.status}) with no slot and no staging directory; restore made a second slot; both slots hold ${importedView.max} events and ${importedView.journal.length} journal entries matching the active world; the active world was at sequence ${activeBeforeRestore.max} before the restore and ${activeAfter.max} after`,
        [
          {
            name: "exported event sequence",
            unit: "events",
            value: manifest.eventSequence,
          },
          {
            name: "slots after import, corrupt import, and restore",
            unit: "slots",
            value: 2,
          },
        ],
      );
    },
  );
}
