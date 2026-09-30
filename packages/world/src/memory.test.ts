import { expect, test } from "bun:test";
import {
  type ContentPack,
  causalChain,
  type EventId,
  type Proposal,
  type WorldEvent,
} from "@panthea/contracts";
import { applyEvent, applyEvents, runTick, submitProposal } from "./actions";
import { decode, encode } from "./codec";
import { getMemories, getRelationship } from "./memory";
import { perceive } from "./perception";
import {
  createInitialWorldState,
  createPrng,
  type MemoryEntry,
  type PrngState,
  toEntityId,
  type WorldState,
} from "./state";

const id = toEntityId;

function pack(memoryBalance?: Record<string, number>): ContentPack {
  return {
    schemaVersion: 1,
    realms: ["mortal"],
    resources: [],
    locations: [
      {
        id: "tavern",
        realm: "mortal",
        name: "The Tavern",
        edges: [{ to: "square", transport: "path", bidirectional: true }],
      },
      {
        id: "square",
        realm: "mortal",
        name: "The Square",
        edges: [{ to: "grove", transport: "path", bidirectional: true }],
      },
      { id: "grove", realm: "mortal", name: "The Grove", edges: [] },
    ],
    buildings: [
      {
        id: "the-tavern",
        locationId: "tavern",
        name: "The Tavern House",
        material: "wood",
        combustible: true,
        services: ["drink"],
        inventory: [],
        owner: "farmer",
      },
      {
        id: "old-oak",
        locationId: "square",
        name: "The Old Oak",
        material: "wood",
        combustible: true,
        services: [],
        inventory: [],
      },
    ],
    inhabitants: [
      {
        id: "zeus",
        name: "Zeus",
        locationId: "tavern",
        deity: true,
        startingInventory: [{ resource: "divinity", amount: 100 }],
      },
      { id: "farmer", name: "The Farmer", locationId: "tavern" },
      { id: "bard", name: "The Bard", locationId: "tavern" },
      {
        id: "hera",
        name: "Hera",
        locationId: "square",
        deity: true,
        startingInventory: [{ resource: "divinity", amount: 10 }],
      },
      { id: "woodcutter", name: "The Woodcutter", locationId: "square" },
    ],
    rules: {
      catchUpCapMs: 0,
      catchUpChunkMs: 0,
      checkpointIntervalMs: 0,
      maxProposalsPerTick: 100,
      fireBalance: {
        igniteThreshold: 3,
        intensityGrowthPerTick: 1,
        destroyIntensity: 6,
      },
      economyBalance: { worshipCapacityGain: 1, favorDurationTicks: 5 },
      ...(memoryBalance === undefined ? {} : { memoryBalance }),
    },
    recipes: {},
  };
}

let observations = 0;

function propose(raw: Record<string, unknown>): Proposal {
  observations += 1;
  const submitted = submitProposal({
    schemaVersion: 1,
    targets: [],
    expectedRevisions: [],
    source: "fixture",
    observationId: `obs-${observations}`,
    ...raw,
  });
  if (!submitted.ok) {
    throw new Error(`fixture proposal failed: ${submitted.rejection.message}`);
  }
  return submitted.proposal;
}

const strike = (actor: string, target: string, power = 3) =>
  propose({ actor, kind: "strike", target, power });
const move = (actor: string, to: string) =>
  propose({ actor, kind: "move", to });
const report = (
  actor: string,
  listener: string,
  content: string,
  linkedEventId?: string,
) =>
  propose({
    actor,
    kind: "report",
    listener,
    content,
    ...(linkedEventId === undefined ? {} : { linkedEventId }),
  });
const worship = (actor: string, deity: string) =>
  propose({ actor, kind: "worship", deity });

/** A world that keeps every committed event, so a test can rebuild it or walk a chain from the log alone. */
class World {
  state: WorldState;
  prng: PrngState = createPrng(1);
  readonly log: WorldEvent[] = [];
  readonly initial: WorldState;
  lastRejected: readonly { readonly reason: string }[] = [];

  constructor(memoryBalance?: Record<string, number>) {
    this.initial = createInitialWorldState(pack(memoryBalance));
    this.state = this.initial;
  }

  /** Runs one tick; returns what it produced. */
  tick(...queue: Proposal[]) {
    const result = runTick(this.state, this.prng, queue);
    this.state = result.state;
    this.prng = result.prng;
    this.log.push(...result.events);
    this.lastRejected = result.rejected;
    return result;
  }

