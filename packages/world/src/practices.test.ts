import { expect, test } from "bun:test";
import type { ContentPack, EventId, WorldEvent } from "@panthea/contracts";
import {
  applyEvent,
  applyEvents,
  runTick,
  submitProposal,
  type TickOptions,
  type TickResult,
} from "./actions";
import { decode, encode } from "./codec";
import { getMemories, getRelationship } from "./memory";
import {
  createInitialWorldState,
  createPrng,
  getActor,
  getEntityRevision,
  type PrngState,
  toEntityId,
  type WorldState,
  withActor,
} from "./state";
import { validateProposal } from "./validate";

const id = toEntityId;

/**
 * Altar, square, tavern, and a hall, joined in a line; an island nothing
 * reaches. Zeus is at the altar with the farmer, Hera in the square with the
 * woodcutter, Athena in the tavern. Practice tunables are small so a scenario
 * stays short: 40 ticks to answer, two counteroffers, terms of 5 to 200 ticks.
 */
function pack(
  practiceBalance: Record<string, number> = {},
  divinity = 10,
): ContentPack {
  const deity = (name: string, locationId: string) => ({
    id: name,
    name,
    locationId,
    deity: true,
    startingInventory: [
      { resource: "divinity", amount: divinity },
      { resource: "food", amount: 5 },
    ],
  });
  return {
    schemaVersion: 1,
    realms: ["mortal", "olympus"],
    resources: [],
    locations: [
      {
        id: "square",
        realm: "mortal",
        name: "Square",
        edges: [
          { to: "altar", transport: "path", bidirectional: true },
          { to: "tavern", transport: "path", bidirectional: true },
          { to: "hall", transport: "path", bidirectional: true },
          { to: "gate", transport: "path", bidirectional: true },
        ],
      },
      // Stands in for Olympus: only the divine pass.
      {
        id: "gate",
        realm: "mortal",
        name: "Gate",
        edges: [],
        requiredCapability: "divine",
      },
      { id: "altar", realm: "mortal", name: "Altar", edges: [] },
      { id: "tavern", realm: "mortal", name: "Tavern", edges: [] },
      { id: "hall", realm: "mortal", name: "Hall", edges: [] },
      { id: "island", realm: "mortal", name: "Island", edges: [] },
    ],
    buildings: [],
    inhabitants: [
      deity("zeus", "altar"),
      deity("hera", "square"),
      deity("athena", "tavern"),
      {
        id: "farmer",
        name: "Farmer",
        locationId: "altar",
        drives: { thrift: 0, appetite: 0, greed: 0, piety: 0 },
        startingInventory: [{ resource: "food", amount: 60 }],
      },
      {
        id: "woodcutter",
        name: "Woodcutter",
        locationId: "square",
        drives: { thrift: 0, appetite: 0, greed: 0, piety: 0 },
        startingInventory: [{ resource: "food", amount: 60 }],
      },
    ],
    rules: {
      catchUpCapMs: 0,
      catchUpChunkMs: 0,
      checkpointIntervalMs: 0,
      maxProposalsPerTick: 100,
      fireBalance: {
        igniteThreshold: 3,
        intensityGrowthPerTick: 1,
        destroyIntensity: 50,
      },
      economyBalance: { consumeAmount: 1, value_food: 3, value_currency: 1 },
      // Quiet for good: no director trouble in a scenario this short.
      petitionBalance: { directorQuietTicks: 100000 },
      practiceBalance: {
        negotiationTicks: 40,
        counterBudget: 2,
        minTermTicks: 5,
        maxTermTicks: 200,
        ...practiceBalance,
      },
    },
    recipes: {},
  };
}

class World {
  state: WorldState;
  prng: PrngState = createPrng(1);
  readonly log: WorldEvent[] = [];
  readonly initial: WorldState;
  last: TickResult | undefined;
  constructor(
    practiceBalance: Record<string, number> = {},
    private readonly options: TickOptions = {},
    divinity = 10,
  ) {
    this.state = createInitialWorldState(pack(practiceBalance, divinity));
    this.initial = this.state;
  }
  /** One tick with `extra` fixture proposals. */
  tick(...extra: Record<string, unknown>[]): TickResult {
    const proposals = extra.map((raw, index) => {
      const submitted = submitProposal({
        schemaVersion: 1,
        targets: [],
        expectedRevisions: [],
        source: "fixture",
        observationId: `obs-${this.state.tick}-${index}`,
        ...raw,
      });
      if (!submitted.ok) throw new Error(submitted.rejection.message);
      return submitted.proposal;
    });
    const result = runTick(this.state, this.prng, proposals, this.options);
    this.state = result.state;
    this.prng = result.prng;
    this.log.push(...result.events);
    this.last = result;
    return result;
  }
  /** Runs empty ticks until `done` or `limit`. */
  until(done: () => boolean, limit = 400): void {
    for (let n = 0; n < limit && !done(); n += 1) this.tick();
  }
  /** Commits a fixture event as the world would have. */
  apply(overrides: Record<string, unknown>): WorldEvent {
    const event = {
      schemaVersion: 1,
      id: `evt-${this.state.tick}-${1000 + this.log.length}`,
      sequence: this.state.lastSequence + 1,
      simTime: 0,
      tick: this.state.tick,
      correlationId: "fixture",
      causationId: "fixture",
      approximate: false,
      ...overrides,
    } as unknown as WorldEvent;
    this.state = applyEvent(
      { ...this.state, lastSequence: event.sequence },
      event,
    );
    this.log.push(event);
    return event;
  }
  /** `who` heard of something Zeus did, from the farmer: a told memory of a report. Returns the cause the god can cite. */
  hears(who = "hera"): EventId {
    const content = "Zeus visited a nymph";
    const report = this.apply({
      kind: "report-told",
      entityId: "farmer",
      listenerId: who,
      content,
    });
    this.apply({
      kind: "memory-recorded",
      memoryKind: "told",
      entityId: who,
      sourceEventId: report.id,
      teller: "farmer",
      content,
      subjects: ["farmer", who],
      salience: 4,
    });
    return report.id;
  }
  /** Puts an actor somewhere, bypassing the rules, to stage a scene. */
  place(who: string, locationId: string): void {
    const actor = getActor(this.state, id(who));
    if (!actor) throw new Error(who);
    this.state = withActor(this.state, {
      ...actor,
      locationId: id(locationId),
    });
  }
  kill(who: string): void {
    const actor = getActor(this.state, id(who));
    if (!actor) throw new Error(who);
    this.state = withActor(this.state, { ...actor, alive: false });
  }
  threads() {
    return [...this.state.threads.values()];
  }
  thread(threadId?: EventId) {
    const found =
      threadId === undefined
        ? this.threads().at(-1)
        : this.state.threads.get(threadId);
    if (!found) throw new Error("no such thread");
    return found;
  }
  rejected(): string[] {
    return (this.last?.rejected ?? []).map((r) => r.reason);
  }
  ended() {
    return this.log.filter(
      (e): e is Extract<WorldEvent, { kind: "practice-ended" }> =>
        e.kind === "practice-ended",
    );
  }
}

// --- Proposal builders ------------------------------------------------------------------------

type Term = Record<string, unknown>;
const tell = (party: string, place: string, deadlineTicks = 100): Term => ({
  kind: "tell-legend",
  party,
  place,
  deadlineTicks,
});
const beAt = (party: string, place: string, deadlineTicks = 100): Term => ({
  kind: "be-at",
  party,
  place,
  deadlineTicks,
});
const stayAway = (party: string, place: string, deadlineTicks = 30): Term => ({
  kind: "stay-away",
  party,
  place,
  deadlineTicks,
});

