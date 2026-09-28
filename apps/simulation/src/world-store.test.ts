// Integration test: the full pipeline through real world rules/reducers
// and a real SQLite store, with the authored Greek content pack -- proves
// packages/world and packages/persistence actually compose, not just that
// each package's own unit tests pass in isolation.

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Proposal } from "@panthea/contracts";
import {
  closeStore,
  commitTick,
  exportArchive,
  importArchive,
  openStore,
  type ProjectionCodec,
  readClock,
  readLiveProjections,
  readPrngState,
  rebuildProjections,
} from "@panthea/persistence";
import {
  createPrng,
  runTick,
  submitProposal,
  toEntityId,
  withActor,
} from "@panthea/world";
import {
  createWorldProjectionReducers,
  deserializePrngState,
  loadGreekWorldState,
  restoreWorldTime,
  serializePrngState,
  worldProjectionCodec,
} from "./world-store";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function moveProposal(
  actor: string,
  to: string,
  observationId: string,
  overrides: Record<string, unknown> = {},
): Proposal {
  const submitted = submitProposal({
    schemaVersion: 1,
    actor,
    targets: [],
    expectedRevisions: [],
    source: "fixture",
    observationId,
    kind: "move",
    to,
    ...overrides,
  });
  if (!submitted.ok) {
    throw new Error(
      `test fixture proposal failed to parse: ${submitted.rejection.message}`,
    );
  }
  return submitted.proposal;
}

