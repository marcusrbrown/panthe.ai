import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createObservationId,
  type EventId,
  type ObservationRecord,
  type Proposal,
} from "@panthea/contracts";
import {
  closeStore,
  openStore,
  readClock,
  readLiveProjections,
} from "@panthea/persistence";
import {
  createProposalId,
  ensureTraceSchema,
  followEvent,
  getObservation,
  getProposalOutcomeByProposalId,
  type ProposalId,
} from "@panthea/telemetry";
import { createPrng, submitProposal, toEntityId } from "@panthea/world";
import {
  applyOneTick,
  buildRoutineQueue,
  checkLegendIntake,
  intakeProposal,
  type QueuedProposal,
  stepWorldTick,
} from "./tick";
import {
  createEventSource,
  createWorldProjectionReducers,
  loadGreekWorldState,
  restoreWorldTime,
} from "./world-store";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function manualProposal(
  actor: string,
  raw: Record<string, unknown>,
): QueuedProposal {
  const observation: ObservationRecord = {
    schemaVersion: 1,
    id: createObservationId(),
    observer: toEntityId(actor),
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
    throw new Error(
      `test fixture proposal failed to parse: ${submitted.rejection.message}`,
    );
  }
  return {
    id: createProposalId(),
    proposal: submitted.proposal,
    observation,
  };
}

test("buildRoutineQueue produces one proposal per drive-bearing living actor, none for others", () => {
  const state = loadGreekWorldState();
  const queue = buildRoutineQueue(state);
  const driveBearing = [...state.actors.values()].filter(
    (actor) => actor.drives !== undefined,
  );
  expect(queue.length).toBe(driveBearing.length);
  expect(queue.length).toBeGreaterThan(0);
});

test("stepWorldTick admits up to the cap and reports the rest as overflow, in order", () => {
  const state = loadGreekWorldState();
  const prng = createPrng(1);
  const queue = buildRoutineQueue(state);
  expect(queue.length).toBeGreaterThan(1);

  const outcome = stepWorldTick(state, prng, queue, { maxProposalsPerTick: 1 });
  expect(outcome.admitted).toHaveLength(1);
  expect(outcome.admitted[0]).toBe(queue[0]);
  expect(outcome.overflow).toHaveLength(queue.length - 1);
  expect(outcome.overflow).toEqual(queue.slice(1));
});