const demand = (
  cause: EventId,
  term: Term = tell("zeus", "altar"),
  extra: Record<string, unknown> = {},
) => ({
  actor: "hera",
  kind: "practice",
  move: "demand",
  counterparty: "zeus",
  cause,
  term,
  ...extra,
});

/** A move on `thread`, pinned to its revision unless `pin` is false. */
function move(
  world: World,
  actor: string,
  moveName: string,
  extra: Record<string, unknown> = {},
  pin = true,
) {
  const thread = world.thread();
  return {
    actor,
    kind: "practice",
    move: moveName,
    thread: thread.id,
    ...(pin
      ? {
          expectedRevisions: [
            { entityId: thread.id, revision: thread.revision },
          ],
        }
      : {}),
    ...extra,
  };
}

const legend = (actor: string) => ({
  actor,
  kind: "legend",
  assertion: "Hera is the queen of heaven",
});

/** Hera demands, with a cause she was told of; returns the world with the thread open. */
function opened(term: Term = tell("zeus", "altar"), world = new World()) {
  const cause = world.hears();
  world.tick(demand(cause, term));
  return { world, cause, thread: world.thread() };
}

/** The same, with Zeus having accepted. */
function accepted(term: Term = tell("zeus", "altar"), world = new World()) {
  const set = opened(term, world);
  world.tick(move(world, "zeus", "accept"));
  return { ...set, thread: world.thread() };
}

// --- Lifecycle: fulfilled ---------------------------------------------------------------------

test("Hera demands a legend at the altar and Zeus accepts; the legend he then tells to the mortals there fulfils the thread, and the ruling is a primary event of that tick", () => {
  const { world, cause, thread } = opened();
  expect(thread).toMatchObject({
    practice: "settlement",
    status: "open",
    demander: "hera",
    obligated: "zeus",
    causes: [cause],
    offeredBy: "hera",
    counterBudgetLeft: 2,
    negotiationDeadline: 41,
    term: { kind: "tell-legend", party: "zeus", place: "altar", deadline: 101 },
  });

  world.tick(move(world, "zeus", "accept", { swear: true }));
  expect(world.thread()).toMatchObject({
    status: "accepted",
    acceptance: { sworn: true, tick: 2 },
  });
  // Acceptance alone is not fulfilment: the world waits for the performance.
  world.tick();
  expect(world.thread().status).toBe("accepted");
  expect(world.ended()).toEqual([]);

  const telling = world.tick(legend("zeus"));
  const legendEvent = telling.events.find((e) => e.kind === "legend-recorded");
  expect(legendEvent).toMatchObject({ hearers: ["farmer"] });
  expect(world.thread().status).toBe("fulfilled");
  const ended = telling.environmentEvents.filter(
    (e) => e.kind === "practice-ended",
  );
  expect(ended).toMatchObject([
    {
      outcome: "fulfilled",
      reason: "performed",
      entityId: "hera",
      counterparty: "zeus",
      threadId: thread.id,
      performedBy: legendEvent?.id,
      tick: world.state.tick,
    },
  ]);
  // Judged at the end of the environment step, so the ending is primary: never a derived event.
  expect(
    telling.derivedEvents.filter((e) => e.kind === "practice-ended"),
  ).toEqual([]);
  expect(world.thread().closedTick).toBe(world.state.tick);
});

test("each kind of term is fulfilled by its own observed performance: arriving, giving, offering, and blessing", () => {
  // Be at a place: Zeus walks from the altar to the tavern.
  const arrive = accepted(beAt("zeus", "tavern"));
  arrive.world.tick({ actor: "zeus", kind: "move", to: "square" });
  expect(arrive.world.thread().status).toBe("accepted");
  arrive.world.tick({ actor: "zeus", kind: "move", to: "tavern" });
  expect(arrive.world.thread().status).toBe("fulfilled");

  // Give a resource: Zeus trades Hera one divinity for nothing, standing with her.
  const give = accepted({
    kind: "give-resource",
    party: "zeus",
    to: "hera",
    resource: "divinity",
    amount: 1,
    deadlineTicks: 50,
  });
  give.world.place("hera", "altar");
  give.world.tick({
    actor: "zeus",
    kind: "trade",
    counterparty: "hera",
    give: [{ resource: "divinity", amount: 1 }],
    receive: [],
  });
  expect(give.world.thread().status).toBe("fulfilled");

  // Make an offering: Zeus worships Hera with food.
  const offer = accepted({
    kind: "make-offering",
    party: "zeus",
    to: "hera",
    resource: "food",
    amount: 1,
    deadlineTicks: 50,
  });
  offer.world.tick({
    actor: "zeus",
    kind: "worship",
    deity: "hera",
    offering: { resource: "food", amount: 1 },
  });
  expect(offer.world.thread().status).toBe("fulfilled");

  // Bless a mortal: the farmer has a petition before Zeus, and he answers it.
  const world = new World();
  const prayer = world.apply({
    kind: "petition-opened",
    entityId: "farmer",
    god: "zeus",
    cause: "evt-0-1",
    request: {
      kind: "help",
      need: { kind: "resource", resource: "food", amount: 2 },
    },
  });
  const cause = world.hears();
  world.tick(
    demand(cause, {
      kind: "bless-mortal",
      party: "zeus",
      mortal: "farmer",
      deadlineTicks: 50,
    }),
  );
  world.tick(move(world, "zeus", "accept"));
  world.tick({ actor: "zeus", kind: "bless", petition: prayer.id });
  expect(world.thread().status).toBe("fulfilled");
});

test("a place to stay away from is kept when the deadline passes with Zeus elsewhere, and breached the moment he walks in", () => {
  const kept = accepted(stayAway("zeus", "tavern", 10));
  kept.world.until(() => kept.world.thread().status !== "accepted");
  expect(kept.world.thread().status).toBe("fulfilled");
  expect(kept.world.ended()[0]).toMatchObject({
    outcome: "fulfilled",
    reason: "kept-away",
    tick: kept.thread.term.deadline + 1,
  });

  const entered = accepted(stayAway("zeus", "tavern", 30));
  entered.world.tick({ actor: "zeus", kind: "move", to: "square" });
  expect(entered.world.thread().status).toBe("accepted");
  const walk = entered.world.tick({
    actor: "zeus",
    kind: "move",
    to: "tavern",
  });
  expect(entered.world.thread().status).toBe("breached");
  expect(entered.world.ended()[0]).toMatchObject({
    outcome: "breached",
    reason: "entered",
    performedBy: walk.events.find((e) => e.kind === "entity-moved")?.id,
  });
});

// --- Lifecycle: refusal, breach, and what does not count --------------------------------------

test("Zeus refuses: the thread is refused and closed, and keeps the causes it consumed", () => {
  const { world, cause } = opened();
  world.tick(move(world, "zeus", "refuse"));
  expect(world.thread()).toMatchObject({
    status: "refused",
    causes: [cause],
    closedTick: world.state.tick,
  });
  // Closed stays closed: no later move reopens it.
  world.tick(move(world, "zeus", "accept", {}, false));
  expect(world.rejected()).toEqual(["malformed"]);
  expect(world.thread().status).toBe("refused");
});

