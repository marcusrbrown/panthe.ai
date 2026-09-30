// Integration test: the full pipeline through real world rules/reducers
// and a real SQLite store, with the authored Greek content pack -- proves
// packages/world and packages/persistence actually compose, not just that
// each package's own unit tests pass in isolation.

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  causalChain,
  createObservationId,
  type ObservationRecord,
  type Proposal,
  type WorldEvent,
} from "@panthea/contracts";
import {
  closeStore,
  commitTick,
  computeContentHash,
  exportArchive,
  getCurrentSequence,
  getEventRow,
  ImportError,
  importArchive,
  listEvents,
  openStore,
  type ProjectionCodec,
  readClock,
  readLiveProjections,
  readPrngState,
  rebuildProjections,
} from "@panthea/persistence";
import {
  createProposalId,
  ensureTraceSchema,
  followEvent,
  getProposalOutcomeByProposalId,
} from "@panthea/telemetry";
import {
  createPrng,
  DEFAULT_MEMORY_BALANCE,
  decideRoutineProposal,
  effectiveServices,
  getMemories,
  getRelationship,
  getResourceAmount,
  isEventLinked,
  runTick,
  submitProposal,
  toEntityId,
  type WorldState,
  withActor,
} from "@panthea/world";
import { applyOneTick, type QueuedProposal, stepWorldTick } from "./tick";
import {
  createEventSource,
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
    // The move commits at sequence 1; the farmer's two operational, owned
    // buildings (the shop and the tavern) each earn one income-earned
    // event every tick, right after the proposal queue drains.
    const moveEvents1 = tick1.committed.flatMap((record) => record.events);
    expect(moveEvents1.map((event) => event.sequence)).toEqual([1]);
    expect(tick1.events.map((event) => event.sequence)).toEqual([1, 2, 3]);

    const commit1 = commitTick(store, projectionReducers, {
      events: tick1.events,
      cursorWallMs: 1_000,
      paused: false,
      tick: tick1.state.tick,
      simTimeMs: tick1.state.simTime,
      prngState: serializePrngState(tick1.prng),
    });
    expect(commit1.sequence).toBe(3);

    const tick2 = runTick(tick1.state, tick1.prng, [
      moveProposal("wanderer", "town-square", "obs-2"),
    ]);
    expect(tick2.rejected).toEqual([]);
    const moveEvents2 = tick2.committed.flatMap((record) => record.events);
    // Contiguous with tick 1's sequence, not reset to 1 again.
    expect(moveEvents2.map((event) => event.sequence)).toEqual([4]);

    const commit2 = commitTick(store, projectionReducers, {
      events: tick2.events,
      cursorWallMs: 2_000,
      paused: false,
      tick: tick2.state.tick,
      simTimeMs: tick2.state.simTime,
      prngState: serializePrngState(tick2.prng),
    });
    expect(commit2.sequence).toBe(6);
    expect(tick2.state.tick).toBe(2);
    expect(tick2.state.simTime).toBe(2_000);
    expect(tick2.state.lastSequence).toBe(6);

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
    const moveEvents3 = tick3.committed.flatMap((record) => record.events);
    expect(moveEvents3.map((event) => event.sequence)).toEqual([7]);

    const commit3 = commitTick(store, projectionReducers, {
      events: tick3.events,
      cursorWallMs: 3_000,
      paused: false,
      tick: tick3.state.tick,
      simTimeMs: tick3.state.simTime,
      prngState: serializePrngState(tick3.prng),
    });
    expect(commit3.sequence).toBe(9);

    // --- 4. Export -> importArchive (world codec) -> reopen -> equal ------
    const exportPath = join(exportDir, "archive.sqlite");
    const manifest = exportArchive(store, exportPath);
    expect(manifest.eventSequence).toBe(9);

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
    expect(commit4.sequence).toBe(9);
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
      events: tick1.events,
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
      events: tick2.events,
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
    let incomeEarned = 0;
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
      for (const event of result.environmentEvents) {
        if (event.kind === "income-earned") {
          incomeEarned += event.amount;
        }
      }
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
        events: result.events,
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

    // Currency moves between actors via trade (zero-sum, no proposal ever
    // names it) plus one declared source: an operational owned building's
    // per-tick service revenue.
    expect(incomeEarned).toBeGreaterThan(0);
    expect(totalAcrossActors(state, "currency")).toBe(
      currencyBefore + incomeEarned,
    );
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

    // No trade this run ever left an actor holding a negative balance of
    // anything, in the state reopened and decoded from the real store.
    for (const actor of live.actors.values()) {
      for (const amount of actor.inventory.values()) {
        expect(amount).toBeGreaterThanOrEqual(0);
      }
    }

    closeStore(reopened);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

function worshipProposal(actor: string, deity: string): Proposal {
  const submitted = submitProposal({
    schemaVersion: 1,
    actor,
    targets: [deity],
    expectedRevisions: [],
    source: "fixture",
    observationId: "obs-worship",
    kind: "worship",
    deity,
  });
  if (!submitted.ok) {
    throw new Error(
      `test fixture proposal failed to parse: ${submitted.rejection.message}`,
    );
  }
  return submitted.proposal;
}

function gatherProposal(
  actor: string,
  resource: string,
  amount: number,
  observationId: string,
): Proposal {
  const submitted = submitProposal({
    schemaVersion: 1,
    actor,
    targets: [],
    expectedRevisions: [],
    source: "fixture",
    observationId,
    kind: "gather",
    resource,
    amount,
  });
  if (!submitted.ok) {
    throw new Error(
      `test fixture proposal failed to parse: ${submitted.rejection.message}`,
    );
  }
  return submitted.proposal;
}

test("a favor from worship increases gather yield until it expires, and the bonus is conserved", () => {
  const storeDir = tempDir("panthea-sim-favor-");

  try {
    const storePath = join(storeDir, "world.sqlite");
    const seededState = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(seededState);
    const store = openStore(storePath, reducers);

    const woodBefore = totalAcrossActors(seededState, "wood");
    let gatheredWood = 0;
    let prng = createPrng(3);
    let state = seededState;

    function commit(result: ReturnType<typeof runTick>, wallMs: number): void {
      for (const event of result.committed.flatMap((r) => r.events)) {
        if (event.kind === "resource-gathered" && event.resource === "wood") {
          gatheredWood += event.amount;
        }
      }
      commitTick(store, reducers, {
        events: result.events,
        cursorWallMs: wallMs,
        paused: false,
        tick: result.state.tick,
        simTimeMs: result.state.simTime,
        prngState: serializePrngState(result.prng),
      });
      state = result.state;
      prng = result.prng;
    }

    // Tick 1: the woodcutter worships Zeus and is granted a favor.
    let result = runTick(state, prng, [worshipProposal("woodcutter", "zeus")]);
    expect(result.rejected).toEqual([]);
    commit(result, 1_000);
    const favor = state.actors.get(toEntityId("woodcutter"))?.favors?.[0];
    expect(favor).toMatchObject({ source: "zeus", effect: "divine-favor" });
    if (!favor) throw new Error("expected the granted favor");

    // Tick 2: gathering while the favor is active yields the base amount
    // (2, from content) plus its bonus (1).
    result = runTick(state, prng, [
      gatherProposal("woodcutter", "wood", 2, "obs-gather-1"),
    ]);
    expect(result.rejected).toEqual([]);
    const favoredEvent = result.committed[0]?.events[0];
    expect(favoredEvent).toMatchObject({
      kind: "resource-gathered",
      resource: "wood",
      amount: 3,
    });
    commit(result, 2_000);

    // Advance empty ticks until the favor expires.
    while (state.tick < favor.expiresAtTick) {
      result = runTick(state, prng, []);
      commit(result, (state.tick + 1) * 1_000);
    }

    // Gathering after expiry yields the base amount only.
    result = runTick(state, prng, [
      gatherProposal("woodcutter", "wood", 2, "obs-gather-2"),
    ]);
    expect(result.rejected).toEqual([]);
    const unfavoredEvent = result.committed[0]?.events[0];
    expect(unfavoredEvent).toMatchObject({
      kind: "resource-gathered",
      resource: "wood",
      amount: 2,
    });
    commit(result, (state.tick + 1) * 1_000);

    // The favor's bonus is a declared source, summed like any other gather:
    // the total wood held is exactly what every resource-gathered event
    // this test committed says it is.
    expect(totalAcrossActors(state, "wood")).toBe(woodBefore + gatheredWood);

    closeStore(store);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

function strikeProposal(target: string, power: number): Proposal {
  const submitted = submitProposal({
    schemaVersion: 1,
    actor: "zeus",
    targets: [target],
    expectedRevisions: [],
    source: "fixture",
    observationId: "obs-strike",
    kind: "strike",
    target,
    power,
  });
  if (!submitted.ok) {
    throw new Error(
      `test fixture proposal failed to parse: ${submitted.rejection.message}`,
    );
  }
  return submitted.proposal;
}

test("a strike ignites the tavern; it burns, stops services and income, and a motivated repair restores it -- mid-fire reopen/rebuild and export/import agree", () => {
  const storeDir = tempDir("panthea-sim-fire-");
  const exportDir = tempDir("panthea-sim-fire-export-");
  const slotsDir = tempDir("panthea-sim-fire-slots-");

  try {
    const storePath = join(storeDir, "world.sqlite");
    const seededState = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(seededState);
    let store = openStore(storePath, reducers);

    // --- Tick 1: Zeus strikes the tavern with enough power to ignite it.
    const prng = createPrng(11);
    let result = runTick(seededState, prng, [strikeProposal("the-tavern", 3)]);
    expect(result.rejected).toEqual([]);
    const tavernAfterStrike = result.state.buildings.get(
      toEntityId("the-tavern"),
    );
    if (!tavernAfterStrike) throw new Error("expected the tavern building");
    // Ignition and its first burn tick both happen this same tick: the
    // environment step runs right after the proposal that caused it.
    expect(tavernAfterStrike).toMatchObject({
      status: "burning",
      fireIntensity: 1,
      ticksBurning: 1,
    });
    expect(effectiveServices(tavernAfterStrike)).toEqual([]);
    // Income stopped the very tick it started burning; the stone shop,
    // unaffected, still earns its owner income.
    const incomeThisTick = result.environmentEvents.filter(
      (event) => event.kind === "income-earned",
    );
    expect(
      incomeThisTick.some(
        (event) => "buildingId" in event && event.buildingId === "the-tavern",
      ),
    ).toBe(false);
    expect(
      incomeThisTick.some(
        (event) => "buildingId" in event && event.buildingId === "agora-shop",
      ),
    ).toBe(true);

    commitTick(store, reducers, {
      events: result.events,
      cursorWallMs: 1_000,
      paused: false,
      tick: result.state.tick,
      simTimeMs: result.state.simTime,
      prngState: serializePrngState(result.prng),
    });

    // --- Mid-fire reopen/rebuild equality ------------------------------
    closeStore(store);
    store = openStore(storePath, reducers);
    const midFireLive = restoreWorldTime(
      readLiveProjections(store, reducers),
      readClock(store.db),
    );
    const midFireRebuilt = restoreWorldTime(
      rebuildProjections(store, reducers),
      readClock(store.db),
    );
    expect(midFireLive).toEqual(result.state);
    expect(midFireRebuilt).toEqual(result.state);

    // --- Export -> import at this mid-fire point: continuing from either
    //     the original store's state or a freshly imported copy, with the
    //     same PRNG and the same (empty) proposal queue, produces the same
    //     fire outcome.
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
      reducers,
    );
    const importedState = restoreWorldTime(
      readLiveProjections(importedStore, reducers),
      readClock(importedStore.db),
    );
    const importedPrng =
      deserializePrngState(readPrngState(importedStore.db)) ?? createPrng(0);

    const continuedFromOriginal = runTick(result.state, result.prng, []);
    const continuedFromImported = runTick(importedState, importedPrng, []);
    expect(continuedFromImported.state).toEqual(continuedFromOriginal.state);
    expect(continuedFromImported.events).toEqual(continuedFromOriginal.events);
    closeStore(importedStore);

    // --- Continue in the original store: the burn crosses the destroy
    //     threshold, the building is destroyed, its inventory disposed,
    //     and it exposes no services.
    result = continuedFromOriginal;
    commitTick(store, reducers, {
      events: result.events,
      cursorWallMs: 2_000,
      paused: false,
      tick: result.state.tick,
      simTimeMs: result.state.simTime,
      prngState: serializePrngState(result.prng),
    });

    result = runTick(result.state, result.prng, []);
    commitTick(store, reducers, {
      events: result.events,
      cursorWallMs: 3_000,
      paused: false,
      tick: result.state.tick,
      simTimeMs: result.state.simTime,
      prngState: serializePrngState(result.prng),
    });
    const tavernDestroyed = result.state.buildings.get(
      toEntityId("the-tavern"),
    );
    if (!tavernDestroyed) throw new Error("expected the tavern building");
    expect(tavernDestroyed.status).toBe("destroyed");
    expect(tavernDestroyed.inventory.size).toBe(0);
    expect(effectiveServices(tavernDestroyed)).toEqual([]);

    // --- Motivated repair: the real economy (the woodcutter gathering,
    //     producing, and selling planks; the farmer buying them) is the
    //     only source of the farmer's planks. Once it holds enough, its
    //     own routine proposes repair over any other choice.
    let tick = 3;
    let repaired = false;
    while (tick < 100 && !repaired) {
      tick += 1;
      const proposals: Proposal[] = [];
      for (const actorId of ["woodcutter", "farmer"] as const) {
        const decision = decideRoutineProposal(
          result.state,
          toEntityId(actorId),
        );
        if (decision) proposals.push(decision.proposal);
      }
      result = runTick(result.state, result.prng, proposals);
      commitTick(store, reducers, {
        events: result.events,
        cursorWallMs: tick * 1_000,
        paused: false,
        tick: result.state.tick,
        simTimeMs: result.state.simTime,
        prngState: serializePrngState(result.prng),
      });
      repaired =
        result.state.buildings.get(toEntityId("the-tavern"))?.status ===
        "operational";
    }

    expect(repaired).toBe(true);
    const tavernRepaired = result.state.buildings.get(toEntityId("the-tavern"));
    if (!tavernRepaired) throw new Error("expected the tavern building");
    expect(tavernRepaired.repairProgress).toBeUndefined();
    expect(effectiveServices(tavernRepaired)).toEqual(["drink"]);

    // Reopen once more from a fresh composition root: the fully repaired
    // state survives, proposal-free.
    closeStore(store);
    const freshReducers = createWorldProjectionReducers(loadGreekWorldState());
    const reopened = openStore(storePath, freshReducers);
    const finalLive = restoreWorldTime(
      readLiveProjections(reopened, freshReducers),
      readClock(reopened.db),
    );
    expect(finalLive).toEqual(result.state);
    closeStore(reopened);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(exportDir, { recursive: true, force: true });
    rmSync(slotsDir, { recursive: true, force: true });
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

test("two tellings from one observation, one event-linked and one unlinked, survive a close and reopen with their ids, assertions, and link, and a projection rebuild; neither carries a truth flag", () => {
  const storeDir = tempDir("panthea-sim-legends-reopen-");
  try {
    const storePath = join(storeDir, "world.sqlite");
    const seededState = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(seededState);
    let store = openStore(storePath, reducers);

    const telling = (assertion: string, linkedEventId?: string): Proposal => {
      const submitted = submitProposal({
        schemaVersion: 1,
        actor: "farmer",
        targets: [],
        expectedRevisions: [],
        source: "fixture",
        // Both tellings cite the same, unchanged observation.
        observationId: "obs-one-observation",
        kind: "legend",
        assertion,
        ...(linkedEventId ? { linkedEventId } : {}),
      });
      if (!submitted.ok) throw new Error(submitted.rejection.message);
      return submitted.proposal;
    };

    // Tick 1 commits a real event to cite; tick 2 and 3 tell the two legends.
    let state = seededState;
    let prng = createPrng(5);
    const commit = (proposals: Proposal[], wallMs: number) => {
      const result = runTick(state, prng, proposals);
      commitTick(store, reducers, {
        events: result.events,
        cursorWallMs: wallMs,
        paused: false,
        tick: result.state.tick,
        simTimeMs: result.state.simTime,
        prngState: serializePrngState(result.prng),
      });
      state = result.state;
      prng = result.prng;
      return result;
    };
    const first = commit([moveProposal("farmer", "tavern", "obs-move")], 1_000);
    const citedEventId = first.events[0]?.id;
    if (!citedEventId) throw new Error("expected a committed event to cite");
    commit([telling("the farmer walked to the tavern", citedEventId)], 2_000);
    commit([telling("the gods were angry that night")], 3_000);

    const expectedLegends = [...state.legends.values()];
    expect(expectedLegends).toHaveLength(2);

    closeStore(store);
    store = openStore(storePath, reducers);
    const reopened = restoreWorldTime(
      readLiveProjections(store, reducers),
      readClock(store.db),
    );
    const rebuilt = restoreWorldTime(
      rebuildProjections(store, reducers),
      readClock(store.db),
    );

    for (const world of [reopened, rebuilt]) {
      const legends = [...world.legends.values()];
      expect(legends).toEqual(expectedLegends);
      expect(legends.map((legend) => legend.assertion)).toEqual([
        "the farmer walked to the tavern",
        "the gods were angry that night",
      ]);
      expect(legends.map((legend) => legend.linkedEventId)).toEqual([
        citedEventId,
        undefined,
      ]);
      expect(legends.map(isEventLinked)).toEqual([true, false]);
      expect(new Set(legends.map((legend) => legend.id)).size).toBe(2);
      for (const legend of legends) {
        expect(legend).not.toHaveProperty("verified");
      }
    }
    closeStore(store);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test("startup fails with a clear diagnostic when an embedded god profile matches no deity inhabitant", () => {
  const orphan = {
    schemaVersion: 1,
    id: "athena",
    name: "Athena",
    domains: ["wisdom"],
    drives: { order: 0.5 },
    abilities: [
      {
        id: "counsel",
        name: "Counsel",
        action: "legend",
        description: "Speaks counsel.",
      },
    ],
    sources: [
      {
        id: "iliad",
        title: "Iliad",
        author: "Homer",
        edition: "test edition",
      },
    ],
    lore: [
      {
        id: "wise",
        statement: "Athena counsels heroes.",
        cites: [{ source: "iliad", locator: "book 1" }],
      },
    ],
    sprite: "placeholder-athena",
  };
  expect(() =>
    loadGreekWorldState([{ label: "athena.json", value: orphan }]),
  ).toThrow("failed to parse the embedded Greek god profiles");
  expect(() =>
    loadGreekWorldState([{ label: "athena.json", value: orphan }]),
  ).toThrow("athena.json.id");
});

test("startup succeeds with the embedded god profiles by default", () => {
  expect(() => loadGreekWorldState()).not.toThrow();
});

// --- Memory, beliefs, and relationships through the real store ----------------------

const id = toEntityId;

/**
 * The Greek world with the story's cast in place: Zeus and a bard at the
 * tavern (the tavern is the farmer's), Hera in the square. None of them has
 * drives, so nothing acts unless a test queues it.
 */
function socialSeed(memoryBalance?: Record<string, number>): WorldState {
  const greek = loadGreekWorldState();
  const zeus = greek.actors.get(id("zeus"));
  const hera = greek.actors.get(id("hera"));
  if (!zeus || !hera) throw new Error("expected Zeus and Hera in the pack");
  const placed = withActor(
    withActor(greek, { ...zeus, locationId: id("tavern") }),
    { ...hera, locationId: id("town-square") },
  );
  const seeded = withActor(placed, {
    id: id("bard"),
    locationId: id("tavern"),
    alive: true,
    capabilities: [],
    inventory: new Map(),
    revision: 0,
  });
  return memoryBalance === undefined
    ? seeded
    : {
        ...seeded,
        rules: {
          ...seeded.rules,
          memoryBalance: { ...DEFAULT_MEMORY_BALANCE, ...memoryBalance },
        },
      };
}

function queuedProposal(
  actor: string,
  raw: Record<string, unknown>,
): QueuedProposal {
  const observation: ObservationRecord = {
    schemaVersion: 1,
    id: createObservationId(),
    observer: id(actor),
    stateRevision: 0,
    factsRead: [],
    source: "fixture",
  };
  const submitted = submitProposal({
    schemaVersion: 1,
    actor,
    targets: [],
    expectedRevisions: [],
    source: "fixture",
    observationId: observation.id,
    ...raw,
  });
  if (!submitted.ok) {
    throw new Error(`fixture proposal failed: ${submitted.rejection.message}`);
  }
  return { id: createProposalId(), proposal: submitted.proposal, observation };
}

/** A live world over a real store and trace: each `run` is one committed tick. */
function liveWorld(storePath: string, seed: WorldState) {
  const reducers = createWorldProjectionReducers(seed);
  const store = openStore(storePath, reducers);
  ensureTraceSchema(store.db);
  let state = seed;
  let prng = createPrng(1);
  let wallMs = 0;
  return {
    store,
    reducers,
    get state() {
      return state;
    },
    run(...queue: QueuedProposal[]) {
      wallMs += 1_000;
      const step = applyOneTick(
        state,
        prng,
        queue,
        { store, reducers, traceDb: store.db },
        { cursorWallMs: wallMs, paused: false },
      );
      if (step.kind !== "committed") {
        throw new Error(`tick did not commit: ${step.message}`);
      }
      state = step.state;
      prng = step.prng;
      return step;
    },
  };
}

function eventOfKindAll<K extends WorldEvent["kind"]>(
  events: readonly WorldEvent[],
  kind: K,
): Extract<WorldEvent, { kind: K }>[] {
  return events.filter(
    (event): event is Extract<WorldEvent, { kind: K }> => event.kind === kind,
  );
}

function eventOfKind<K extends WorldEvent["kind"]>(
  events: readonly WorldEvent[],
  kind: K,
  predicate: (event: Extract<WorldEvent, { kind: K }>) => boolean = () => true,
): Extract<WorldEvent, { kind: K }> {
  const found = events.find(
    (event): event is Extract<WorldEvent, { kind: K }> =>
      event.kind === kind &&
      predicate(event as Extract<WorldEvent, { kind: K }>),
  );
  if (!found) throw new Error(`expected a ${kind} event`);
  return found;
}

test("a witnessed strike, a report, and a relationship change survive reopen, rebuild, and archive import; the restored branch explains the change from its events, with no trace rows", () => {
  const storeDir = tempDir("panthea-sim-social-");
  const exportDir = tempDir("panthea-sim-social-export-");
  const slotsDir = tempDir("panthea-sim-social-slots-");
  try {
    const storePath = join(storeDir, "world.sqlite");
    const seed = socialSeed();
    const world = liveWorld(storePath, seed);

    // Zeus strikes the tavern with the bard beside him; the bard walks to the
    // square and tells Hera something that is not what happened.
    const strike = queuedProposal("zeus", {
      kind: "strike",
      target: "the-tavern",
      power: 3,
    });
    world.run(strike);
    const ignition = eventOfKind(
      listEvents(world.store.db),
      "building-ignited",
    );
    world.run(queuedProposal("bard", { kind: "move", to: "town-square" }));
    const told = "Zeus burned down the whole agora";
    const report = queuedProposal("bard", {
      kind: "report",
      listener: "hera",
      content: told,
      linkedEventId: ignition.id,
    });
    world.run(report);
    const state = world.state;

    // What the world holds. (The fire also spread to the oak in the square,
    // which the bard and Hera saw, so each remembers more than the tavern.)
    expect(getMemories(state, id("bard"))).toContainEqual(
      expect.objectContaining({
        kind: "witnessed",
        sourceEventId: ignition.id,
      }),
    );
    const belief = getMemories(state, id("hera")).find(
      (memory) => memory.kind === "told",
    );
    expect(belief).toMatchObject({
      kind: "told",
      teller: "bard",
      content: told,
      linkedEventId: ignition.id,
    });
    const changes = eventOfKindAll(
      listEvents(world.store.db),
      "relationship-changed",
    );
    const fromBelief = changes.filter(
      (event) => event.memoryEventId === belief?.id,
    );
    expect(fromBelief).toMatchObject([
      { entityId: "hera", toward: "zeus", affinityDelta: -1, grudgeDelta: 0 },
    ]);
    const heraTowardZeus = changes
      .filter(
        (event) => event.entityId === id("hera") && event.toward === id("zeus"),
      )
      .reduce((sum, event) => sum + event.affinityDelta, 0);
    expect(getRelationship(state, id("hera"), id("zeus"))?.affinity).toBe(
      heraTowardZeus,
    );
    // The woodcutter, in the square all along, saw the oak catch but was told nothing and never saw the tavern.
    expect(
      getMemories(state, id("woodcutter")).map((m) => m.kind),
    ).not.toContain("told");
    expect(
      getMemories(state, id("woodcutter")).some(
        (memory) => memory.sourceEventId === ignition.id,
      ),
    ).toBe(false);

    // Live equals reopened equals rebuilt.
    closeStore(world.store);
    const freshReducers = createWorldProjectionReducers(socialSeed());
    const reopened = openStore(storePath, freshReducers);
    const clock = readClock(reopened.db);
    expect(
      restoreWorldTime(readLiveProjections(reopened, freshReducers), clock),
    ).toEqual(state);
    expect(
      restoreWorldTime(rebuildProjections(reopened, freshReducers), clock),
    ).toEqual(state);

    // Export, import into a new slot: the branch holds the same memories and relationships.
    const exportPath = join(exportDir, "archive.sqlite");
    exportArchive(reopened, exportPath);
    const validating: ProjectionCodec<unknown> = {
      encode: (value) => value,
      decode: (value) => worldProjectionCodec.decode(value),
    };
    const imported = importArchive(exportPath, slotsDir, validating);
    const branch = openStore(
      join(imported.slotPath, "world.sqlite"),
      freshReducers,
    );
    const branchClock = readClock(branch.db);
    const restored = restoreWorldTime(
      readLiveProjections(branch, freshReducers),
      branchClock,
    );
    expect(restored.memories).toEqual(state.memories);
    expect(restored.relationships).toEqual(state.relationships);
    expect(
      restoreWorldTime(rebuildProjections(branch, freshReducers), branchClock),
    ).toEqual(state);

    // The branch has no trace, and still explains why Hera distrusts Zeus.
    ensureTraceSchema(branch.db);
    expect(
      getProposalOutcomeByProposalId(branch.db, report.id),
    ).toBeUndefined();
    expect(
      getProposalOutcomeByProposalId(branch.db, strike.id),
    ).toBeUndefined();
    const events = listEvents(branch.db);
    const change = eventOfKind(
      events,
      "relationship-changed",
      (event) => event.memoryEventId === belief?.id,
    );
    const chain = causalChain(
      (eventId) => getEventRow(branch.db, eventId),
      change.id,
    );
    expect(chain.map((event) => event.kind)).toEqual([
      "building-ignited",
      "report-told",
      "memory-recorded",
      "relationship-changed",
    ]);
    expect(eventOfKind(chain, "report-told")).toMatchObject({
      entityId: "bard",
      listenerId: "hera",
      content: told,
    });
    // The memory the restored state carries names the same events the chain does.
    expect(
      getMemories(restored, id("hera")).find(
        (memory) => memory.id === change.memoryEventId,
      ),
    ).toMatchObject({
      id: change.memoryEventId,
      sourceEventId: eventOfKind(chain, "report-told").id,
      linkedEventId: ignition.id,
    });
    const followed = followEvent(
      branch.db,
      createEventSource(branch),
      change.id,
    );
    expect(followed.found).toBe(true);
    expect(
      followed.steps.every(
        (step) => step.step === "event" || step.step === "projection-change",
      ),
    ).toBe(true);

    // Control: on the live world, where the trace exists, the same chain reaches the strike's proposal.
    const liveTrace = openStore(storePath, freshReducers);
    const liveFollow = followEvent(
      liveTrace.db,
      createEventSource(liveTrace),
      change.id,
    );
    expect(
      liveFollow.steps.filter((step) => step.step === "proposal"),
    ).toHaveLength(2);
    closeStore(liveTrace);

    closeStore(branch);
    closeStore(reopened);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(exportDir, { recursive: true, force: true });
    rmSync(slotsDir, { recursive: true, force: true });
  }
});

test("live equals rebuild through the store when the world forgets: the same memory is evicted either way", () => {
  const storeDir = tempDir("panthea-sim-evict-");
  try {
    const storePath = join(storeDir, "world.sqlite");
    const world = liveWorld(storePath, socialSeed({ capacity: 1 }));
    world.run(
      queuedProposal("zeus", {
        kind: "strike",
        target: "the-tavern",
        power: 3,
      }),
    );
    for (let index = 0; index < 3; index += 1) world.run();

    const recorded = listEvents(world.store.db).filter(
      (event) => event.kind === "memory-recorded" && event.entityId === "zeus",
    );
    // Zeus saw the tavern ignite and then burn down; with room for one memory he keeps the worse.
    expect(
      recorded.map((event) => (event as { eventKind: string }).eventKind),
    ).toEqual(["building-ignited", "building-destroyed"]);
    expect(getMemories(world.state, id("zeus"))).toMatchObject([
      { kind: "witnessed", eventKind: "building-destroyed" },
    ]);

    const clock = readClock(world.store.db);
    expect(
      restoreWorldTime(readLiveProjections(world.store, world.reducers), clock),
    ).toEqual(world.state);
    expect(
      restoreWorldTime(rebuildProjections(world.store, world.reducers), clock),
    ).toEqual(world.state);
    closeStore(world.store);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test("a tick's memories and relationship changes commit with the events they cite, or not at all", () => {
  const storeDir = tempDir("panthea-sim-atomic-");
  try {
    const seed = socialSeed();
    const reducers = createWorldProjectionReducers(seed);
    const store = openStore(join(storeDir, "world.sqlite"), reducers);
    // No trace tables yet: the tick's trace write will fail inside its transaction.

    const strike = queuedProposal("zeus", {
      kind: "strike",
      target: "the-tavern",
      power: 3,
    });
    const deps = { store, reducers, traceDb: store.db };

    // The tick does derive memories and feelings, or rolling them back proves nothing.
    const planned = stepWorldTick(seed, createPrng(1), [strike]).result;
    expect(
      planned.derivedEvents.some((e) => e.kind === "memory-recorded"),
    ).toBe(true);
    expect(
      planned.derivedEvents.some((e) => e.kind === "relationship-changed"),
    ).toBe(true);

    const failed = applyOneTick(seed, createPrng(1), [strike], deps, {
      cursorWallMs: 1_000,
      paused: false,
    });
    expect(failed.kind).toBe("store-error");
    expect(listEvents(store.db)).toEqual([]);
    expect(getCurrentSequence(store.db)).toBe(0);
    const afterFailure = readLiveProjections(store, reducers);
    expect(afterFailure.memories.size).toBe(0);
    expect(afterFailure.relationships.size).toBe(0);
    expect(afterFailure.buildings.get(id("the-tavern"))?.status).toBe(
      "operational",
    );

    // Control: with the trace in place, the same tick commits the strike, its memories, and the changes together.
    ensureTraceSchema(store.db);
    const committed = applyOneTick(seed, createPrng(1), [strike], deps, {
      cursorWallMs: 1_000,
      paused: false,
    });
    expect(committed.kind).toBe("committed");
    const events = listEvents(store.db);
    expect(events.map((event) => event.sequence)).toEqual(
      events.map((_, index) => index + 1),
    );
    const kinds = events.map((event) => event.kind);
    expect(kinds.indexOf("building-ignited")).toBeLessThan(
      kinds.indexOf("memory-recorded"),
    );
    expect(kinds.indexOf("memory-recorded")).toBeLessThan(
      kinds.indexOf("relationship-changed"),
    );
    const live = readLiveProjections(store, reducers);
    expect(getMemories(live, id("zeus"))).toHaveLength(1);
    expect(getMemories(live, id("bard"))).toHaveLength(1);
    // Every memory event in the log is in the projection, by the event's own id.
    for (const event of events) {
      if (event.kind !== "memory-recorded") continue;
      expect(
        getMemories(live, event.entityId).some(
          (memory) => memory.id === event.id,
        ),
      ).toBe(true);
    }
    closeStore(store);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});