test("applyOneTick commits events, projections, clock, and PRNG in one transaction and records trace observations and outcomes for accepted and rejected proposals", () => {
  const storeDir = tempDir("panthea-sim-tick-");
  try {
    const storePath = join(storeDir, "world.sqlite");
    const seeded = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(seeded);
    const store = openStore(storePath, reducers);
    ensureTraceSchema(store.db);

    const prng = createPrng(1);
    const queue = buildRoutineQueue(seeded);
    const step = applyOneTick(
      seeded,
      prng,
      queue,
      { store, reducers, traceDb: store.db },
      {
        cursorWallMs: 1_000,
        paused: false,
      },
    );

    expect(step.kind).toBe("committed");
    if (step.kind !== "committed") throw new Error("expected a committed step");
    expect(step.state.tick).toBe(1);
    expect(step.state.simTime).toBe(1_000);

    const live = restoreWorldTime(
      readLiveProjections(store, reducers),
      readClock(store.db),
    );
    expect(live).toEqual(step.state);

    for (const queued of queue) {
      const observation = getObservation(store.db, queued.observation.id);
      expect(observation?.record).toEqual(queued.observation);
      const outcome = getProposalOutcomeByProposalId(store.db, queued.id);
      if (!outcome) throw new Error("expected a recorded proposal outcome");
      expect(["committed", "rejected"]).toContain(outcome.outcome);
    }

    closeStore(store);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test("a store write failure reports store-error and commits nothing (no trace rows either)", () => {
  const storeDir = tempDir("panthea-sim-tick-degraded-");
  try {
    const storePath = join(storeDir, "world.sqlite");
    const seeded = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(seeded);
    const store = openStore(storePath, reducers);
    ensureTraceSchema(store.db);

    const prng = createPrng(1);
    const queue = buildRoutineQueue(seeded);
    const step = applyOneTick(
      seeded,
      prng,
      queue,
      {
        store,
        reducers,
        traceDb: store.db,
        commitTick: () => {
          throw new Error("disk I/O error: SQLITE_FULL");
        },
      },
      { cursorWallMs: 1_000, paused: false },
    );

    expect(step).toEqual({
      kind: "store-error",
      reason: "disk-full",
      message: expect.stringContaining("SQLITE_FULL"),
    });

    // Nothing partially committed: the store's live state is unchanged.
    const live = restoreWorldTime(
      readLiveProjections(store, reducers),
      readClock(store.db),
    );
    expect(live.tick).toBe(0);
    for (const queued of queue) {
      expect(getObservation(store.db, queued.observation.id)).toBeUndefined();
      expect(
        getProposalOutcomeByProposalId(store.db, queued.id),
      ).toBeUndefined();
    }

    closeStore(store);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test("proposals beyond the per-tick cap are rejected as over-limit before reaching the world engine", () => {
  const storeDir = tempDir("panthea-sim-tick-cap-");
  try {
    const storePath = join(storeDir, "world.sqlite");
    const seeded = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(seeded);
    const store = openStore(storePath, reducers);
    ensureTraceSchema(store.db);

    const queue = buildRoutineQueue(seeded);
    expect(queue.length).toBeGreaterThan(1);

    const step = applyOneTick(
      seeded,
      createPrng(1),
      queue,
      { store, reducers, traceDb: store.db, maxProposalsPerTick: 1 },
      { cursorWallMs: 1_000, paused: false },
    );
    expect(step.kind).toBe("committed");

    const overLimitOutcome = getProposalOutcomeByProposalId(
      store.db,
      queue[1].id,
    );
    expect(overLimitOutcome?.outcome).toBe("rejected");
    expect(overLimitOutcome?.reason).toBe("over-limit");
    // Its observation was still recorded even though it never reached the
    // world engine -- it was made and cited, just capped at intake.
    expect(getObservation(store.db, queue[1].observation.id)).toBeDefined();

    closeStore(store);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test("a legend proposal with an unknown linkedEventId is rejected at intake; one with a committed link is admitted and commits verified", () => {
  const storeDir = tempDir("panthea-sim-legend-");
  try {
    const storePath = join(storeDir, "world.sqlite");
    const seeded = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(seeded);
    const store = openStore(storePath, reducers);
    ensureTraceSchema(store.db);

    // Unknown link: rejected before it ever reaches the queue.
    const unknownLink = intakeProposal(store.db, {
      schemaVersion: 1,
      actor: "farmer",
      targets: [],
      expectedRevisions: [],
      source: "fixture",
      observationId: createObservationId(),
      kind: "legend",
      assertion: "the tavern burned by Zeus's own hand",
      linkedEventId: "evt-nonexistent-1" as EventId,
    });
    expect(unknownLink.ok).toBe(false);
    if (unknownLink.ok) throw new Error("expected rejection");
    expect(unknownLink.rejection.reason).toBe("malformed");

    const legendRejection = checkLegendIntake(store.db, {
      kind: "legend",
      linkedEventId: "evt-nonexistent-2" as EventId,
    } as Proposal);
    expect(legendRejection?.reason).toBe("malformed");

    // Commit one real tick first, so there is a real committed event to link to.
    const moveQueued = manualProposal("farmer", {
      kind: "move",
      to: "tavern",
    });
    const tick1 = applyOneTick(
      seeded,
      createPrng(1),
      [moveQueued],
      { store, reducers, traceDb: store.db },
      { cursorWallMs: 1_000, paused: false },
    );
    expect(tick1.kind).toBe("committed");
    if (tick1.kind !== "committed")
      throw new Error("expected a committed tick");

    const committedOutcome = getProposalOutcomeByProposalId(
      store.db,
      moveQueued.id,
    );
    const linkedEventId = committedOutcome?.eventId;
    expect(linkedEventId).toBeDefined();
    if (!linkedEventId) throw new Error("expected a linked event id");

    // Committed link: admitted at intake, and the resulting legend is verified.
    const committedLink = intakeProposal(store.db, {
      schemaVersion: 1,
      actor: "farmer",
      targets: [],
      expectedRevisions: [],
      source: "fixture",
      observationId: createObservationId(),
      kind: "legend",
      assertion: "the tavern burned by Zeus's own hand",
      linkedEventId,
    });
    expect(committedLink.ok).toBe(true);
    if (!committedLink.ok)
      throw new Error("expected the legend to be admitted");

    const legendQueued: QueuedProposal = {
      id: createProposalId(),
      proposal: committedLink.proposal,
      observation: {
        schemaVersion: 1,
        id: committedLink.proposal.observationId,
        observer: toEntityId("farmer"),
        stateRevision: tick1.state.lastSequence,
        factsRead: [],
        source: "fixture",
      },
    };
    const tick2 = applyOneTick(
      tick1.state,
      tick1.prng,
      [legendQueued],
      { store, reducers, traceDb: store.db },
      { cursorWallMs: 2_000, paused: false },
    );
    expect(tick2.kind).toBe("committed");
    if (tick2.kind !== "committed")
      throw new Error("expected a committed tick");

    const legend = [...tick2.state.legends.values()][0];
    expect(legend?.verified).toBe(true);
    expect(legend?.linkedEventId).toBe(linkedEventId);

    closeStore(store);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test("one multi-tick run through the real store and trace: routines act, events commit, and the trace follows a committed event back to its observation", () => {
  const storeDir = tempDir("panthea-sim-trace-");
  try {
    const storePath = join(storeDir, "world.sqlite");
    const seeded = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(seeded);
    const store = openStore(storePath, reducers);
    ensureTraceSchema(store.db);

    let state = seeded;
    let prng = createPrng(3);
    let queue = buildRoutineQueue(state);
    let followableEventId: EventId | undefined;
    let followableProposalId: ProposalId | undefined;

    for (let wallMs = 1_000; wallMs <= 15_000; wallMs += 1_000) {
      const step = applyOneTick(
        state,
        prng,
        queue,
        { store, reducers, traceDb: store.db },
        {
          cursorWallMs: wallMs,
          paused: false,
        },
      );
      expect(step.kind).toBe("committed");
      if (step.kind !== "committed")
        throw new Error("expected a committed tick");

      if (!followableEventId) {
        for (const queued of queue) {
          const outcome = getProposalOutcomeByProposalId(store.db, queued.id);
          if (outcome?.outcome === "committed" && outcome.eventId) {
            followableEventId = outcome.eventId;
            followableProposalId = outcome.proposalId;
            break;
          }
        }
      }

      state = step.state;
      prng = step.prng;
      queue = step.nextQueue;
    }

    expect(followableEventId).toBeDefined();
    if (!followableEventId || !followableProposalId) {
      throw new Error(
        "expected at least one committed proposal across 15 ticks",
      );
    }

    const eventSource = createEventSource(store);
    const chain = followEvent(store.db, eventSource, followableEventId);
    expect(chain.found).toBe(true);
    const stepKinds = chain.steps.map((entry) => entry.step);
    expect(stepKinds[0]).toBe("observation");
    expect(stepKinds).toContain("proposal");
    expect(stepKinds).toContain("validation");
    expect(stepKinds).toContain("event");
    expect(stepKinds).toContain("projection-change");

    const observationStep = chain.steps.find(
      (entry) => entry.step === "observation",
    );
    if (observationStep?.step !== "observation")
      throw new Error("expected an observation step");
    const outcome = getProposalOutcomeByProposalId(
      store.db,
      followableProposalId,
    );
    if (!outcome) throw new Error("expected a recorded proposal outcome");
    expect(observationStep.record.id).toBe(outcome.observationId);

    closeStore(store);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test("measurement: JSON projection commit cost per tick, authored Greek world vs. a 10x-scaled world", () => {
  function measureTicks(
    state: ReturnType<typeof loadGreekWorldState>,
    label: string,
  ): number {
    const storeDir = tempDir(`panthea-sim-perf-${label}-`);
    try {
      const storePath = join(storeDir, "world.sqlite");
      const reducers = createWorldProjectionReducers(state);
      const store = openStore(storePath, reducers);
      ensureTraceSchema(store.db);

      let working = state;
      let prng = createPrng(5);
      let queue = buildRoutineQueue(working);
      const durationsMs: number[] = [];

      for (let wallMs = 1_000; wallMs <= 20_000; wallMs += 1_000) {
        const start = performance.now();
        const step = applyOneTick(
          working,
          prng,
          queue,
          { store, reducers, traceDb: store.db },
          {
            cursorWallMs: wallMs,
            paused: false,
          },
        );
        durationsMs.push(performance.now() - start);
        if (step.kind !== "committed")
          throw new Error("expected a committed tick");
        working = step.state;
        prng = step.prng;
        queue = step.nextQueue;
      }

      const maxMs = Math.max(...durationsMs);
      const avgMs =
        durationsMs.reduce((sum, value) => sum + value, 0) / durationsMs.length;
      console.log(
        `[projection-commit] ${label}: avg=${avgMs.toFixed(3)}ms max=${maxMs.toFixed(3)}ms (1 Hz budget: 1000ms)`,
      );
      closeStore(store);
      return maxMs;
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  }

  function scaledWorld(factor: number): ReturnType<typeof loadGreekWorldState> {
    const base = loadGreekWorldState();
    const actors = new Map(base.actors);
    const buildings = new Map(base.buildings);
    const baseActors = [...base.actors.values()];
    const baseBuildings = [...base.buildings.values()];
    for (let copy = 1; copy < factor; copy += 1) {
      for (const actor of baseActors) {
        const id = toEntityId(`${actor.id}-copy-${copy}`);
        actors.set(id, { ...actor, id, revision: 0 });
      }
      for (const building of baseBuildings) {
        const id = toEntityId(`${building.id}-copy-${copy}`);
        buildings.set(id, { ...building, id, revision: 0 });
      }
    }
    return { ...base, actors, buildings };
  }

  const greekMaxMs = measureTicks(loadGreekWorldState(), "greek-authored");
  const scaledMaxMs = measureTicks(scaledWorld(10), "greek-10x");

  // Generous margin under the 1000ms (1 Hz) budget -- these assert the
  // measurement stays well clear of the budget, not a tight benchmark.
  expect(greekMaxMs).toBeLessThan(500);
  expect(scaledMaxMs).toBeLessThan(500);
});