test("Zeus accepts and the deadline passes with no performance: breached, recorded with its reason, on the first tick past the deadline", () => {
  const { world, thread } = accepted(tell("zeus", "altar", 20));
  const deadline = thread.term.deadline;
  world.until(() => world.state.tick === deadline);
  expect(world.thread().status).toBe("accepted");
  expect(world.ended()).toEqual([]);
  const past = world.tick();
  expect(world.thread().status).toBe("breached");
  expect(
    past.environmentEvents.filter((e) => e.kind === "practice-ended"),
  ).toMatchObject([
    {
      outcome: "breached",
      reason: "obligation-deadline",
      threadId: thread.id,
      tick: deadline + 1,
    },
  ]);
  expect(world.thread().acceptance).toMatchObject({ sworn: false });
});

test("a performance on the deadline tick still counts; one the tick after does not", () => {
  const onTime = accepted(tell("zeus", "altar", 20));
  onTime.world.until(
    () => onTime.world.state.tick === onTime.thread.term.deadline - 1,
  );
  onTime.world.tick(legend("zeus"));
  expect(onTime.world.state.tick).toBe(onTime.thread.term.deadline);
  expect(onTime.world.thread().status).toBe("fulfilled");

  const late = accepted(tell("zeus", "altar", 20));
  late.world.until(() => late.world.state.tick === late.thread.term.deadline);
  late.world.tick(legend("zeus"));
  expect(late.world.thread().status).toBe("breached");
});

test("a legend told before acceptance, by Hera, away from the place, or to no mortal, does not fulfil; the same legend by Zeus at the place after acceptance does", () => {
  // Before acceptance: Zeus tells it while the demand is still open.
  const early = opened();
  early.world.tick(legend("zeus"));
  early.world.tick(move(early.world, "zeus", "accept"));
  early.world.until(() => early.world.thread().status !== "accepted");
  expect(early.world.thread().status).toBe("breached");

  // By Hera, at the altar, with the farmer listening.
  const byHera = accepted();
  byHera.world.place("hera", "altar");
  byHera.world.tick(legend("hera"));
  expect(byHera.world.thread().status).toBe("accepted");

  // Away from the place: Zeus tells it in the square, to the woodcutter.
  const elsewhere = accepted();
  elsewhere.world.place("zeus", "square");
  elsewhere.world.tick(legend("zeus"));
  expect(elsewhere.world.thread().status).toBe("accepted");

  // To no mortal: at the hall only Hera listens.
  const gods = accepted(tell("zeus", "hall"));
  gods.world.place("zeus", "hall");
  gods.world.place("hera", "hall");
  const told = gods.world.tick(legend("zeus"));
  expect(told.events.find((e) => e.kind === "legend-recorded")).toMatchObject({
    hearers: ["hera"],
  });
  expect(gods.world.thread().status).toBe("accepted");

  // Control: the same legend, by Zeus, at the altar, after acceptance.
  const control = accepted();
  control.world.tick(legend("zeus"));
  expect(control.world.thread().status).toBe("fulfilled");
});

test("a legend told earlier in the very tick the obligation is accepted does not fulfil it: only what follows the acceptance event counts", () => {
  const { world } = opened();
  // Zeus counters with a telling of his own; Hera accepts it in the tick his legend is told, after it.
  world.tick(
    move(world, "zeus", "counter", { term: tell("zeus", "altar", 120) }),
  );
  world.tick(legend("zeus"), move(world, "hera", "accept"));
  expect(world.thread().status).toBe("accepted");
  // Control: the same two proposals the other way round fulfil it.
  const control = opened();
  control.world.tick(
    move(control.world, "zeus", "counter", {
      term: tell("zeus", "altar", 120),
    }),
  );
  control.world.tick(move(control.world, "hera", "accept"), legend("zeus"));
  expect(control.world.thread().status).toBe("fulfilled");
});

test("a party who dies while the thread is open ends it withdrawn, with no breach; a death after a breach was already due still breaches", () => {
  const open = opened();
  open.world.kill("zeus");
  open.world.tick();
  expect(open.world.thread().status).toBe("withdrawn");
  expect(open.world.ended()).toMatchObject([
    { outcome: "withdrawn", reason: "party-died" },
  ]);

  const bound = accepted(tell("zeus", "altar", 20));
  bound.world.kill("hera");
  bound.world.tick();
  expect(bound.world.thread().status).toBe("withdrawn");
  expect(bound.world.ended().map((e) => e.outcome)).toEqual(["withdrawn"]);

  const late = accepted(tell("zeus", "altar", 20));
  late.world.until(() => late.world.state.tick === late.thread.term.deadline);
  late.world.kill("zeus");
  late.world.tick();
  expect(late.world.thread().status).toBe("breached");
});

// --- Negotiation: counters, budget, deadline --------------------------------------------------

test("a counter puts a new term on the table, spends a counteroffer, and hands the answer to the other god", () => {
  const { world } = opened();
  world.tick(
    move(world, "zeus", "counter", { term: tell("zeus", "altar", 150) }),
  );
  expect(world.thread()).toMatchObject({
    status: "countered",
    offeredBy: "zeus",
    counterBudgetLeft: 1,
    term: { kind: "tell-legend", deadline: 152 },
  });
  // Zeus cannot accept his own offer; Hera can.
  world.tick(move(world, "zeus", "accept"));
  expect(world.rejected()).toEqual(["unauthorized-claim"]);
  world.tick(move(world, "hera", "accept"));
  expect(world.thread().status).toBe("accepted");
  expect(world.thread().acceptance).toMatchObject({ tick: world.state.tick });
});

test("the counteroffer budget runs out: the counter that spends the last one ends the thread refused at the end of that tick", () => {
  const { world, thread } = opened();
  world.tick(
    move(world, "zeus", "counter", { term: tell("zeus", "altar", 120) }),
  );
  expect(world.thread().status).toBe("countered");
  const last = world.tick(
    move(world, "hera", "counter", { term: tell("zeus", "altar", 140) }),
  );
  expect(world.thread()).toMatchObject({
    status: "refused",
    counterBudgetLeft: 0,
  });
  expect(
    last.environmentEvents.filter((e) => e.kind === "practice-ended"),
  ).toMatchObject([
    { outcome: "refused", reason: "budget-exhausted", threadId: thread.id },
  ]);
});

test("a counter with no budget left is rejected, even when the thread has not yet been judged closed", () => {
  const { world } = opened();
  world.tick(
    move(world, "zeus", "counter", { term: tell("zeus", "altar", 120) }),
  );
  const both = world.tick(
    move(world, "hera", "counter", { term: tell("zeus", "altar", 140) }, false),
    move(world, "zeus", "counter", { term: tell("zeus", "altar", 160) }, false),
  );
  expect(both.rejected.map((r) => r.reason)).toEqual(["malformed"]);
  expect(both.rejected[0]?.message).toContain("counteroffer");
});

test("the negotiation deadline passes with no answer: expired on the first tick past it, and a move that tick is too late", () => {
  const { world, thread } = opened();
  world.until(() => world.state.tick === thread.negotiationDeadline);
  expect(world.thread().status).toBe("open");
  world.tick(move(world, "zeus", "accept", {}, false));
  expect(world.rejected()).toEqual(["malformed"]);
  expect(world.thread().status).toBe("expired");
  expect(world.ended()).toMatchObject([
    {
      outcome: "expired",
      reason: "negotiation-deadline",
      tick: thread.negotiationDeadline + 1,
    },
  ]);
});

test("an answer inside the negotiation window beats the deadline: acceptance on its last tick holds", () => {
  const { world, thread } = opened();
  world.until(() => world.state.tick === thread.negotiationDeadline - 1);
  world.tick(move(world, "zeus", "accept"));
  expect(world.state.tick).toBe(thread.negotiationDeadline);
  expect(world.thread().status).toBe("accepted");
  world.tick();
  expect(world.thread().status).toBe("accepted");
});