  event(eventId: EventId): WorldEvent | undefined {
    return this.log.find((event) => event.id === eventId);
  }

  memories(actor: string): readonly MemoryEntry[] {
    return getMemories(this.state, id(actor));
  }
}

function ofKind<K extends WorldEvent["kind"]>(
  events: readonly WorldEvent[],
  kind: K,
): Extract<WorldEvent, { kind: K }>[] {
  return events.filter(
    (event): event is Extract<WorldEvent, { kind: K }> => event.kind === kind,
  );
}

function ignitionOf(events: readonly WorldEvent[], building: string) {
  const found = ofKind(events, "building-ignited").find(
    (event) => event.entityId === building,
  );
  if (!found) throw new Error(`no ignition of ${building}`);
  return found;
}

function witnessed(
  world: World,
  actor: string,
  sourceEventId: EventId,
): MemoryEntry | undefined {
  return world
    .memories(actor)
    .find(
      (memory) =>
        memory.kind === "witnessed" && memory.sourceEventId === sourceEventId,
    );
}

// --- Witnessing -----------------------------------------------------------------

test("Zeus strikes the tavern: co-located witnesses remember it with the event id; the absent god and the woodcutter do not", () => {
  const world = new World();
  const tick = world.tick(strike("zeus", "the-tavern"));
  const ignition = ignitionOf(tick.events, "the-tavern");

  for (const witness of ["zeus", "farmer", "bard"]) {
    const memory = witnessed(world, witness, ignition.id);
    expect(memory).toMatchObject({
      kind: "witnessed",
      eventKind: "building-ignited",
      sourceEventId: ignition.id,
      consequence: { effect: "harm", agent: "zeus", target: "farmer" },
    });
    expect(memory?.subjects).toContain(id("the-tavern"));
  }
  // Hera and the woodcutter stood in the square.
  expect(world.memories("hera")).toEqual([]);
  expect(world.memories("woodcutter")).toEqual([]);
});

test("positive control: the same strike is remembered by a god who stood at the tavern instead", () => {
  const world = new World();
  world.tick(move("hera", "tavern"));
  const tick = world.tick(strike("zeus", "the-tavern"));
  const ignition = ignitionOf(tick.events, "the-tavern");
  expect(witnessed(world, "hera", ignition.id)).toBeDefined();
});

test("derived memory events are committed with the tick, after the primary events they cite, each caused by the event it rests on", () => {
  const world = new World();
  const tick = world.tick(strike("zeus", "the-tavern"));
  const ignition = ignitionOf(tick.events, "the-tavern");

  const memoryEvents = ofKind(tick.events, "memory-recorded");
  expect(memoryEvents.map((event) => event.entityId).sort()).toEqual(
    ["bard", "farmer", "zeus"].map(id),
  );
  const lastPrimary = Math.max(
    ...tick.events
      .filter(
        (event) =>
          event.kind !== "memory-recorded" &&
          event.kind !== "relationship-changed",
      )
      .map((event) => event.sequence),
  );
  for (const event of memoryEvents) {
    expect(event.sequence).toBeGreaterThan(lastPrimary);
    expect(event.sourceEventId).toBe(ignition.id);
    expect(event.causationId as string).toBe(ignition.id as string);
    expect(event.correlationId as string).toBe(`tick-${tick.state.tick}`);
  }
  // The tick's events are one contiguous run, and each memory is named by its event.
  expect(tick.events.map((event) => event.sequence)).toEqual(
    tick.events.map((_, index) => tick.events[0].sequence + index),
  );
  for (const event of memoryEvents) {
    expect(
      world.memories(event.entityId).some((memory) => memory.id === event.id),
    ).toBe(true);
  }
});

test("a proposal's own observation caused only its own events: derived events never share it", () => {
  const world = new World();
  const proposal = strike("zeus", "the-tavern");
  const tick = world.tick(proposal);
  const caused = tick.events.filter(
    (event) =>
      (event.correlationId as string) === String(proposal.observationId),
  );
  expect(caused.map((event) => event.kind)).toEqual([
    "resource-consumed",
    "building-ignited",
  ]);
});