test("real world reducers/rules through a real store: tick, restart, and export/import all compose", () => {
  const storeDir = tempDir("panthea-sim-store-");
  const slotsDir = tempDir("panthea-sim-slots-");
  const exportDir = tempDir("panthea-sim-export-");

  try {
    const storePath = join(storeDir, "world.sqlite");

    const seededState = withActor(loadGreekWorldState(), {
      id: toEntityId("wanderer"),
      locationId: toEntityId("wilderness-grove"),
      alive: true,
      capabilities: [],
      revision: 0,
    });

    const projectionReducers = createWorldProjectionReducers(seededState);

    let store = openStore(storePath);

    // --- 1. Two ticks, contiguous sequences across ticks ------------------
    const prng0 = createPrng(1);
    const tick1 = runTick(seededState, prng0, [
      moveProposal("wanderer", "wilderness-path", "obs-1"),
    ]);
    expect(tick1.rejected).toEqual([]);
    const events1 = tick1.committed.flatMap((record) => record.events);
    expect(events1.map((event) => event.sequence)).toEqual([1]);

    const commit1 = commitTick(store, projectionReducers, {
      events: events1,
      cursorWallMs: 1_000,
      paused: false,
      tick: tick1.state.tick,
      simTimeMs: tick1.state.simTime,
      prngState: serializePrngState(tick1.prng),
    });
    expect(commit1.sequence).toBe(1);

    const tick2 = runTick(tick1.state, tick1.prng, [
      moveProposal("wanderer", "town-square", "obs-2"),
    ]);
    expect(tick2.rejected).toEqual([]);
    const events2 = tick2.committed.flatMap((record) => record.events);
    // Contiguous with tick 1's sequence, not reset to 1 again.
    expect(events2.map((event) => event.sequence)).toEqual([2]);

    const commit2 = commitTick(store, projectionReducers, {
      events: events2,
      cursorWallMs: 2_000,
      paused: false,
      tick: tick2.state.tick,
      simTimeMs: tick2.state.simTime,
      prngState: serializePrngState(tick2.prng),
    });
    expect(commit2.sequence).toBe(2);
    expect(tick2.state.tick).toBe(2);
    expect(tick2.state.simTime).toBe(2_000);
    expect(tick2.state.lastSequence).toBe(2);

    // --- 2. Close -> reopen -> live projections restored to the full state
    closeStore(store);
    store = openStore(storePath);

    const restoredAfterReopen = restoreWorldTime(
      readLiveProjections(store, projectionReducers),
      readClock(store.db),
    );
    expect(restoredAfterReopen).toEqual(tick2.state);
    expect(restoredAfterReopen.actors).toBeInstanceOf(Map);
    expect(restoredAfterReopen.locations).toBeInstanceOf(Map);
    expect(
      restoredAfterReopen.actors.get(toEntityId("wanderer")),
    ).toMatchObject({
      locationId: "town-square",
    });

    const rebuiltAfterReopen = restoreWorldTime(
      rebuildProjections(store, projectionReducers),
      readClock(store.db),
    );
    expect(rebuiltAfterReopen).toEqual(tick2.state);

    // --- 3. Continue ticking from the reopened, restored state ------------
    //        Nothing from tick1/tick2 is held in memory here except what a
    //        real restart would also have: the store itself. Restore the
    //        PRNG from the store too, rather than reusing `tick2.prng`.
    const restoredPrng = deserializePrngState(readPrngState(store.db));
    expect(restoredPrng).toEqual(tick2.prng);
    const tick3 = runTick(restoredAfterReopen, restoredPrng ?? createPrng(1), [
      moveProposal("wanderer", "tavern", "obs-3"),
    ]);
    expect(tick3.rejected).toEqual([]);
    const events3 = tick3.committed.flatMap((record) => record.events);
    expect(events3.map((event) => event.sequence)).toEqual([3]);

    const commit3 = commitTick(store, projectionReducers, {
      events: events3,
      cursorWallMs: 3_000,
      paused: false,
      tick: tick3.state.tick,
      simTimeMs: tick3.state.simTime,
      prngState: serializePrngState(tick3.prng),
    });
    expect(commit3.sequence).toBe(3);

    // --- 4. Export -> importArchive (world codec) -> reopen -> equal ------
    const exportPath = join(exportDir, "archive.sqlite");
    const manifest = exportArchive(store, exportPath);
    expect(manifest.eventSequence).toBe(3);

    const importValidationCodec: ProjectionCodec<unknown> = {
      encode: (value) => value,
      decode: (value) => worldProjectionCodec.decode(value as never),
    };
    const importResult = importArchive(
      exportPath,
      slotsDir,
      importValidationCodec,
    );

    const importedStore = openStore(
      join(importResult.slotPath, "world.sqlite"),
    );
    const restoredAfterImport = restoreWorldTime(
      readLiveProjections(importedStore, projectionReducers),
      readClock(importedStore.db),
    );
    expect(restoredAfterImport).toEqual(tick3.state);
    expect(importedStore.worldId).toBe(store.worldId);
    closeStore(importedStore);

    // --- 5. A proposal declaring a nonzero cost is rejected before it ever
    //        reaches the queue; nothing beyond the rejection is committed.
    const costlySubmission = submitProposal({
      schemaVersion: 1,
      actor: "wanderer",
      targets: [],
      expectedRevisions: [],
      source: "fixture",
      observationId: "obs-4",
      kind: "move",
      to: "inn",
      costs: [{ resource: "food", amount: 1 }],
    });
    expect(costlySubmission.ok).toBe(false);
    if (!costlySubmission.ok) {
      expect(costlySubmission.rejection.reason).toBe("unauthorized-claim");
    }

    const commit4 = commitTick(store, projectionReducers, {
      events: [],
      cursorWallMs: 4_000,
      paused: false,
      tick: tick3.state.tick,
      simTimeMs: tick3.state.simTime,
      prngState: serializePrngState(tick3.prng),
    });
    // Sequence is unchanged: no events were committed.
    expect(commit4.sequence).toBe(3);
    const restoredAfterRejection = restoreWorldTime(
      readLiveProjections(store, projectionReducers),
      readClock(store.db),
    );
    expect(restoredAfterRejection).toEqual(tick3.state);

    closeStore(store);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(slotsDir, { recursive: true, force: true });
    rmSync(exportDir, { recursive: true, force: true });
  }
});

// Exercises `deserializePrngState`'s empty-string seed-row case directly,
// since the happy-path scenario above never opens a truly brand-new store
// without ever having written a PRNG state.
test("deserializePrngState treats the empty seed-row string as undefined", () => {
  expect(deserializePrngState("")).toBeUndefined();
  expect(deserializePrngState(JSON.stringify({ seed: 7 }))).toEqual({
    seed: 7,
  });
});