test("either god may withdraw an open thread; a third god cannot; an accepted obligation cannot be withdrawn", () => {
  const byDemander = opened();
  byDemander.world.tick(move(byDemander.world, "hera", "withdraw"));
  expect(byDemander.world.thread().status).toBe("withdrawn");

  const byObligated = opened();
  byObligated.world.tick(move(byObligated.world, "zeus", "withdraw"));
  expect(byObligated.world.thread().status).toBe("withdrawn");

  const stranger = opened();
  stranger.world.tick(move(stranger.world, "athena", "withdraw"));
  expect(stranger.world.rejected()).toEqual(["unauthorized-claim"]);
  expect(stranger.world.thread().status).toBe("open");

  const bound = accepted();
  bound.world.tick(move(bound.world, "hera", "withdraw"));
  expect(bound.world.rejected()).toEqual(["malformed"]);
  expect(bound.world.thread().status).toBe("accepted");
});

test("only the god who did not make the offer may answer it: the demander cannot accept or refuse her own demand, and a third god cannot answer at all", () => {
  for (const [actor, moveName] of [
    ["hera", "accept"],
    ["hera", "refuse"],
    ["athena", "accept"],
    ["athena", "refuse"],
    ["athena", "counter"],
  ] as const) {
    const { world } = opened();
    world.tick(
      move(
        world,
        actor,
        moveName,
        moveName === "counter" ? { term: tell("athena", "altar") } : {},
        false,
      ),
    );
    expect(world.rejected()).toEqual(["unauthorized-claim"]);
    expect(world.thread().status).toBe("open");
  }
});

// --- Opening: causes, parties, terms ----------------------------------------------------------

test("a demand needs a cause its opener knows: a cause only someone else remembers, an invented one, or none are refused; a told memory of an event, or a witnessed one, opens", () => {
  const world = new World();
  const known = world.hears("hera");
  // Zeus's own memory is a different one: he never heard of it.
  world.tick(
    demand(known, tell("zeus", "altar"), {
      actor: "athena",
      counterparty: "zeus",
    }),
  );
  expect(world.rejected()).toEqual(["unauthorized-claim"]);
  world.tick(demand("evt-404" as EventId));
  expect(world.rejected()).toEqual(["unauthorized-claim"]);
  expect(world.threads()).toEqual([]);

  // Control: the cause Hera was told of opens.
  world.tick(demand(known));
  expect(world.threads()).toHaveLength(1);

  // A witnessed memory opens one too, and so does the event a told memory cites.
  const second = new World();
  const seen = second.apply({
    kind: "resource-consumed",
    entityId: "zeus",
    resource: "divinity",
    amount: 1,
  });
  second.apply({
    kind: "memory-recorded",
    memoryKind: "witnessed",
    entityId: "hera",
    sourceEventId: seen.id,
    eventKind: "resource-consumed",
    subjects: ["zeus"],
    salience: 3,
  });
  second.tick(demand(seen.id));
  expect(second.threads()).toHaveLength(1);

  const third = new World();
  const happening = third.apply({
    kind: "resource-consumed",
    entityId: "zeus",
    resource: "divinity",
    amount: 1,
  });
  const report = third.apply({
    kind: "report-told",
    entityId: "farmer",
    listenerId: "hera",
    content: "Zeus spent his power",
    linkedEventId: happening.id,
  });
  third.apply({
    kind: "memory-recorded",
    memoryKind: "told",
    entityId: "hera",
    sourceEventId: report.id,
    teller: "farmer",
    content: "Zeus spent his power",
    linkedEventId: happening.id,
    subjects: ["farmer"],
    salience: 3,
  });
  third.tick(demand(happening.id));
  expect(third.threads()).toHaveLength(1);
});

test("a settlement is between two living gods: a mortal cannot demand, nothing can be demanded of a mortal or a corpse, and no one demands of herself", () => {
  const world = new World();
  const cause = world.hears("hera");
  world.apply({
    kind: "memory-recorded",
    memoryKind: "told",
    entityId: "farmer",
    sourceEventId: cause,
    teller: "farmer",
    content: "x",
    subjects: ["farmer"],
    salience: 3,
  });
  const attempts: [Record<string, unknown>, string][] = [
    [
      demand(cause, tell("zeus", "altar"), { actor: "farmer" }),
      "unauthorized-claim",
    ],
    [
      demand(cause, tell("farmer", "altar"), { counterparty: "farmer" }),
      "unauthorized-claim",
    ],
    [
      demand(cause, tell("hera", "altar"), { counterparty: "hera" }),
      "malformed",
    ],
  ];
  for (const [proposal, reason] of attempts) {
    world.tick(proposal);
    expect(world.rejected()).toEqual([reason]);
  }
  world.kill("zeus");
  world.tick(demand(cause));
  expect(world.rejected()).toEqual(["dead-actor"]);
  expect(world.threads()).toEqual([]);
});

test("a term names only the two gods: a demand binds the god it is made of, and no one promises a third god's cooperation", () => {
  const world = new World();
  const cause = world.hears();
  for (const term of [tell("athena", "altar"), tell("hera", "altar")]) {
    world.tick(demand(cause, term));
    expect(world.rejected()).toEqual(["unauthorized-claim"]);
  }
  const { world: countered } = opened();
  countered.tick(
    move(countered, "zeus", "counter", { term: tell("athena", "altar") }),
  );
  expect(countered.rejected()).toEqual(["unauthorized-claim"]);
  // Giving to a third god would need that god's consent, so it is refused; an offering needs no one's.
  const third = new World();
  const thirdCause = third.hears();
  third.tick(
    demand(thirdCause, {
      kind: "give-resource",
      party: "zeus",
      to: "athena",
      resource: "divinity",
      amount: 1,
      deadlineTicks: 50,
    }),
  );
  expect(third.rejected()).toEqual(["unauthorized-claim"]);
  third.tick(
    demand(thirdCause, {
      kind: "make-offering",
      party: "zeus",
      to: "athena",
      resource: "food",
      amount: 1,
      deadlineTicks: 50,
    }),
  );
  expect(third.rejected()).toEqual([]);
  // Control: Zeus may bind himself or Hera in a counter.
  countered.tick(
    move(countered, "zeus", "counter", { term: beAt("hera", "altar") }),
  );
  expect(countered.rejected()).toEqual([]);
  expect(countered.thread().term).toMatchObject({ party: "hera" });
});

test("a term its party cannot reach or afford by the deadline is refused at the offer", () => {
  const cases: [string, Term, string][] = [
    ["a place no route reaches", tell("zeus", "island"), "not-adjacent"],
    ["be at an unreachable place", beAt("zeus", "island"), "not-adjacent"],
    ["a place that does not exist", tell("zeus", "nowhere"), "malformed"],
    [
      "more of a resource than he holds",
      {
        kind: "give-resource",
        party: "zeus",
        to: "hera",
        resource: "divinity",
        amount: 99,
        deadlineTicks: 50,
      },
      "insufficient-resources",
    ],
    [
      "an offering he cannot make",
      {
        kind: "make-offering",
        party: "zeus",
        to: "hera",
        resource: "food",
        amount: 99,
        deadlineTicks: 50,
      },
      "insufficient-resources",
    ],
    [
      "a blessing for a mortal who has no petition before him",
      {
        kind: "bless-mortal",
        party: "zeus",
        mortal: "farmer",
        deadlineTicks: 50,
      },
      "malformed",
    ],
    [
      "a deadline below the world's minimum",
      tell("zeus", "altar", 4),
      "malformed",
    ],
    [
      "a deadline above the world's maximum",
      tell("zeus", "altar", 201),
      "malformed",
    ],
  ];
  for (const [label, term, reason] of cases) {
    const world = new World();
    world.tick(demand(world.hears(), term));
    expect([label, ...world.rejected()]).toEqual([label, reason]);
    expect(world.threads()).toEqual([]);
  }
  // Control: each of these is a term the world can check, so a reachable one opens.
  const control = new World();
  control.tick(demand(control.hears(), tell("zeus", "tavern")));
  expect(control.threads()).toHaveLength(1);
});