test("presence follows the actor's own moves within the tick, not where it stands at commit", () => {
  // The farmer walks to the square after the strike: at commit he is away, but
  // he was there when it happened. The woodcutter walks into the tavern after
  // it: at commit he is there, but he was not.
  const world = new World();
  const tick = world.tick(
    strike("zeus", "the-tavern"),
    move("farmer", "square"),
    move("woodcutter", "tavern"),
  );
  const ignition = ignitionOf(tick.events, "the-tavern");
  expect(world.state.actors.get(id("farmer"))?.locationId).toBe(id("square"));
  expect(world.state.actors.get(id("woodcutter"))?.locationId).toBe(
    id("tavern"),
  );
  expect(witnessed(world, "farmer", ignition.id)).toBeDefined();
  expect(witnessed(world, "woodcutter", ignition.id)).toBeUndefined();
  expect(witnessed(world, "bard", ignition.id)).toBeDefined();
});

test("positive control: the same two moves made before the strike reverse who remembers it", () => {
  const world = new World();
  const tick = world.tick(
    move("farmer", "square"),
    move("woodcutter", "tavern"),
    strike("zeus", "the-tavern"),
  );
  const ignition = ignitionOf(tick.events, "the-tavern");
  expect(witnessed(world, "farmer", ignition.id)).toBeUndefined();
  expect(witnessed(world, "woodcutter", ignition.id)).toBeDefined();
});

test("Zeus remembers a strike after he has left the place: what perception no longer shows, memory keeps", () => {
  const world = new World();
  const struck = world.tick(strike("zeus", "the-tavern"));
  const ignition = ignitionOf(struck.events, "the-tavern");
  world.tick(move("zeus", "square"));

  const snapshot = perceive(world.state, id("zeus"), world.log);
  expect(snapshot?.events.map((event) => event.id)).not.toContain(ignition.id);
  expect(witnessed(world, "zeus", ignition.id)).toBeDefined();
  // The woodcutter never went to the tavern, and has no such memory.
  expect(witnessed(world, "woodcutter", ignition.id)).toBeUndefined();
});

test("memory and perception share one presence rule: whoever perceives an event after the tick remembers it", () => {
  const world = new World();
  const tick = world.tick(strike("zeus", "the-tavern"));
  const ignition = ignitionOf(tick.events, "the-tavern");
  for (const actor of ["zeus", "farmer", "bard", "hera", "woodcutter"]) {
    const perceives =
      perceive(world.state, id(actor), tick.events)?.events.some(
        (event) => event.id === ignition.id,
      ) ?? false;
    expect(witnessed(world, actor, ignition.id) !== undefined).toBe(perceives);
  }
});

test("routine happenings leave no memory: only events with salience are remembered", () => {
  const world = new World();
  const tick = world.tick(
    move("farmer", "square"),
    propose({
      actor: "woodcutter",
      kind: "gather",
      resource: "wood",
      amount: 1,
    }),
  );
  // The gather is rejected (the woodcutter gathers nothing), the move commits: neither is memorable.
  expect(ofKind(tick.events, "memory-recorded")).toEqual([]);
  expect(world.state.memories.size).toBe(0);
});

test("burn ticks are not remembered, but the destruction is, by whoever is present, blaming the striker", () => {
  const world = new World();
  const struck = world.tick(strike("zeus", "the-tavern"));
  world.tick(move("bard", "square"));
  let destroyed:
    | Extract<WorldEvent, { kind: "building-destroyed" }>
    | undefined;
  for (let guard = 0; guard < 10 && destroyed === undefined; guard += 1) {
    destroyed = ofKind(world.tick().events, "building-destroyed")[0];
  }
  if (!destroyed) throw new Error("the tavern never burned down");

  expect(ofKind(world.log, "building-burn-ticked").length).toBeGreaterThan(0);
  const remembered = new Set(
    ofKind(world.log, "memory-recorded").flatMap((event) =>
      event.memoryKind === "witnessed" ? [event.eventKind] : [],
    ),
  );
  expect(remembered.has("building-burn-ticked")).toBe(false);
  expect(remembered.has("building-destroyed")).toBe(true);

  // Present at the destruction: Zeus and the farmer. The bard had gone to the square.
  const atDestruction = (actor: string) =>
    witnessed(world, actor, destroyed.id);
  expect(atDestruction("zeus")).toBeDefined();
  expect(atDestruction("farmer")).toMatchObject({
    consequence: { effect: "harm", agent: "zeus", target: "farmer" },
  });
  expect(atDestruction("bard")).toBeUndefined();
  // He did see the strike itself.
  expect(
    witnessed(world, "bard", ignitionOf(struck.events, "the-tavern").id),
  ).toBeDefined();
});

