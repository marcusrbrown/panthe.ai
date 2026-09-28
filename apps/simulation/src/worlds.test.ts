import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeStore,
  commitTick,
  exportArchive,
  openStore,
  readClock,
  readLiveProjections,
} from "@panthea/persistence";
import { createPrng, runTick, submitProposal } from "@panthea/world";
import {
  createWorldProjectionReducers,
  loadGreekWorldState,
  restoreWorldTime,
  serializePrngState,
  worldProjectionCodec,
} from "./world-store";
import { importWorldArchive, listWorldSlots } from "./worlds";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("listWorldSlots returns nothing for a slots directory that does not exist yet", () => {
  expect(
    listWorldSlots(join(tmpdir(), "panthea-sim-worlds-missing-does-not-exist")),
  ).toEqual([]);
});

test("listWorldSlots excludes in-progress staging directories and lists only fully materialized slots", () => {
  const slotsDir = tempDir("panthea-sim-worlds-list-");
  try {
    expect(listWorldSlots(slotsDir)).toEqual([]);

    const fakeSlot = join(slotsDir, "slot-abc");
    mkdirSync(fakeSlot);
    const stagingDir = join(slotsDir, ".staging-xyz");
    mkdirSync(stagingDir);

    const slots = listWorldSlots(slotsDir);
    expect(slots).toEqual([{ slotId: "slot-abc", slotPath: fakeSlot }]);
  } finally {
    rmSync(slotsDir, { recursive: true, force: true });
  }
});

test("importing an archive while the active world is running creates exactly one new slot and leaves the active world undisturbed", () => {
  const storeDir = tempDir("panthea-sim-worlds-active-");
  const exportDir = tempDir("panthea-sim-worlds-export-");
  const slotsDir = tempDir("panthea-sim-worlds-slots-");
  try {
    const storePath = join(storeDir, "world.sqlite");
    const seeded = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(seeded);
    const store = openStore(storePath, reducers);

    const submitted = submitProposal({
      schemaVersion: 1,
      actor: "farmer",
      targets: [],
      expectedRevisions: [],
      source: "fixture",
      observationId: "obs-1",
      kind: "move",
      to: "tavern",
    });
    if (!submitted.ok) throw new Error("test fixture proposal failed to parse");
    const tick1 = runTick(seeded, createPrng(1), [submitted.proposal]);
    commitTick(store, reducers, {
      events: tick1.events,
      cursorWallMs: 1_000,
      paused: false,
      tick: tick1.state.tick,
      simTimeMs: tick1.state.simTime,
      prngState: serializePrngState(tick1.prng),
    });

    const beforeImport = restoreWorldTime(
      readLiveProjections(store, reducers),
      readClock(store.db),
    );

    expect(listWorldSlots(slotsDir)).toEqual([]);

    const exportPath = join(exportDir, "archive.sqlite");
    exportArchive(store, exportPath);
    const result = importWorldArchive(
      exportPath,
      slotsDir,
      worldProjectionCodec,
    );

    const slots = listWorldSlots(slotsDir);
    expect(slots).toHaveLength(1);
    expect(slots[0]?.slotId).toBe(result.slotId);
    expect(
      readdirSync(slotsDir).some((name) => name.startsWith(".staging-")),
    ).toBe(false);

    // The active world's own store is untouched: same live state, same
    // clock, still open and usable at its original path.
    const afterImport = restoreWorldTime(
      readLiveProjections(store, reducers),
      readClock(store.db),
    );
    expect(afterImport).toEqual(beforeImport);

    const importedStore = openStore(
      join(result.slotPath, "world.sqlite"),
      reducers,
    );
    const importedState = restoreWorldTime(
      readLiveProjections(importedStore, reducers),
      readClock(importedStore.db),
    );
    expect(importedState).toEqual(beforeImport);
    expect(importedStore.worldId).toBe(store.worldId);
    closeStore(importedStore);

    closeStore(store);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(exportDir, { recursive: true, force: true });
    rmSync(slotsDir, { recursive: true, force: true });
  }
});