test("a place Zeus can reach, but not in time, is refused: the route and the telling take as many ticks as hops plus one", () => {
  const world = new World({ minTermTicks: 1 });
  const cause = world.hears();
  // Altar to tavern is two moves, and the telling is a third action.
  world.tick(demand(cause, tell("zeus", "tavern", 2)));
  expect(world.rejected()).toEqual(["not-adjacent"]);
  world.tick(demand(cause, tell("zeus", "tavern", 3)));
  expect(world.threads()).toHaveLength(1);
});

test("a blessing term needs a god with the divinity for it: a god who cannot pay is refused as insufficient power", () => {
  const world = new World({}, {}, 1);
  world.apply({
    kind: "petition-opened",
    entityId: "farmer",
    god: "zeus",
    cause: "evt-0-1",
    request: {
      kind: "help",
      need: { kind: "resource", resource: "food", amount: 2 },
    },
  });
  world.tick(
    demand(world.hears(), {
      kind: "bless-mortal",
      party: "zeus",
      mortal: "farmer",
      deadlineTicks: 50,
    }),
  );
  expect(world.rejected()).toEqual(["insufficient-power"]);
});

test("acceptance re-checks the term: once Zeus can no longer reach the place, he cannot accept it", () => {
  const { world } = opened(tell("zeus", "tavern"));
  cutRoute(world);
  world.tick(move(world, "zeus", "accept"));
  expect(world.rejected()).toEqual(["not-adjacent"]);
  expect(world.thread().status).toBe("open");
});

/** Severs the tavern from the rest of the map. */
function cutRoute(world: World): void {
  const square = world.state.locations.get(id("square"));
  if (!square) throw new Error("square");
  world.state = {
    ...world.state,
    locations: new Map(world.state.locations).set(id("square"), {
      ...square,
      edges: square.edges.filter((edge) => edge.to !== "tavern"),
    }),
  };
}

test("after acceptance the term's place becomes unreachable: the obligation stays open and can be seen to be unperformable, and it breaches at the deadline", async () => {
  const { canStillPerform } = await import("./practices");
  const { world, thread } = accepted(beAt("zeus", "tavern", 30));
  expect(canStillPerform(world.state, world.thread())).toBe(true);
  cutRoute(world);
  expect(canStillPerform(world.state, world.thread())).toBe(false);
  world.until(() => world.state.tick === thread.term.deadline);
  expect(world.thread().status).toBe("accepted");
  world.tick();
  expect(world.thread().status).toBe("breached");
  // A thread that has ended is no longer something to perform.
  expect(canStillPerform(world.state, world.thread())).toBe(false);
});

// --- Revisions: a move pins its thread and nothing else ---------------------------------------

test("thread ids resolve through getEntityRevision, which moves on every change to the thread and only then", () => {
  const { world, thread } = opened();
  expect(getEntityRevision(world.state, thread.id as never)).toBe(
    thread.revision,
  );
  expect(getEntityRevision(world.state, "evt-404" as never)).toBeUndefined();
  const before = world.thread().revision;
  world.tick({ actor: "athena", kind: "move", to: "square" });
  expect(world.thread().revision).toBe(before);
  world.tick(
    move(world, "zeus", "counter", { term: tell("zeus", "altar", 120) }),
  );
  expect(world.thread().revision).toBe(before + 1);
  world.tick(move(world, "hera", "accept"));
  expect(world.thread().revision).toBe(before + 2);
});

test("a move pinned to a stale thread revision is refused stale-target; one pinned to the current revision commits; an unrelated actor's move does not stale it", () => {
  const { world, thread } = opened();
  const original = { entityId: thread.id, revision: thread.revision };
  // An unrelated actor acts (and a mortal moves): the thread is unchanged.
  world.tick(
    { actor: "athena", kind: "move", to: "square" },
    { actor: "farmer", kind: "move", to: "square" },
  );
  world.tick(
    move(world, "zeus", "counter", { term: tell("zeus", "altar", 120) }),
  );
  expect(world.rejected()).toEqual([]);

  // Hera answers from the revision she saw before the counter.
  world.tick({
    ...move(
      world,
      "hera",
      "counter",
      { term: tell("zeus", "altar", 140) },
      false,
    ),
    expectedRevisions: [original],
  });
  expect(world.rejected()).toEqual(["stale-target"]);
  expect(world.thread()).toMatchObject({
    status: "countered",
    offeredBy: "zeus",
  });

  // Control: pinned to the revision she can now see, her answer commits.
  world.tick(move(world, "hera", "accept"));
  expect(world.rejected()).toEqual([]);
  expect(world.thread().status).toBe("accepted");
});

test("a move on a closed thread is malformed, and so is one on a thread id the world never held", () => {
  const { world, thread } = opened();
  world.tick(move(world, "zeus", "refuse"));
  const outcome = validateProposal(world.state, {
    schemaVersion: 1,
    actor: id("zeus"),
    targets: [],
    expectedRevisions: [],
    source: "fixture",
    observationId: "obs-x" as never,
    kind: "practice",
    move: "accept",
    thread: thread.id,
  });
  expect(outcome).toMatchObject({ ok: false, reason: "malformed" });
  world.tick({
    actor: "zeus",
    kind: "practice",
    move: "accept",
    thread: "evt-404",
  });
  expect(world.rejected()).toEqual(["malformed"]);
});

test("a practice move holds its actor's one action slot for the tick", () => {
  const { world } = opened();
  world.tick(
    move(world, "zeus", "counter", { term: tell("zeus", "altar", 120) }),
    { actor: "zeus", kind: "move", to: "square" },
  );
  expect(world.rejected()).toEqual(["busy-actor"]);
});

// --- Replay, codec, catch-up ------------------------------------------------------------------

/** A world with a fulfilled thread, a refused one, an open one, and an accepted one in flight. */
function busyWorld(world = new World()): World {
  const cause = world.hears();
  world.tick(demand(cause));
  world.tick(move(world, "zeus", "accept", { swear: true }));
  world.tick(legend("zeus"));
  const second = world.hears();
  world.tick(demand(second, beAt("zeus", "tavern", 60)));
  const open = world.threads().at(-1);
  if (!open) throw new Error("thread");
  world.tick({
    actor: "zeus",
    kind: "practice",
    move: "refuse",
    thread: open.id,
  });
  const third = world.hears();
  world.tick(demand(third, tell("zeus", "altar", 150)));
  world.tick(
    move(world, "zeus", "counter", { term: tell("zeus", "altar", 120) }),
  );
  return world;
}

test("replaying the log from the initial state rebuilds exactly the live thread map", () => {
  const world = busyWorld();
  expect(world.threads().map((t) => t.status)).toEqual([
    "fulfilled",
    "refused",
    "countered",
  ]);
  const rebuilt = applyEvents(world.initial, world.log);
  expect(encode(rebuilt).threads).toEqual(encode(world.state).threads);
  expect(rebuilt.threads).toEqual(world.state.threads);
});