// --- Reports and beliefs -----------------------------------------------------------

/** The farmer saw the strike, walks to the square, and tells Hera. */
function reportedToHera(content: string, cite: boolean) {
  const world = new World();
  const struck = world.tick(strike("zeus", "the-tavern"));
  const ignition = ignitionOf(struck.events, "the-tavern");
  world.tick(move("farmer", "square"));
  const told = world.tick(
    report("farmer", "hera", content, cite ? ignition.id : undefined),
  );
  return { world, ignition, told };
}

test("a witness tells Hera an inaccurate account: her belief is attributed to the witness and differs from the event; an uninformed third character has nothing", () => {
  const content = "Zeus burned the whole agora to ashes";
  const { world, ignition, told } = reportedToHera(content, true);
  expect(world.lastRejected).toEqual([]);

  const reported = ofKind(told.events, "report-told")[0];
  expect(reported).toMatchObject({
    entityId: "farmer",
    listenerId: "hera",
    content,
    linkedEventId: ignition.id,
  });

  const belief = world.memories("hera").find((m) => m.kind === "told");
  expect(belief).toMatchObject({
    kind: "told",
    teller: "farmer",
    content,
    linkedEventId: ignition.id,
    sourceEventId: reported.id,
  });
  // What was told is not what happened: the event was the tavern, not the agora.
  expect(String(ignition.entityId)).toBe("the-tavern");
  expect(JSON.stringify(ignition)).not.toContain("agora");
  expect(content).toContain("agora");

  // The woodcutter stood in the square too, but was not told.
  expect(world.memories("woodcutter")).toEqual([]);
  // Only Hera formed a belief.
  expect(
    ofKind(told.events, "memory-recorded").map((event) => event.entityId),
  ).toEqual([id("hera")]);
});

test("a belief is not a legend and not a fact: no legend is recorded, and the world state does not change", () => {
  const { world } = reportedToHera("Zeus burned the whole agora", true);
  expect(world.state.legends.size).toBe(0);
  expect(world.state.buildings.get(id("old-oak"))?.status).toBe("operational");
});

test("a report that cites nothing carries a story and no consequence", () => {
  const { world } = reportedToHera("Zeus is up to something", false);
  const belief = world.memories("hera").find((m) => m.kind === "told");
  expect(belief).toMatchObject({ kind: "told", teller: "farmer" });
  expect(belief?.consequence).toBeUndefined();
  expect(belief && "linkedEventId" in belief).toBe(false);
});

test("a citation needs first-hand memory: Hera, told but not there, cannot cite the strike to the woodcutter; the farmer who saw it can", () => {
  const { world, ignition } = reportedToHera("Zeus burned the agora", true);

  world.tick(report("hera", "woodcutter", "It was Zeus", ignition.id));
  expect(world.lastRejected.map((r) => r.reason)).toEqual([
    "unauthorized-claim",
  ]);
  expect(world.memories("woodcutter")).toEqual([]);

  world.tick(report("farmer", "woodcutter", "It was Zeus", ignition.id));
  expect(world.lastRejected).toEqual([]);
  expect(world.memories("woodcutter")).toHaveLength(1);
});

test("a rumor stops at one hop by default: Hera may retell the story, but only as her own uncited account", () => {
  const { world } = reportedToHera("Zeus burned the agora", true);
  world.tick(report("hera", "woodcutter", "I heard Zeus burned the agora"));
  expect(world.lastRejected).toEqual([]);
  const retold = world.memories("woodcutter")[0];
  expect(retold).toMatchObject({ kind: "told", teller: "hera" });
  expect(retold && "linkedEventId" in retold).toBe(false);
  expect(retold?.consequence).toBeUndefined();
});

