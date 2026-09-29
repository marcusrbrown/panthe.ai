// S12: a proposal accepted and then SIGKILLed before any tick is still in the
// journal on restart, runs exactly once on a catch-up tick, and a retry
// reports its outcome without running it again.

import { Database } from "bun:sqlite";
import legendJournal from "../fixtures/legend-journal.json";
import { check, waitFor } from "../helpers";
import { activeStorePath, backdateCursor, type JournalRow } from "../world-db";
import { fmt, outcomeOf, postFixture, waitForLog, waitForTicks } from "./api";
import type { Recorder, Story } from "./context";
import {
  eventsOf,
  journalOf,
  maxSequenceOnDisk,
  persistedClock,
} from "./direct";

export async function stepJournalKill(
  recorder: Recorder,
  story: Story,
): Promise<void> {
  await recorder.run(
    "S12",
    "Durable proposal across a kill",
    "A proposal accepted over /proposals and then SIGKILLed before any tick is still in the journal on restart, runs exactly once on a catch-up tick with a recorded outcome, and a retry of its proposalId reports that outcome without running it again.",
    async (step) => {
      let posted: Awaited<ReturnType<typeof postFixture>> | undefined;
      let accepted: JournalRow | undefined;
      for (
        let attempt = 1;
        attempt <= 3 && accepted === undefined;
        attempt += 1
      ) {
        const attemptPost = await postFixture(story, legendJournal);
        check(
          attemptPost.status === 202 &&
            (attemptPost.body as { status?: string }).status === "pending",
          "the proposal is accepted as pending",
          `${attemptPost.status} ${fmt(attemptPost.body)}`,
        );
        const exitCode = await story.sidecar.stop("SIGKILL");
        check(
          exitCode !== 0,
          "the sidecar was killed",
          `exit code ${exitCode}`,
        );
        // Direct read: the sidecar is killed, so only the store can say what it held.
        const row = journalOf(story).find(
          (candidate) => candidate.proposalId === attemptPost.proposalId,
        );
        check(
          row !== undefined,
          "the accepted proposal is in the journal after the kill",
          "no journal row: it was lost with the process",
        );
        if (row.consumedTick === undefined) {
          posted = attemptPost;
          accepted = row;
        } else {
          // A tick committed between the 202 and the kill; try again with a fresh proposal.
          await story.restart();
        }
      }
      check(
        posted !== undefined && accepted !== undefined,
        "a proposal was killed while still pending",
        "three attempts each raced a tick",
      );
      // Direct read: the sidecar is killed, so no endpoint answers.
      const tickAtKill = persistedClock(story).tick;
      check(
        accepted.targetTick === tickAtKill + 1,
        "the entry targets the tick after the persisted clock",
        `target ${accepted.targetTick}, clock tick ${tickAtKill}`,
      );
      const sequenceAtKill = maxSequenceOnDisk(story);

      // The machine "slept" while the service was down: the restart's startup
      // catch-up is what runs the proposal.
      const path = activeStorePath(story.dataDir);
      backdateCursor(path, persistedClock(story).cursorWallMs - 2 * 60 * 1000);
      if (story.options.control === "journal") {
        // Positive control: a service that kept accepted proposals only in
        // memory would have lost this one with the process.
        const db = new Database(path);
        try {
          db.run("DELETE FROM external_proposals WHERE proposal_id = ?", [
            posted.proposalId,
          ]);
        } finally {
          db.close();
        }
      }
      const restarted = await story.restart();
      await waitForLog(
        restarted,
        "startup catch-up complete",
        "the startup catch-up after the kill finishes",
      );
      const consumed = await waitFor(
        "the accepted proposal was consumed after the restart",
        () => {
          // Direct read: consumed_tick and the persisted outcome are on the journal row; no endpoint serves them.
          const row = journalOf(story).find(
            (candidate) => candidate.proposalId === posted.proposalId,
          );
          return row?.consumedTick === undefined ? undefined : row;
        },
        { timeoutMs: 5000, intervalMs: 100 },
      );
      check(
        consumed.consumedTick === accepted.targetTick,
        "it ran on the first tick after the kill, a catch-up tick",
        `consumed at ${consumed.consumedTick}, target ${accepted.targetTick}`,
      );
      check(
        consumed.outcome === "committed",
        "its journal row records the committed outcome",
        `${consumed.outcome} ${consumed.reason}`,
      );
      const outcome = await outcomeOf(
        story,
        posted.proposalId,
        "the proposal's outcome is recorded in the trace",
      );
      check(
        outcome.outcome === "committed",
        "the trace records it committed",
        `${outcome.outcome} ${outcome.reason}`,
      );
      const caused = eventsOf(story, sequenceAtKill + 1).filter(
        (event) => event.correlationId === posted.observationId,
      );
      check(
        caused.length === 1 && caused[0]?.kind === "legend-recorded",
        "it ran exactly once: one legend-recorded event",
        caused.map((event) => event.kind).join(),
      );
      check(
        caused[0]?.approximate === true,
        "it ran on a catch-up tick, so its event is marked approximate",
        `approximate ${caused[0]?.approximate}`,
      );

      const retry = await restarted.request(
        "POST",
        "/proposals",
        posted.envelope,
      );
      check(
        retry.status === 200 &&
          (retry.body as { status?: string; queued?: boolean }).status ===
            "committed" &&
          (retry.body as { queued?: boolean }).queued === false,
        "a retry of the same proposalId reports its recorded outcome",
        `${retry.status} ${fmt(retry.body)}`,
      );
      const changed = await restarted.request("POST", "/proposals", {
        ...posted.envelope,
        proposal: {
          ...(posted.envelope.proposal as object),
          assertion: "A different tale under the same id.",
        },
      });
      check(
        changed.status === 409,
        "the same proposalId with changed content is refused",
        `${changed.status} ${fmt(changed.body)}`,
      );
      await waitForTicks(story, 2, "two ticks pass after the retries");
      check(
        eventsOf(story).filter(
          (event) => event.correlationId === posted.observationId,
        ).length === 1,
        "the retries and later ticks did not run it again",
        "extra events found",
      );
      step.done(
        `accepted at clock tick ${tickAtKill}, SIGKILLed while pending; after restart it ran on catch-up tick ${consumed.consumedTick} (one approximate legend-recorded event), outcome ${consumed.outcome}; a retry returned ${fmt((retry.body as { status?: string }).status)}, changed content 409`,
        [
          {
            name: "target tick of the killed proposal",
            unit: "tick",
            value: accepted.targetTick,
          },
        ],
      );
    },
  );
}