test("the codec round-trips threads through JSON, and decode refuses a thread that names an unknown actor or disagrees with its own key", () => {
  const world = busyWorld();
  const stored = JSON.parse(JSON.stringify(encode(world.state)));
  const decoded = decode(stored);
  expect(decoded.threads).toEqual(world.state.threads);
  expect(encode(decoded)).toEqual(encode(world.state));

  const corrupt = (change: (entry: Record<string, unknown>) => void) => {
    const copy = JSON.parse(JSON.stringify(stored));
    change(copy.threads[0][1]);
    return copy;
  };
  expect(() =>
    decode(
      corrupt((t) => {
        t.demander = "nobody";
      }),
    ),
  ).toThrow();
  expect(() =>
    decode(
      corrupt((t) => {
        t.id = "evt-404";
      }),
    ),
  ).toThrow();
  expect(() =>
    decode(
      corrupt((t) => {
        t.status = "pondering";
      }),
    ),
  ).toThrow();
  expect(() =>
    decode(
      corrupt((t) => {
        delete t.acceptance;
      }),
    ),
  ).toThrow();
  const missing = JSON.parse(JSON.stringify(stored));
  delete missing.threads;
  expect(() => decode(missing)).toThrow();
});

test("a successor links the closed thread it follows from; the link bumps that thread's revision and never reopens it", () => {
  const { world, thread, cause } = opened();
  world.tick(move(world, "zeus", "refuse"));
  const closed = world.thread();
  const next = world.apply({
    kind: "practice-opened",
    entityId: "hera",
    practice: "settlement",
    counterparty: "zeus",
    causes: [cause],
    term: tell("zeus", "altar", 100),
    negotiationDeadline: 99,
    counterBudget: 2,
    succeeds: thread.id,
  });
  const linked = world.state.threads.get(thread.id);
  expect(linked).toMatchObject({ status: "refused", successor: next.id });
  expect(linked?.revision).toBe(closed.revision + 1);
  expect(world.state.threads.get(next.id as EventId)?.status).toBe("open");
  const rebuilt = applyEvents(world.initial, world.log);
  expect(rebuilt.threads).toEqual(world.state.threads);
});

test("a deadline crossed during catch-up breaches exactly as live: same ruling, same tick", () => {
  const live = new World();
  const catchUp = new World({}, { approximate: true, elapsedMs: 60_000 });
  for (const world of [live, catchUp]) {
    accepted(tell("zeus", "altar", 20), world);
    world.until(() => world.thread().status !== "accepted");
  }
  const rulings = (world: World) =>
    world.ended().map((e) => [e.outcome, e.reason, e.tick, e.threadId]);
  expect(rulings(catchUp)).toEqual(rulings(live));
  expect(rulings(live)).toHaveLength(1);
  expect(catchUp.ended().every((e) => e.approximate)).toBe(true);
  expect(live.ended().every((e) => !e.approximate)).toBe(true);
  // The same holds for a negotiation that lapses.
  const slowLive = new World();
  const slowCatchUp = new World({}, { approximate: true, elapsedMs: 60_000 });
  for (const world of [slowLive, slowCatchUp]) {
    opened(tell("zeus", "altar"), world);
    world.until(() => world.thread().status !== "open");
  }
  expect(rulings(slowCatchUp)).toEqual(rulings(slowLive));
  expect(slowLive.ended()[0]?.outcome).toBe("expired");
});

test("the tunables default when the pack states none, and the pack's own values win", async () => {
  const { DEFAULT_PRACTICE_BALANCE, practiceBalanceOf } = await import(
    "./practices"
  );
  const bare = createInitialWorldState({
    ...pack(),
    rules: { ...pack().rules, practiceBalance: undefined },
  });
  for (const key of [
    "negotiationTicks",
    "counterBudget",
    "minTermTicks",
    "maxTermTicks",
  ]) {
    expect(practiceBalanceOf(bare.rules, key)).toBe(
      DEFAULT_PRACTICE_BALANCE[key] as number,
    );
    expect(DEFAULT_PRACTICE_BALANCE[key]).toBeGreaterThan(0);
  }
  expect(practiceBalanceOf(new World().state.rules, "negotiationTicks")).toBe(
    40,
  );
  expect(DEFAULT_PRACTICE_BALANCE.minTermTicks).toBeLessThan(
    DEFAULT_PRACTICE_BALANCE.maxTermTicks as number,
  );
});

test("a ruling joins its tick's events without a gap in the sequence, caused by the tick and not by any proposal", () => {
  const world = busyWorld();
  const sequences = world.log.map((e) => e.sequence);
  expect(sequences).toEqual(sequences.map((_, index) => index + 1));
  expect(world.ended()).toHaveLength(1);
  for (const event of world.ended()) {
    expect(String(event.causationId)).toBe(`tick-${event.tick}`);
    expect(String(event.correlationId)).toBe(`tick-${event.tick}`);
  }
});

// --- Endings change the gods ------------------------------------------------------------------
//
// Every ending leaves something behind that outlasts the thread: a feeling, a
// penalty, a form, a record of standing, an alliance. They are primary events
// of the tick that ended the thread, so the gods remember them that same tick.

type MotifApplied = Extract<WorldEvent, { kind: "motif-applied" }>;

const motifs = (world: World): MotifApplied[] =>
  world.log.filter((e): e is MotifApplied => e.kind === "motif-applied");

/** What `who` remembers of threads ending: a witnessed memory of a ruling or of a refusal or withdrawal. */
const endingMemories = (world: World, who: string) =>
  getMemories(world.state, id(who)).filter(
    (m) =>
      m.kind === "witnessed" &&
      (m.eventKind === "practice-ended" || m.eventKind === "practice-moved"),
  );

const breached = (world: World) => world.thread().status === "breached";

test("a sworn breach applies the bounded oath penalty to the one who swore, and records the motif, the breach, and the cause; the period without Olympus ends (AE2, R15)", () => {
  const world = new World({ oathDivinityLoss: 3, oathAccessTicks: 50 });
  const { thread } = opened(tell("zeus", "altar", 20), world);
  world.tick(move(world, "zeus", "accept", { swear: true }));
  world.until(() => breached(world));

  const [ended] = world.ended();
  expect(ended).toMatchObject({
    outcome: "breached",
    reason: "obligation-deadline",
    threadId: thread.id,
  });
  const penalty = motifs(world).find((m) => m.effect === "oath-penalty");
  expect(penalty).toMatchObject({
    entityId: "zeus",
    motif: "oath-penalty",
    threadId: thread.id,
    cause: ended?.id,
    divinityLost: 3,
    capability: "divine",
    accessRestoredAt: (ended?.tick ?? 0) + 50,
    tick: ended?.tick,
  });
  // A primary event of the breach's own tick, caused by the tick and not by a proposal.
  expect(world.last?.environmentEvents.map((e) => e.id)).toContain(penalty?.id);
  expect(String(penalty?.causationId)).toBe(`tick-${ended?.tick}`);

  const zeus = getActor(world.state, id("zeus"));
  expect(zeus?.inventory.get("divinity")).toBe(7);
  expect(zeus?.capabilities).not.toContain("divine");
  expect(zeus?.withheld).toMatchObject([
    {
      capability: "divine",
      restoreAt: (ended?.tick ?? 0) + 50,
      eventId: penalty?.id,
    },
  ]);
  // Hera swore nothing and keeps hers.
  expect(getActor(world.state, id("hera"))?.capabilities).toContain("divine");

  // The period without Olympus: the gate is shut to him.
  world.place("zeus", "square");
  world.tick({ actor: "zeus", kind: "move", to: "gate" });
  expect(world.rejected()).toEqual(["restricted-realm"]);
  expect(getActor(world.state, id("zeus"))?.locationId).toBe(id("square"));

  // And it ends, by an event the world records.
  world.until(
    () =>
      getActor(world.state, id("zeus"))?.capabilities.includes("divine") ===
      true,
  );
  const restored = world.log.find((e) => e.kind === "access-restored");
  expect(restored).toMatchObject({
    entityId: "zeus",
    capability: "divine",
    motifEventId: penalty?.id,
    tick: (ended?.tick ?? 0) + 50,
  });
  expect(getActor(world.state, id("zeus"))?.withheld ?? []).toEqual([]);
  world.tick({ actor: "zeus", kind: "move", to: "gate" });
  expect(getActor(world.state, id("zeus"))?.locationId).toBe(id("gate"));
});