test("a report to someone elsewhere, to oneself, or to no one is refused; the same report to a neighbor commits", () => {
  const world = new World();
  world.tick(report("farmer", "hera", "hello"));
  expect(world.lastRejected.map((r) => r.reason)).toEqual(["not-adjacent"]);
  world.tick(report("farmer", "farmer", "hello"));
  expect(world.lastRejected.map((r) => r.reason)).toEqual(["malformed"]);
  world.tick(report("farmer", "nobody", "hello"));
  expect(world.lastRejected.map((r) => r.reason)).toEqual(["dead-actor"]);
  expect(world.memories("bard")).toEqual([]);

  world.tick(report("farmer", "bard", "hello"));
  expect(world.lastRejected).toEqual([]);
  expect(world.memories("bard")).toHaveLength(1);
});

// --- Relationships -------------------------------------------------------------------

test("witnessing harm shifts a relationship toward the striker, with a grudge for the one it wronged; the striker has none toward himself", () => {
  const world = new World();
  const tick = world.tick(strike("zeus", "the-tavern"));
  const ignition = ignitionOf(tick.events, "the-tavern");

  // The farmer owns the tavern: harmed personally.
  expect(
    getRelationship(world.state, id("farmer"), id("zeus")) as unknown,
  ).toEqual({
    from: "farmer",
    toward: "zeus",
    affinity: -2,
    grudge: 1,
    allied: false,
  });
  // The bard only watched.
  expect(getRelationship(world.state, id("bard"), id("zeus"))).toMatchObject({
    affinity: -2,
    grudge: 0,
  });
  expect(getRelationship(world.state, id("zeus"), id("zeus"))).toBeUndefined();
  expect(getRelationship(world.state, id("hera"), id("zeus"))).toBeUndefined();

  // Each change names the memory that caused it, and the memory names the strike.
  for (const change of ofKind(tick.events, "relationship-changed")) {
    const memory = ofKind(tick.events, "memory-recorded").find(
      (event) => event.id === change.memoryEventId,
    );
    expect(memory?.entityId).toBe(change.entityId);
    expect(memory?.sourceEventId).toBe(ignition.id);
  }
});

test("Hera's belief shifts her relationship toward Zeus, with the belief as cause", () => {
  const { world, ignition, told } = reportedToHera(
    "Zeus burned the agora",
    true,
  );
  const change = ofKind(told.events, "relationship-changed").find(
    (event) => event.entityId === id("hera"),
  );
  const belief = ofKind(told.events, "memory-recorded").find(
    (event) => event.entityId === id("hera"),
  );
  if (!change || !belief) throw new Error("Hera formed no belief or feeling");
  expect(change).toMatchObject({
    entityId: "hera",
    toward: "zeus",
    affinityDelta: -1,
    grudgeDelta: 0,
    memoryEventId: belief.id,
  });
  expect(getRelationship(world.state, id("hera"), id("zeus"))).toMatchObject({
    affinity: -1,
    grudge: 0,
  });

  // From the log alone: the change, the belief, the report, and the strike.
  const chain = causalChain((eventId) => world.event(eventId), change.id);
  expect(chain.map((event) => event.kind)).toEqual([
    "building-ignited",
    "report-told",
    "memory-recorded",
    "relationship-changed",
  ]);
  expect(String(chain[0]?.id)).toBe(String(ignition.id));
});

test("positive control: an uncited story shifts nothing", () => {
  const { world, told } = reportedToHera("Zeus is up to something", false);
  expect(
    ofKind(told.events, "relationship-changed").filter(
      (event) => event.entityId === id("hera"),
    ),
  ).toEqual([]);
  expect(getRelationship(world.state, id("hera"), id("zeus"))).toBeUndefined();
});

test("affinity is bounded by the world's limit", () => {
  // The bard watches the tavern ignite (-2) and burn down (-2): -4 without a limit.
  const burnDown = (world: World) => {
    world.tick(strike("zeus", "the-tavern"));
    for (let guard = 0; guard < 10; guard += 1) world.tick();
    return getRelationship(world.state, id("bard"), id("zeus"));
  };
  expect(burnDown(new World())?.affinity).toBe(-4);
  expect(burnDown(new World({ affinityLimit: 3 }))?.affinity).toBe(-3);
});

