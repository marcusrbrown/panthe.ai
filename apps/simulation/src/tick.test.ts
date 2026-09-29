import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createObservationId,
  createSessionId,
  type EventId,
  type ObservationRecord,
  type Proposal,
} from "@panthea/contracts";
import {
  closeStore,
  getCurrentSequence,
  listEvents,
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
  recordReceipt,
} from "@panthea/telemetry";
import {
  createPrng,
  isEventLinked,
  submitProposal,
  toEntityId,
} from "@panthea/world";
import {
  applyOneTick,
  buildRoutineQueue,
  checkLegendIntake,
  intakeProposal,
  mergeTickQueue,
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

  const queuedActorIds = queue.map((queued) => queued.proposal.actor).sort();
  const driveBearingIds = driveBearing.map((actor) => actor.id).sort();
  expect(queuedActorIds).toEqual(driveBearingIds);

  const noDrivesIds = [...state.actors.values()]
    .filter((actor) => actor.drives === undefined)
    .map((actor) => actor.id);
  expect(noDrivesIds.length).toBeGreaterThan(0);
  for (const id of noDrivesIds) {
    expect(queuedActorIds).not.toContain(id);
  }
});

test("stepWorldTick admits up to the cap from the world's own authored rules and reports the rest as overflow, in order", () => {
  const state = loadGreekWorldState();
  const prng = createPrng(1);
  const queue = buildRoutineQueue(state);
  expect(queue.length).toBeGreaterThan(1);

  const cappedState = {
    ...state,
    rules: { ...state.rules, maxProposalsPerTick: 1 },
  };
  const outcome = stepWorldTick(cappedState, prng, queue);
  expect(outcome.admitted).toHaveLength(1);
  expect(outcome.admitted[0]).toBe(queue[0]);
  expect(outcome.overflow).toHaveLength(queue.length - 1);
  expect(outcome.overflow).toEqual(queue.slice(1));

  // The same queue against the world's actual authored cap (well above the
  // queue's size) admits everything -- the cap genuinely comes from
  // configuration, not a hardcoded number.
  expect(state.rules.maxProposalsPerTick).toBeGreaterThan(queue.length);
  const uncappedOutcome = stepWorldTick(state, prng, queue);
  expect(uncappedOutcome.admitted).toHaveLength(queue.length);
  expect(uncappedOutcome.overflow).toHaveLength(0);
});