test("a breach not sworn costs a grudge and standing at the term's place, never the oath penalty; the breach is in both gods' memories the tick it happens", () => {
  const world = new World({ oathDivinityLoss: 3 });
  const { thread } = accepted(tell("zeus", "altar", 20), world);
  expect(world.thread().acceptance?.sworn).toBe(false);
  world.until(() => breached(world));
  const [ended] = world.ended();
  const breachTick = world.state.tick;

  expect(motifs(world)).toMatchObject([
    {
      entityId: "zeus",
      motif: "standing-lost",
      effect: "standing",
      place: "altar",
      delta: -1,
      threadId: thread.id,
      cause: ended?.id,
    },
  ]);
  const zeus = getActor(world.state, id("zeus"));
  expect(zeus?.inventory.get("divinity")).toBe(10);
  expect(zeus?.capabilities).toContain("divine");
  expect(zeus?.withheld).toBeUndefined();

  // Hera was wronged: affinity down, a grudge. Zeus feels nothing about his own act.
  expect(getRelationship(world.state, id("hera"), id("zeus"))).toMatchObject({
    affinity: -2,
    grudge: 1,
    allied: false,
  });
  expect(getRelationship(world.state, id("zeus"), id("hera"))).toBeUndefined();

  // Both remember it, from events of the same tick.
  const remembered = world.log.filter(
    (e) => e.kind === "memory-recorded" && e.sourceEventId === ended?.id,
  );
  expect(remembered.map((e) => [String(e.entityId), e.tick])).toEqual([
    ["hera", breachTick],
    ["zeus", breachTick],
  ]);
  for (const who of ["hera", "zeus"]) {
    expect(endingMemories(world, who).at(-1)).toMatchObject({
      kind: "witnessed",
      eventKind: "practice-ended",
      sourceEventId: ended?.id,
      subjects: ["hera", "zeus"],
      consequence: { effect: "harm", agent: "zeus", target: "hera" },
    });
  }
});

test("a fulfilment raises the demander's affinity toward the one who performed, and records the performer's standing at the place", () => {
  const { world, thread } = accepted();
  world.tick(legend("zeus"));
  expect(world.thread().status).toBe("fulfilled");
  expect(getRelationship(world.state, id("hera"), id("zeus"))).toMatchObject({
    affinity: 1,
    grudge: 0,
  });
  expect(motifs(world)).toMatchObject([
    {
      entityId: "zeus",
      motif: "standing-won",
      effect: "standing",
      place: "altar",
      delta: 1,
      threadId: thread.id,
      cause: world.ended()[0]?.id,
    },
  ]);
  for (const who of ["hera", "zeus"]) {
    expect(endingMemories(world, who)).toHaveLength(1);
  }
});

test("a refusal lowers the demander's affinity toward the refuser and leaves no grudge; both remember it, and the refuser who answers a counter is felt toward the same way (AE1)", () => {
  const { world } = opened();
  const refusal = world.tick(move(world, "zeus", "refuse"));
  const refused = refusal.events.find((e) => e.kind === "practice-moved");
  expect(getRelationship(world.state, id("hera"), id("zeus"))).toMatchObject({
    affinity: -1,
    grudge: 0,
  });
  expect(getRelationship(world.state, id("zeus"), id("hera"))).toBeUndefined();
  for (const who of ["hera", "zeus"]) {
    expect(endingMemories(world, who)).toMatchObject([
      { eventKind: "practice-moved", sourceEventId: refused?.id },
    ]);
  }
  expect(motifs(world)).toEqual([]);

  // Hera refuses Zeus's counter instead: now Zeus is the one let down.
  const counter = opened(tell("zeus", "altar"), new World());
  counter.world.tick(
    move(counter.world, "zeus", "counter", { term: tell("zeus", "altar", 80) }),
  );
  counter.world.tick(move(counter.world, "hera", "refuse"));
  expect(
    getRelationship(counter.world.state, id("zeus"), id("hera")),
  ).toMatchObject({ affinity: -1, grudge: 0 });
  expect(
    getRelationship(counter.world.state, id("hera"), id("zeus")),
  ).toBeUndefined();
});

test("an expiry and a death change no feeling: the closed thread and each living party's memory of it are what outlast it", () => {
  const lapse = opened().world;
  lapse.until(() => lapse.thread().status === "expired");
  expect(endingMemories(lapse, "hera")).toHaveLength(1);
  expect(endingMemories(lapse, "zeus")).toHaveLength(1);
  expect(lapse.state.relationships.size).toBe(0);
  expect(motifs(lapse)).toEqual([]);

  const death = accepted(tell("zeus", "altar", 50)).world;
  death.kill("zeus");
  death.tick();
  expect(death.thread().status).toBe("withdrawn");
  expect(endingMemories(death, "hera")).toHaveLength(1);
  // The dead remember nothing.
  expect(endingMemories(death, "zeus")).toEqual([]);
  expect(death.state.relationships.size).toBe(0);
  expect(motifs(death)).toEqual([]);
});

test("only the god who must perform may swear: the beneficiary accepting a counter cannot swear it, and a party the counter shifted the duty to can", () => {
  const { world } = opened();
  world.tick(
    move(world, "zeus", "counter", { term: tell("zeus", "altar", 80) }),
  );
  world.tick(move(world, "hera", "accept", { swear: true }));
  expect(world.rejected()).toEqual(["unauthorized-claim"]);
  expect(world.thread().status).toBe("countered");
  world.tick(move(world, "hera", "accept"));
  expect(world.thread()).toMatchObject({
    status: "accepted",
    acceptance: { sworn: false },
  });

  // Zeus counters that Hera tell the legend; she is then the one bound, and may swear.
  const shifted = opened().world;
  shifted.tick(
    move(shifted, "zeus", "counter", { term: tell("hera", "altar", 80) }),
  );
  shifted.tick(move(shifted, "hera", "accept", { swear: true }));
  expect(shifted.thread()).toMatchObject({
    status: "accepted",
    acceptance: { sworn: true },
  });
  // The penalty falls on Hera, who swore, when she does not perform.
  shifted.until(() => breached(shifted));
  expect(motifs(shifted).map((m) => [String(m.entityId), m.motif])).toEqual([
    ["hera", "oath-penalty"],
    ["hera", "standing-lost"],
  ]);
  expect(getRelationship(shifted.state, id("zeus"), id("hera"))).toMatchObject({
    grudge: 1,
  });
});