test("kindness raises a god's affinity toward the worshipper, and repeated worship tips it into an alliance that the change reports", () => {
  const world = new World({ allianceAffinity: 2 });
  const first = world.tick(worship("farmer", "zeus"));
  expect(ofKind(first.events, "relationship-changed")).toMatchObject([
    {
      entityId: "zeus",
      toward: "farmer",
      affinityDelta: 1,
      grudgeDelta: 0,
    },
  ]);
  expect(ofKind(first.events, "relationship-changed")[0]).not.toHaveProperty(
    "allied",
  );
  expect(getRelationship(world.state, id("zeus"), id("farmer"))?.allied).toBe(
    false,
  );

  const second = world.tick(worship("farmer", "zeus"));
  expect(ofKind(second.events, "relationship-changed")[0]).toMatchObject({
    affinityDelta: 1,
    allied: true,
  });
  expect(getRelationship(world.state, id("zeus"), id("farmer"))).toMatchObject({
    affinity: 2,
    allied: true,
  });
  // The bard watched the worship but was not served by it: no relationship.
  expect(
    getRelationship(world.state, id("bard"), id("farmer")),
  ).toBeUndefined();
});

test("no tuning makes a report, a memory, or a feeling something a bystander remembers", () => {
  const world = new World({
    "salience_report-told": 9,
    "salience_memory-recorded": 9,
    "salience_relationship-changed": 9,
  });
  world.tick(strike("zeus", "the-tavern"));
  world.tick(move("farmer", "square"));
  world.tick(report("farmer", "hera", "a private word"));
  world.tick();

  const byId = new Map(world.log.map((event) => [event.id, event]));
  for (const event of ofKind(world.log, "memory-recorded")) {
    const source = byId.get(event.sourceEventId)?.kind;
    if (event.memoryKind === "witnessed") {
      expect([
        "memory-recorded",
        "relationship-changed",
        "report-told",
      ]).not.toContain(source);
    }
  }
  // The woodcutter was beside the report and heard nothing.
  expect(world.memories("woodcutter")).toEqual([]);
});

// --- Derivation ------------------------------------------------------------------------

test("a memory event does not produce memories of itself: derived events cite only primary events", () => {
  const { world } = reportedToHera("Zeus burned the agora", true);
  const byId = new Map(world.log.map((event) => [event.id, event]));
  for (const event of ofKind(world.log, "memory-recorded")) {
    const source = byId.get(event.sourceEventId);
    expect(source).toBeDefined();
    expect(source?.kind).not.toBe("memory-recorded");
    expect(source?.kind).not.toBe("relationship-changed");
  }
  for (const event of ofKind(world.log, "relationship-changed")) {
    expect(byId.get(event.memoryEventId)?.kind).toBe("memory-recorded");
  }
  // A report tick: one told memory for the listener, none for anyone else.
  const memoriesOfReport = ofKind(world.log, "memory-recorded").filter(
    (event) => event.memoryKind === "told",
  );
  expect(memoriesOfReport).toHaveLength(1);
});

test("a tick with nothing memorable derives nothing", () => {
  const world = new World();
  const tick = world.tick(move("farmer", "square"));
  expect(
    tick.events.filter(
      (event) =>
        event.kind === "memory-recorded" ||
        event.kind === "relationship-changed",
    ),
  ).toEqual([]);
});

// --- Eviction -----------------------------------------------------------------------------

function memoryEvent(
  sequence: number,
  salience: number,
  owner = "zeus",
): WorldEvent {
  return {
    schemaVersion: 1,
    id: `evt-${sequence}`,
    sequence,
    simTime: sequence * 1000,
    correlationId: `tick-${sequence}`,
    causationId: `evt-${sequence - 1}`,
    approximate: false,
    kind: "memory-recorded",
    memoryKind: "witnessed",
    entityId: owner,
    sourceEventId: `evt-${sequence - 1}`,
    eventKind: "building-damaged",
    subjects: ["the-tavern"],
    salience,
  } as unknown as WorldEvent;
}

const held = (state: WorldState, owner = "zeus") =>
  getMemories(state, id(owner)).map((memory) => Number(memory.recordedAt));

test("over capacity, the least salient memory goes first, and the oldest among equals", () => {
  const world = new World({ capacity: 3 });
  let state = world.initial;
  for (const [sequence, salience] of [
    [10, 5],
    [11, 8],
    [12, 2],
  ] as const) {
    state = applyEvent(state, memoryEvent(sequence, salience));
  }
  expect(held(state)).toEqual([10, 11, 12]);

  // Full: 2 is the least salient, so it goes.
  state = applyEvent(state, memoryEvent(13, 5));
  expect(held(state)).toEqual([10, 11, 13]);

  // 5 and 5 tie: the older one goes.
  state = applyEvent(state, memoryEvent(14, 5));
  expect(held(state)).toEqual([11, 13, 14]);

  // A new memory less salient than everything held is the one forgotten.
  state = applyEvent(state, memoryEvent(15, 1));
  expect(held(state)).toEqual([11, 13, 14]);
});