test("stepWorldTick counts claims against their own cap, so a claim never uses a slot a routine needs and its rejection is never over-limit", () => {
  const state = loadGreekWorldState();
  const routine = buildRoutineQueue(state);
  const [woodcutterRoutine, farmerRoutine] = routine;
  if (!woodcutterRoutine || !farmerRoutine) throw new Error("two routines");
  const claim = manualProposal("woodcutter", {
    kind: "claim",
    assertion: "I own the old oak",
  });
  const secondClaim = manualProposal("farmer", {
    kind: "claim",
    assertion: "I own the shop",
  });
  const cappedState = {
    ...state,
    rules: { ...state.rules, maxProposalsPerTick: 1 },
  };

  const outcome = stepWorldTick(cappedState, createPrng(1), [
    claim,
    secondClaim,
    woodcutterRoutine,
    farmerRoutine,
  ]);

  expect(outcome.admitted).toEqual([claim, woodcutterRoutine]);
  expect(outcome.overflow).toEqual([secondClaim, farmerRoutine]);
  expect(outcome.result.rejected.map((entry) => entry.reason)).toContain(
    "unauthorized-claim",
  );
  expect(outcome.result.committed).toHaveLength(1);
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

test("a trace write failure rolls back the whole tick: clock, sequence, and events are unchanged, and the call does not throw", () => {
  const storeDir = tempDir("panthea-sim-tick-trace-fail-");
  try {
    const storePath = join(storeDir, "world.sqlite");
    const seeded = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(seeded);
    const store = openStore(storePath, reducers);
    // Deliberately not calling ensureTraceSchema: the trace tables don't
    // exist, so a real trace write genuinely fails against this store.

    const beforeClock = readClock(store.db);
    const beforeSequence = getCurrentSequence(store.db);

    const queue = buildRoutineQueue(seeded);
    expect(queue.length).toBeGreaterThan(0);

    let step: ReturnType<typeof applyOneTick> | undefined;
    expect(() => {
      step = applyOneTick(
        seeded,
        createPrng(1),
        queue,
        { store, reducers, traceDb: store.db },
        {
          cursorWallMs: 1_000,
          paused: false,
        },
      );
    }).not.toThrow();

    expect(step?.kind).toBe("store-error");

    expect(readClock(store.db)).toEqual(beforeClock);
    expect(getCurrentSequence(store.db)).toBe(beforeSequence);
    expect(listEvents(store.db)).toEqual([]);

    closeStore(store);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test("proposals beyond the per-tick cap are rejected as over-limit before reaching the world engine, using the world's authored cap", () => {
  const storeDir = tempDir("panthea-sim-tick-cap-");
  try {
    const storePath = join(storeDir, "world.sqlite");
    const seeded = loadGreekWorldState();
    const cappedState = {
      ...seeded,
      rules: { ...seeded.rules, maxProposalsPerTick: 1 },
    };
    const reducers = createWorldProjectionReducers(cappedState);
    const store = openStore(storePath, reducers);
    ensureTraceSchema(store.db);

    const queue = buildRoutineQueue(cappedState);
    expect(queue.length).toBeGreaterThan(1);

    const step = applyOneTick(
      cappedState,
      createPrng(1),
      queue,
      { store, reducers, traceDb: store.db },
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

test("a legend proposal with an unknown linkedEventId is rejected at intake; one citing a committed but unrelated event is admitted and recorded event-linked, its prose not certified", () => {
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
    const linkedEventId = committedOutcome?.eventIds[0];
    expect(linkedEventId).toBeDefined();
    if (!linkedEventId) throw new Error("expected a linked event id");

    // Committed link: admitted at intake. The cited event is a farmer's
    // walk, unrelated to the story, and the legend is recorded anyway.
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
    expect(legend?.assertion).toBe("the tavern burned by Zeus's own hand");
    expect(legend?.linkedEventId).toBe(linkedEventId);
    expect(legend && isEventLinked(legend)).toBe(true);
    expect(legend).not.toHaveProperty("verified");

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
          const [firstEventId] = outcome?.eventIds ?? [];
          if (outcome?.outcome === "committed" && firstEventId) {
            followableEventId = firstEventId;
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

test("a strike's ignition follows back to the strike's observation and forward to its presentation receipt, and the divinity spend follows the same chain", () => {
  const storeDir = tempDir("panthea-sim-strike-trace-");
  try {
    const seeded = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(seeded);
    const store = openStore(join(storeDir, "world.sqlite"), reducers);
    ensureTraceSchema(store.db);

    const strike = manualProposal("zeus", {
      kind: "strike",
      target: "the-tavern",
      power: 3,
    });
    const step = applyOneTick(
      seeded,
      createPrng(1),
      [strike],
      { store, reducers, traceDb: store.db },
      { cursorWallMs: 1_000, paused: false },
    );
    expect(step.kind).toBe("committed");

    const outcome = getProposalOutcomeByProposalId(store.db, strike.id);
    if (outcome?.outcome !== "committed") {
      throw new Error("expected the strike to commit");
    }
    const events = listEvents(store.db);
    const spend = events.find((event) => event.kind === "resource-consumed");
    const ignition = events.find((event) => event.kind === "building-ignited");
    if (!spend || !ignition) throw new Error("expected spend and ignition");
    expect(outcome.eventIds).toEqual([spend.id, ignition.id]);

    const eventSource = createEventSource(store);
    const sessionId = createSessionId();
    recordReceipt(store.db, eventSource, { eventId: ignition.id, sessionId });

    const chain = followEvent(store.db, eventSource, ignition.id);
    expect(chain.steps.map((entry) => entry.step)).toEqual([
      "observation",
      "proposal",
      "validation",
      "event",
      "projection-change",
      "receipt",
    ]);
    expect(chain.steps[0]).toMatchObject({
      step: "observation",
      record: { id: strike.observation.id },
    });
    expect(chain.steps[3]).toMatchObject({ eventId: ignition.id });
    expect(chain.steps[5]).toMatchObject({ sessionId });

    const spendChain = followEvent(store.db, eventSource, spend.id);
    expect(spendChain.steps.slice(0, 3).map((entry) => entry.step)).toEqual([
      "observation",
      "proposal",
      "validation",
    ]);
    expect(spendChain.steps.some((entry) => entry.step === "receipt")).toBe(
      false,
    );

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

test("mergeTickQueue puts every external proposal first in arrival order, then the routines in their own order, minus a routine whose actor has an external non-claim proposal", () => {
  const state = loadGreekWorldState();
  const routine = buildRoutineQueue(state);
  const woodcutter = routine.find(
    (queued) => queued.proposal.actor === "woodcutter",
  );
  const farmer = routine.find((queued) => queued.proposal.actor === "farmer");
  if (!woodcutter || !farmer) throw new Error("expected two routine actors");

  const worship = manualProposal("woodcutter", {
    kind: "worship",
    deity: "zeus",
  });
  const strike = manualProposal("zeus", {
    kind: "strike",
    target: "the-tavern",
    power: 3,
  });
  const claim = manualProposal("farmer", {
    kind: "claim",
    assertion: "I own the shop",
  });

  const merged = mergeTickQueue(routine, [worship, strike, claim]);
  expect(merged).toEqual([
    worship,
    strike,
    claim,
    ...routine.filter((queued) => queued !== woodcutter),
  ]);
  expect(merged).toContain(farmer);
});

test("mergeTickQueue depends only on its two queues: the same inputs always give the same order", () => {
  const routine = buildRoutineQueue(loadGreekWorldState());
  const external = [
    manualProposal("woodcutter", { kind: "worship", deity: "zeus" }),
  ];
  expect(mergeTickQueue(routine, external)).toEqual(
    mergeTickQueue(routine, external),
  );
  expect(mergeTickQueue(routine, [])).toEqual([...routine]);
});

test("a legend citing the strike that really happened, one citing an unrelated event, and one citing nothing: the world records each link and certifies none", () => {
  const storeDir = tempDir("panthea-sim-legend-tellings-");
  try {
    const seeded = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(seeded);
    const store = openStore(join(storeDir, "world.sqlite"), reducers);
    ensureTraceSchema(store.db);

    const strike = manualProposal("zeus", {
      kind: "strike",
      target: "the-tavern",
      power: 3,
    });
    const struck = applyOneTick(
      seeded,
      createPrng(1),
      [strike],
      { store, reducers, traceDb: store.db },
      { cursorWallMs: 1_000, paused: false },
    );
    if (struck.kind !== "committed") throw new Error("expected a commit");
    const [spendId, ignitionId] =
      getProposalOutcomeByProposalId(store.db, strike.id)?.eventIds ?? [];
    if (!spendId || !ignitionId) throw new Error("expected two strike events");

    const tellings = [
      // Genuine: the story matches the cited ignition.
      {
        assertion: "Zeus struck the tavern and it burned",
        linkedEventId: ignitionId,
      },
      // Unrelated: the cited event is the divinity spend.
      {
        assertion: "Zeus destroyed the entire Underworld",
        linkedEventId: spendId,
      },
      // Absent: no evidence cited.
      { assertion: "The gods were angry that night" },
    ];
    let state = struck.state;
    let prng = struck.prng;
    for (const telling of tellings) {
      const intake = intakeProposal(store.db, {
        schemaVersion: 1,
        actor: "farmer",
        targets: [],
        expectedRevisions: [],
        source: "fixture",
        // Every telling cites the same unchanged observation id.
        observationId: "obs-one-unchanged-observation",
        kind: "legend",
        ...telling,
      });
      if (!intake.ok) throw new Error(intake.rejection.message);
      const step = applyOneTick(
        state,
        prng,
        [
          {
            id: createProposalId(),
            proposal: intake.proposal,
            observation: {
              schemaVersion: 1,
              id: intake.proposal.observationId,
              observer: toEntityId("farmer"),
              stateRevision: 0,
              factsRead: [],
              source: "fixture",
            },
          },
        ],
        { store, reducers, traceDb: store.db },
        { cursorWallMs: 1_000 * (state.tick + 1), paused: false },
      );
      if (step.kind !== "committed") throw new Error("expected a commit");
      state = step.state;
      prng = step.prng;
    }

    const legends = [...state.legends.values()];
    expect(legends.map((legend) => legend.assertion)).toEqual(
      tellings.map((telling) => telling.assertion),
    );
    expect(legends.map((legend) => legend.linkedEventId)).toEqual([
      ignitionId,
      spendId,
      undefined,
    ]);
    expect(legends.map(isEventLinked)).toEqual([true, true, false]);
    for (const legend of legends) {
      expect(legend).not.toHaveProperty("verified");
    }
    // Three tellings from one observation id: three distinct legends.
    expect(new Set(legends.map((legend) => legend.id)).size).toBe(3);

    closeStore(store);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

// --- Observation identity ---------------------------------------------------

/** A copy of `queued` that cites `observationId` and carries `factsRead` as its evidence. */
function citing(
  queued: QueuedProposal,
  observationId: ObservationRecord["id"],
  factsRead: readonly string[],
): QueuedProposal {
  return {
    ...queued,
    proposal: { ...queued.proposal, observationId },
    observation: { ...queued.observation, id: observationId, factsRead },
  };
}

function withStore<T>(
  fn: (world: {
    store: ReturnType<typeof openStore>;
    reducers: ReturnType<typeof createWorldProjectionReducers>;
    state: ReturnType<typeof loadGreekWorldState>;
    tick: (queue: readonly QueuedProposal[]) => ReturnType<typeof applyOneTick>;
  }) => T,
): T {
  const storeDir = tempDir("panthea-sim-observation-identity-");
  try {
    const state = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(state);
    const store = openStore(join(storeDir, "world.sqlite"), reducers);
    ensureTraceSchema(store.db);
    let current = state;
    let prng = createPrng(1);
    const tick = (queue: readonly QueuedProposal[]) => {
      const step = applyOneTick(
        current,
        prng,
        queue,
        { store, reducers, traceDb: store.db },
        { cursorWallMs: 1_000 * (current.tick + 1), paused: false },
      );
      if (step.kind === "committed") {
        current = step.state;
        prng = step.prng;
      }
      return step;
    };
    try {
      return fn({ store, reducers, state, tick });
    } finally {
      closeStore(store);
    }
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
}

test("a proposal citing a recorded observation id with different content is refused as observation-conflict: the tick commits, the recorded evidence is untouched, and nothing runs", () => {
  withStore(({ store, tick }) => {
    const first = manualProposal("farmer", { kind: "move", to: "tavern" });
    expect(tick([first]).kind).toBe("committed");
    const recorded = getObservation(store.db, first.observation.id)?.record;

    // A second, valid action reusing the first one's observation id with
    // different facts and state revision.
    const reuse = citing(
      manualProposal("woodcutter", { kind: "move", to: "tavern" }),
      first.observation.id,
      ["invented fact"],
    );
    const step = tick([reuse]);

    expect(step.kind).toBe("committed");
    expect(getProposalOutcomeByProposalId(store.db, reuse.id)).toMatchObject({
      outcome: "rejected",
      reason: "observation-conflict",
      eventIds: [],
    });
    expect(getObservation(store.db, first.observation.id)?.record).toEqual(
      recorded,
    );
    // Only the first proposal's move exists: the refused one changed nothing.
    expect(
      listEvents(store.db)
        .filter((event) => event.kind === "entity-moved")
        .map((event) => String(event.entityId)),
    ).toEqual(["farmer"]);
  });
});

test("a refused proposal does not hold up the others in its tick, and the tick is not repeated", () => {
  withStore(({ store, tick, state }) => {
    const first = manualProposal("farmer", { kind: "move", to: "tavern" });
    tick([first]);
    const conflicting = citing(
      manualProposal("woodcutter", { kind: "move", to: "tavern" }),
      first.observation.id,
      ["invented fact"],
    );
    const fine = manualProposal("zeus", {
      kind: "strike",
      target: "the-tavern",
      power: 3,
    });
    const before = readClock(store.db).tick;

    const step = tick([conflicting, fine]);

    expect(step.kind).toBe("committed");
    expect(readClock(store.db).tick).toBe(before + 1);
    expect(getProposalOutcomeByProposalId(store.db, fine.id)?.outcome).toBe(
      "committed",
    );
    expect(state.tick).toBeLessThan(readClock(store.db).tick);
  });
});

test("two proposals in one tick citing one observation id with different content: the first runs, the second is refused, and the observation is recorded once", () => {
  withStore(({ store, tick }) => {
    const observationId = createObservationId();
    const a = citing(
      manualProposal("farmer", { kind: "move", to: "tavern" }),
      observationId,
      ["a"],
    );
    const b = citing(
      manualProposal("woodcutter", { kind: "move", to: "tavern" }),
      observationId,
      ["b"],
    );

    expect(tick([a, b]).kind).toBe("committed");

    expect(getProposalOutcomeByProposalId(store.db, a.id)?.outcome).toBe(
      "committed",
    );
    expect(getProposalOutcomeByProposalId(store.db, b.id)).toMatchObject({
      outcome: "rejected",
      reason: "observation-conflict",
    });
    expect(getObservation(store.db, observationId)?.record.factsRead).toEqual([
      "a",
    ]);
  });
});

test("several proposals citing one unchanged observation all run, in the same tick or later, and the observation is recorded once", () => {
  withStore(({ store, tick }) => {
    const a = manualProposal("zeus", {
      kind: "strike",
      target: "old-oak",
      power: 1,
    });
    // The same observer's unchanged observation, cited again by a later
    // proposal of the same actor.
    const again = manualProposal("zeus", {
      kind: "strike",
      target: "old-oak",
      power: 1,
    });
    const c: QueuedProposal = {
      ...again,
      proposal: { ...again.proposal, observationId: a.observation.id },
      observation: a.observation,
    };
    // And a same-tick proposal by a different actor citing it would be a
    // different observer, hence different content: covered as a conflict above.

    expect(tick([a]).kind).toBe("committed");
    expect(tick([c]).kind).toBe("committed");

    for (const queued of [a, c]) {
      expect(getProposalOutcomeByProposalId(store.db, queued.id)).toMatchObject(
        { outcome: "committed" },
      );
    }
    expect(
      (
        store.db
          .query("SELECT COUNT(*) AS n FROM trace_observations WHERE id = ?")
          .get(a.observation.id) as { n: number }
      ).n,
    ).toBe(1);
  });
});