test("a breach whose stake is a transformation changes the breacher's form and capabilities, names its cause, and keeps his memories, relationships, and identity (R18, AE9)", () => {
  const world = new World();
  const told = world.hears("zeus");
  const cause = world.hears();
  world.apply({
    kind: "relationship-changed",
    entityId: "zeus",
    toward: "athena",
    affinityDelta: 3,
    grudgeDelta: 0,
    memoryEventId: told,
  });
  const open = world.apply({
    kind: "practice-opened",
    entityId: "hera",
    practice: "settlement",
    counterparty: "zeus",
    causes: [cause],
    term: {
      kind: "tell-legend",
      party: "zeus",
      place: "altar",
      deadline: world.state.tick + 20,
    },
    negotiationDeadline: world.state.tick + 40,
    counterBudget: 2,
    stake: {
      form: "stag",
      capabilitiesGained: ["beast"],
      capabilitiesLost: ["divine"],
    },
  });
  world.tick(move(world, "zeus", "accept"));
  world.until(() => breached(world));

  const [ended] = world.ended();
  const change = motifs(world).find((m) => m.effect === "transformation");
  expect(change).toMatchObject({
    entityId: "zeus",
    motif: "transformation-punishment",
    intent: "punishment",
    form: "stag",
    capabilitiesGained: ["beast"],
    capabilitiesLost: ["divine"],
    threadId: open.id,
    cause: ended?.id,
  });
  const zeus = getActor(world.state, id("zeus"));
  expect(zeus).toMatchObject({ id: "zeus", isDeity: true, form: "stag" });
  expect(zeus?.capabilities).toEqual(["beast"]);
  // Identity, memory, and relationships stay with the actor.
  expect(
    getMemories(world.state, id("zeus")).some((m) => m.kind === "told"),
  ).toBe(true);
  expect(getRelationship(world.state, id("zeus"), id("athena"))).toMatchObject({
    affinity: 3,
  });
  expect(getRelationship(world.state, id("hera"), id("zeus"))).toMatchObject({
    grudge: 1,
  });
});

test("a transformation, wherever it comes from, bumps the actor's revision so its pending proposal goes stale, and touches nothing it did not name", () => {
  const world = new World();
  const zeus = getActor(world.state, id("zeus"));
  const pending = {
    actor: "zeus",
    kind: "move",
    to: "square",
    expectedRevisions: [{ entityId: "zeus", revision: zeus?.revision ?? 0 }],
  };
  world.apply({
    kind: "motif-applied",
    entityId: "zeus",
    motif: "transformation-mercy",
    threadId: "evt-0-1",
    cause: "evt-0-1",
    effect: "transformation",
    intent: "mercy",
    form: "laurel",
    capabilitiesGained: [],
    capabilitiesLost: [],
  });
  const changed = getActor(world.state, id("zeus"));
  expect(changed).toMatchObject({
    form: "laurel",
    revision: (zeus?.revision ?? 0) + 1,
  });
  expect(changed?.capabilities).toEqual(zeus?.capabilities);
  expect(changed?.inventory).toEqual(zeus?.inventory);
  expect(getActor(world.state, id("hera"))?.form).toBeUndefined();
  world.tick(pending);
  expect(world.rejected()).toEqual(["stale-target"]);
  expect(getActor(world.state, id("zeus"))?.locationId).toBe(id("altar"));
});

test("only a sealed settlement makes an alliance: the ally term is sealed when accepted, in both directions, and binds only the two gods (R19, AE11)", () => {
  const world = new World();
  const cause = world.hears();
  const ally = (to: string, party = "zeus") => ({
    kind: "ally",
    party,
    to,
    deadlineTicks: 50,
  });
  // No third god's cooperation is promised, and no god allies with itself.
  world.tick(demand(cause, ally("athena")));
  expect(world.rejected()).toEqual(["unauthorized-claim"]);
  world.tick(demand(cause, ally("zeus")));
  expect(world.rejected()).toEqual(["unauthorized-claim"]);

  world.tick(demand(cause, ally("hera")));
  expect(world.thread().status).toBe("open");
  expect(
    getRelationship(world.state, id("hera"), id("zeus"))?.allied ?? false,
  ).toBe(false);

  const sealing = world.tick(move(world, "zeus", "accept"));
  expect(world.thread().status).toBe("fulfilled");
  expect(world.ended()).toMatchObject([
    { outcome: "fulfilled", reason: "sealed" },
  ]);
  const changes = sealing.derivedEvents.filter(
    (e) => e.kind === "relationship-changed" && e.allied === true,
  );
  expect(
    changes.map((e) => [
      e.entityId,
      e.kind === "relationship-changed" ? e.toward : "",
    ]),
  ).toEqual([
    ["hera", "zeus"],
    ["zeus", "hera"],
  ]);
  expect(getRelationship(world.state, id("hera"), id("zeus"))?.allied).toBe(
    true,
  );
  expect(getRelationship(world.state, id("zeus"), id("hera"))?.allied).toBe(
    true,
  );
  // Athena, who sealed nothing, is allied with no one.
  expect(
    [...world.state.relationships.values()].filter((r) => r.allied),
  ).toHaveLength(2);
});

test("an ally term is refused when one of its gods is dead, and a settlement over it with a dead party ends withdrawn, sealing nothing", () => {
  const world = new World();
  const cause = world.hears();
  world.tick(
    demand(cause, {
      kind: "ally",
      party: "zeus",
      to: "hera",
      deadlineTicks: 50,
    }),
  );
  world.kill("hera");
  world.tick(move(world, "zeus", "accept"));
  expect(world.rejected()).toEqual(["dead-actor"]);
  world.tick();
  expect(world.thread().status).toBe("withdrawn");
  expect([...world.state.relationships.values()].some((r) => r.allied)).toBe(
    false,
  );
});

test("penalties, forms, stakes, and alliances replay from the log and survive a JSON round trip", () => {
  const world = new World({ oathDivinityLoss: 3, oathAccessTicks: 50 });
  const cause = world.hears();
  const open = world.apply({
    kind: "practice-opened",
    entityId: "hera",
    practice: "settlement",
    counterparty: "zeus",
    causes: [cause],
    term: {
      kind: "tell-legend",
      party: "zeus",
      place: "altar",
      deadline: world.state.tick + 20,
    },
    negotiationDeadline: world.state.tick + 40,
    counterBudget: 2,
    stake: {
      form: "stag",
      capabilitiesGained: ["beast"],
      capabilitiesLost: [],
    },
  });
  world.tick(move(world, "zeus", "accept", { swear: true }));
  world.until(() => breached(world));
  expect(world.state.threads.get(open.id as EventId)?.stake).toMatchObject({
    form: "stag",
  });
  // The thread's stake and the god's penalty are all there before the access returns.
  const zeus = getActor(world.state, id("zeus"));
  expect(zeus?.form).toBe("stag");
  expect(zeus?.withheld).toHaveLength(1);

  for (const phase of ["mid-penalty", "restored"]) {
    if (phase === "restored") {
      world.until(
        () => getActor(world.state, id("zeus"))?.withheld === undefined,
      );
    }
    const rebuilt = applyEvents(world.initial, world.log);
    expect(rebuilt.actors).toEqual(world.state.actors);
    expect(rebuilt.threads).toEqual(world.state.threads);
    expect(rebuilt.memories).toEqual(world.state.memories);
    expect(rebuilt.relationships).toEqual(world.state.relationships);
    const stored = JSON.parse(JSON.stringify(encode(world.state)));
    const decoded = decode(stored);
    expect(decoded.actors).toEqual(world.state.actors);
    expect(decoded.threads).toEqual(world.state.threads);
    expect(encode(decoded)).toEqual(encode(world.state));
  }

  // A stored penalty that names no capability, or a form that is not a word, is corrupt.
  const stored = JSON.parse(JSON.stringify(encode(world.state)));
  const zeusEntry = stored.actors.find(
    (entry: [string, unknown]) => entry[0] === "zeus",
  );
  zeusEntry[1].form = 7;
  expect(() => decode(stored)).toThrow();
});