test("positive control: with room to spare nothing is forgotten", () => {
  const world = new World({ capacity: 10 });
  let state = world.initial;
  for (const [sequence, salience] of [
    [10, 5],
    [11, 8],
    [12, 2],
    [13, 5],
  ] as const) {
    state = applyEvent(state, memoryEvent(sequence, salience));
  }
  expect(held(state)).toEqual([10, 11, 12, 13]);
});

test("capacity is per actor: one actor filling up forgets nothing of another's", () => {
  const world = new World({ capacity: 1 });
  let state = world.initial;
  state = applyEvent(state, memoryEvent(10, 5, "zeus"));
  state = applyEvent(state, memoryEvent(11, 5, "farmer"));
  state = applyEvent(state, memoryEvent(12, 6, "zeus"));
  expect(held(state, "zeus")).toEqual([12]);
  expect(held(state, "farmer")).toEqual([11]);
});

test("replaying the log reproduces memories and relationships exactly, eviction order included", () => {
  const world = new World({ capacity: 2 });
  world.tick(strike("zeus", "the-tavern"));
  world.tick(move("farmer", "square"));
  world.tick(report("farmer", "hera", "Zeus burned the agora"));
  for (let index = 0; index < 4; index += 1) world.tick();
  world.tick(strike("hera", "old-oak", 1));
  world.tick(worship("woodcutter", "hera"));

  // Something was actually forgotten, or this proves nothing.
  const recorded = ofKind(world.log, "memory-recorded");
  const forgotten = recorded.filter(
    (event) =>
      !world.memories(event.entityId).some((memory) => memory.id === event.id),
  );
  expect(forgotten.length).toBeGreaterThan(0);
  for (const actor of world.state.memories.keys()) {
    expect(world.memories(actor).length).toBeLessThanOrEqual(2);
  }

  const rebuilt = applyEvents(world.initial, world.log);
  const live = encode(world.state);
  const replayed = encode(rebuilt);
  expect(replayed.memories).toEqual(live.memories);
  expect(replayed.relationships).toEqual(live.relationships);
  expect(replayed.memories.length).toBeGreaterThan(0);
});

// --- The codec ---------------------------------------------------------------------------------

test("memories, beliefs, and relationships survive encode, JSON, and decode", () => {
  const { world } = reportedToHera("Zeus burned the agora", true);
  const restored = decode(JSON.parse(JSON.stringify(encode(world.state))));
  expect(restored.memories).toEqual(world.state.memories);
  expect(restored.relationships).toEqual(world.state.relationships);
  expect(restored.buildings).toEqual(world.state.buildings);
  expect(getRelationship(restored, id("hera"), id("zeus"))?.affinity).toBe(-1);
  // The burning tavern remembers what started its fire.
  expect(restored.buildings.get(id("the-tavern"))?.ignition).toBeDefined();
});

test("decode refuses a memory or relationship that names nobody", () => {
  const { world } = reportedToHera("Zeus burned the agora", true);
  const encoded = JSON.parse(JSON.stringify(encode(world.state)));

  const ghostOwner = {
    ...encoded,
    memories: [["ghost", encoded.memories[0][1]], ...encoded.memories.slice(1)],
  };
  expect(() => decode(ghostOwner)).toThrow(/ghost/);

  const ghostRelationship = {
    ...encoded,
    relationships: [
      [
        "hera>ghost",
        {
          from: "hera",
          toward: "ghost",
          affinity: -1,
          grudge: 0,
          allied: false,
        },
      ],
    ],
  };
  expect(() => decode(ghostRelationship)).toThrow(/ghost/);

  const wrongKey = {
    ...encoded,
    relationships: [
      [
        "zeus>hera",
        {
          from: "hera",
          toward: "zeus",
          affinity: -1,
          grudge: 0,
          allied: false,
        },
      ],
    ],
  };
  expect(() => decode(wrongKey)).toThrow();

  // Control: the untouched encoding decodes.
  expect(() => decode(encoded)).not.toThrow();
});
