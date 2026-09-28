// Integration test: the full pipeline through real world rules/reducers
// and a real SQLite store, with the authored Greek content pack -- proves
// packages/world and packages/persistence actually compose, not just that
// each package's own unit tests pass in isolation.

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Proposal } from "@panthea/contracts";
import {
  closeStore,
  commitTick,
  computeContentHash,
  exportArchive,
  ImportError,
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
  decideRoutineProposal,
  getResourceAmount,
  runTick,
  submitProposal,
  toEntityId,
  type WorldState,
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
      inventory: new Map(),
      revision: 0,
    });

    const projectionReducers = createWorldProjectionReducers(seededState);

    let store = openStore(storePath, projectionReducers);

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
    store = openStore(storePath, projectionReducers);

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
      decode: (value) => worldProjectionCodec.decode(value),
    };
    const importResult = importArchive(
      exportPath,
      slotsDir,
      importValidationCodec,
    );

    const importedStore = openStore(
      join(importResult.slotPath, "world.sqlite"),
      projectionReducers,
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

test("rebuild restores the seeded actor even from a freshly constructed composition root with no reference to the original seeded state", () => {
  const storeDir = tempDir("panthea-sim-genesis-");
  const exportDir = tempDir("panthea-sim-genesis-export-");
  const slotsDir = tempDir("panthea-sim-genesis-slots-");

  try {
    const storePath = join(storeDir, "world.sqlite");

    const seeded = withActor(loadGreekWorldState(), {
      id: toEntityId("wanderer"),
      locationId: toEntityId("wilderness-grove"),
      alive: true,
      capabilities: [],
      inventory: new Map(),
      revision: 0,
    });
    const seededReducers = createWorldProjectionReducers(seeded);

    let store = openStore(storePath, seededReducers);

    const prng0 = createPrng(1);
    const tick1 = runTick(seeded, prng0, [
      moveProposal("wanderer", "wilderness-path", "obs-1"),
    ]);
    commitTick(store, seededReducers, {
      events: tick1.committed.flatMap((record) => record.events),
      cursorWallMs: 1_000,
      paused: false,
      tick: tick1.state.tick,
      simTimeMs: tick1.state.simTime,
      prngState: serializePrngState(tick1.prng),
    });

    const tick2 = runTick(tick1.state, tick1.prng, [
      moveProposal("wanderer", "town-square", "obs-2"),
    ]);
    commitTick(store, seededReducers, {
      events: tick2.committed.flatMap((record) => record.events),
      cursorWallMs: 2_000,
      paused: false,
      tick: tick2.state.tick,
      simTimeMs: tick2.state.simTime,
      prngState: serializePrngState(tick2.prng),
    });
    closeStore(store);

    // A freshly constructed composition root: new reducers built from
    // loadGreekWorldState() again, with no reference to the seeded actor.
    const freshReducers = createWorldProjectionReducers(loadGreekWorldState());
    store = openStore(storePath, freshReducers);

    const rebuilt = restoreWorldTime(
      rebuildProjections(store, freshReducers),
      readClock(store.db),
    );
    const live = restoreWorldTime(
      readLiveProjections(store, freshReducers),
      readClock(store.db),
    );

    expect(live).toEqual(tick2.state);
    expect(rebuilt).toEqual(tick2.state);

    // export -> import -> rebuild, still with the fresh (actor-less) reducers
    const exportPath = join(exportDir, "archive.sqlite");
    exportArchive(store, exportPath);
    const importValidationCodec: ProjectionCodec<unknown> = {
      encode: (value) => value,
      decode: (value) => worldProjectionCodec.decode(value),
    };
    const importResult = importArchive(
      exportPath,
      slotsDir,
      importValidationCodec,
    );
    const importedStore = openStore(
      join(importResult.slotPath, "world.sqlite"),
      freshReducers,
    );

    const rebuiltAfterImport = restoreWorldTime(
      rebuildProjections(importedStore, freshReducers),
      readClock(importedStore.db),
    );
    expect(rebuiltAfterImport).toEqual(tick2.state);

    closeStore(importedStore);
    closeStore(store);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(exportDir, { recursive: true, force: true });
    rmSync(slotsDir, { recursive: true, force: true });
  }
});

test("an archive whose genesis row contains a malformed actor entry is rejected as corrupt, even after rehashing; no slot is created", () => {
  const storeDir = tempDir("panthea-sim-malformed-genesis-");
  const exportDir = tempDir("panthea-sim-malformed-genesis-export-");
  const slotsDir = tempDir("panthea-sim-malformed-genesis-slots-");

  try {
    const storePath = join(storeDir, "world.sqlite");
    const seeded = withActor(loadGreekWorldState(), {
      id: toEntityId("wanderer"),
      locationId: toEntityId("wilderness-grove"),
      alive: true,
      capabilities: [],
      inventory: new Map(),
      revision: 0,
    });
    const reducers = createWorldProjectionReducers(seeded);

    const store = openStore(storePath, reducers);
    const exportPath = join(exportDir, "archive.sqlite");
    exportArchive(store, exportPath);
    closeStore(store);

    // Insert a malformed actor entry (`["wanderer", null]`) into the
    // archive's genesis row, then recompute the hash so the tamper is
    // self-consistent -- a plain hash check alone cannot catch this.
    const archiveDb = new Database(exportPath);
    const genesisRow = archiveDb
      .query("SELECT data FROM genesis WHERE id = 1")
      .get() as { data: string };
    const encoded = JSON.parse(genesisRow.data) as {
      actors: unknown[];
      [key: string]: unknown;
    };
    const corrupted = {
      ...encoded,
      actors: [...encoded.actors, ["wanderer", null]],
    };
    archiveDb.run("UPDATE genesis SET data = ? WHERE id = 1", [
      JSON.stringify(corrupted),
    ]);
    const manifestRow = archiveDb
      .query("SELECT * FROM manifest WHERE id = 1")
      .get() as {
      format_version: number;
      sqlite_schema_version: number;
      payload_schema_version: number;
      world_id: string;
      event_sequence: number;
    };
    const newHash = computeContentHash(archiveDb, {
      formatVersion: manifestRow.format_version,
      sqliteSchemaVersion: manifestRow.sqlite_schema_version,
      payloadSchemaVersion: manifestRow.payload_schema_version,
      worldId: manifestRow.world_id as never,
      eventSequence: manifestRow.event_sequence,
    });
    archiveDb.run("UPDATE manifest SET content_hash = ?", [newHash]);
    archiveDb.close();

    const importValidationCodec: ProjectionCodec<unknown> = {
      encode: (value) => value,
      decode: (value) => worldProjectionCodec.decode(value),
    };
    let caught: unknown;
    try {
      importArchive(exportPath, slotsDir, importValidationCodec);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ImportError);
    expect((caught as ImportError).kind).toBe("corrupt");
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(exportDir, { recursive: true, force: true });
    rmSync(slotsDir, { recursive: true, force: true });
  }
});

function totalAcrossActors(state: WorldState, resource: string): number {
  let total = 0;
  for (const actor of state.actors.values()) {
    total += getResourceAmount(actor.inventory, resource);
  }
  return total;
}

test("an economy run of routine-driven inhabitants through a real store conserves currency and survives reopen and rebuild", () => {
  const storeDir = tempDir("panthea-sim-economy-");

  try {
    const storePath = join(storeDir, "world.sqlite");
    const seededState = loadGreekWorldState();
    const projectionReducers = createWorldProjectionReducers(seededState);
    const store = openStore(storePath, projectionReducers);

    const currencyBefore = totalAcrossActors(seededState, "currency");
    const woodBefore = totalAcrossActors(seededState, "wood");
    const foodBefore = totalAcrossActors(seededState, "food");

    let gatheredWood = 0;
    let gatheredFood = 0;
    let consumedFood = 0;
    let tradedCount = 0;
    let producedEventCount = 0;
    let woodConsumedByRecipe = 0;
    const producedByResource: Record<string, number> = {};

    let state = seededState;
    let prng = createPrng(7);
    const recipes = seededState.recipes;
    const routineActorIds = [...state.actors.entries()]
      .filter(([, actor]) => actor.drives !== undefined)
      .map(([id]) => id);

    for (let tick = 1; tick <= 15; tick++) {
      const proposals: Proposal[] = [];
      for (const actorId of routineActorIds) {
        const decision = decideRoutineProposal(state, actorId);
        if (decision) proposals.push(decision.proposal);
      }

      const result = runTick(state, prng, proposals);
      for (const record of result.committed) {
        for (const event of record.events) {
          if (event.kind === "resource-gathered" && event.resource === "wood") {
            gatheredWood += event.amount;
          }
          if (event.kind === "resource-gathered" && event.resource === "food") {
            gatheredFood += event.amount;
          }
          if (event.kind === "resource-consumed" && event.resource === "food") {
            consumedFood += event.amount;
          }
          if (event.kind === "resource-traded") {
            tradedCount += 1;
          }
          if (event.kind === "resource-produced") {
            producedEventCount += 1;
            const recipe = recipes[event.output];
            if (recipe) {
              for (const output of recipe.outputs) {
                producedByResource[output.resource] =
                  (producedByResource[output.resource] ?? 0) +
                  output.amount * event.quantity;
              }
              for (const input of recipe.inputs) {
                if (input.resource === "wood") {
                  woodConsumedByRecipe += input.amount * event.quantity;
                }
              }
            }
          }
        }
      }

      commitTick(store, projectionReducers, {
        events: result.committed.flatMap((record) => record.events),
        cursorWallMs: tick * 1_000,
        paused: false,
        tick: result.state.tick,
        simTimeMs: result.state.simTime,
        prngState: serializePrngState(result.prng),
      });

      state = result.state;
      prng = result.prng;
    }

    // Progress happened: routines did not stall degenerately.
    expect(gatheredWood).toBeGreaterThan(0);
    expect(gatheredFood).toBeGreaterThan(0);
    expect(tradedCount).toBeGreaterThan(0);
    // The authored woodcutter actually produces during a normal run.
    expect(producedEventCount).toBeGreaterThan(0);

    // Currency only ever moves between actors in this content pack (no
    // gather, produce, or consume proposal ever names it); the total is
    // exactly conserved regardless of how many trades committed.
    expect(totalAcrossActors(state, "currency")).toBe(currencyBefore);
    // Wood is conserved except at its declared source (gather) and its
    // declared conversion into planks (the recipe's input side).
    expect(totalAcrossActors(state, "wood")).toBe(
      woodBefore + gatheredWood - woodConsumedByRecipe,
    );
    // Food is conserved except at its declared source (gather) and sink
    // (consume).
    expect(totalAcrossActors(state, "food")).toBe(
      foodBefore + gatheredFood - consumedFood,
    );
    // Planks exist only through the declared recipe conversion; trading
    // them between actors never changes the total the world holds.
    expect(totalAcrossActors(state, "planks")).toBe(
      producedByResource.planks ?? 0,
    );

    closeStore(store);

    // Fresh composition root: reopen with reducers built from
    // `loadGreekWorldState()` again, holding no reference to `state`.
    const freshReducers = createWorldProjectionReducers(loadGreekWorldState());
    const reopened = openStore(storePath, freshReducers);

    const live = restoreWorldTime(
      readLiveProjections(reopened, freshReducers),
      readClock(reopened.db),
    );
    const rebuilt = restoreWorldTime(
      rebuildProjections(reopened, freshReducers),
      readClock(reopened.db),
    );
    expect(live).toEqual(state);
    expect(rebuilt).toEqual(state);

    closeStore(reopened);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
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
