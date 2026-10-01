import { expect, test } from "bun:test";
import type { ContentPack, EventId, WorldEvent } from "@panthea/contracts";
import { applyEvent, applyEvents, runTick, submitProposal } from "./actions";
import { decode, encode } from "./codec";
import { perceive } from "./perception";
import {
  DEFAULT_PETITION_BALANCE,
  openPetitionsFor,
  petitionBalanceOf,
  prayableCauses,
} from "./petitions";
import { decideRoutineProposal } from "./routines";
import {
  createInitialWorldState,
  createPrng,
  getActor,
  type PrngState,
  relationshipKey,
  toEntityId,
  type WorldState,
  withActor,
} from "./state";

const id = toEntityId;

/** A square with an altar and a tavern, a farmer who owns the tavern, a woodcutter who owns a woodshed, a drifter who owns nothing, and two gods in a hall nobody else can enter. */
function pack(): ContentPack {
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
        ],
      },
      { id: "altar", realm: "mortal", name: "Altar", edges: [] },
      { id: "tavern", realm: "mortal", name: "Tavern", edges: [] },
      { id: "hall", realm: "olympus", name: "Hall", edges: [] },
    ],
    buildings: [
      {
        id: "the-tavern",
        locationId: "tavern",
        name: "The Tavern",
        material: "wood",
        combustible: true,
        services: ["drink"],
        inventory: [],
        owner: "farmer",
      },
      {
        id: "woodshed",
        locationId: "square",
        name: "The Woodshed",
        material: "wood",
        combustible: true,
        services: [],
        inventory: [],
        owner: "woodcutter",
      },
    ],
    inhabitants: [
      calm("farmer", "square", [{ resource: "food", amount: 60 }]),
      calm("woodcutter", "square", [{ resource: "food", amount: 60 }]),
      calm("drifter", "square", [{ resource: "food", amount: 60 }]),
      {
        id: "zeus",
        name: "Zeus",
        locationId: "hall",
        deity: true,
        startingInventory: [{ resource: "divinity", amount: 10 }],
      },
      {
        id: "hera",
        name: "Hera",
        locationId: "hall",
        deity: true,
        startingInventory: [{ resource: "divinity", amount: 10 }],
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
    },
    recipes: {},
  };
}

/** A mortal whose drives rank nothing above praying and walking home. */
function calm(
  idValue: string,
  locationId: string,
  startingInventory: { resource: string; amount: number }[],
) {
  return {
    id: idValue,
    name: idValue,
    locationId,
    drives: { thrift: 0, appetite: 0, greed: 0, piety: 0 },
    startingInventory,
  };
}

class World {
  state: WorldState;
  prng: PrngState = createPrng(1);
  readonly log: WorldEvent[] = [];
  readonly initial: WorldState;
  constructor(state = createInitialWorldState(pack())) {
    this.state = state;
    this.initial = state;
  }
  /** One tick of fixtures and routines: every mortal's routine proposal plus `extra`. */
  tick(...extra: Record<string, unknown>[]): WorldEvent[] {
    const proposals = [
      ...extra.map((raw, index) => {
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
      }),
      ...(["farmer", "woodcutter", "drifter"] as const).flatMap((mortal) => {
        const decision = decideRoutineProposal(this.state, id(mortal));
        return decision ? [decision.proposal] : [];
      }),
    ];
    const result = runTick(this.state, this.prng, proposals);
    this.state = result.state;
    this.prng = result.prng;
    this.log.push(...result.events);
    return [...result.events];
  }
  /** Runs ticks, with no extra proposals, until `done` or `limit`. */
  until(done: () => boolean, limit = 40): void {
    for (let n = 0; n < limit && !done(); n += 1) this.tick();
  }
  petitions() {
    return [...this.state.petitions.values()];
  }
  /** Commits a fixture event as the world would have, so a cause exists without staging a whole story. */
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
}

const kinds = (events: readonly WorldEvent[]) => events.map((e) => e.kind);
const ofKind = <K extends WorldEvent["kind"]>(
  events: readonly WorldEvent[],
  kind: K,
) =>
  events.filter((e): e is Extract<WorldEvent, { kind: K }> => e.kind === kind);

// --- Praying -------------------------------------------------------------------------------

test("the farmer's tavern burns: the farmer walks to the altar, prays about the burning to a god, and walks home", () => {
  const world = new World();
  world.tick({ actor: "zeus", kind: "strike", target: "the-tavern", power: 3 });
  const ignition = ofKind(world.log, "building-ignited")[0];
  expect(ignition).toBeDefined();

  world.until(
    () =>
      world.petitions().length > 0 &&
      getActor(world.state, id("farmer"))?.locationId === id("square"),
  );
  const [petition] = world.petitions();
  expect(petition).toMatchObject({
    petitioner: "farmer",
    status: "open",
    cause: ignition?.id,
    // Zeus owns nothing, so the request is for help with the building, not punishment.
    request: {
      kind: "help",
      need: { kind: "building", building: "the-tavern" },
    },
  });
  expect(["hera", "zeus"]).toContain(String(petition?.god));
  // To the altar, a prayer made there, and back.
  const opened = ofKind(world.log, "petition-opened")[0];
  expect(opened).toMatchObject({ entityId: "farmer", cause: ignition?.id });
  const farmerMoves = world.log.filter(
    (e) => e.kind === "entity-moved" && e.entityId === id("farmer"),
  );
  expect(farmerMoves.map((e) => (e as { to: string }).to)).toEqual([
    "altar",
    "square",
  ]);
  const prayedAt = world.log.indexOf(opened as WorldEvent);
  expect(world.log.indexOf(farmerMoves[0] as WorldEvent)).toBeLessThan(
    prayedAt,
  );
  expect(world.log.indexOf(farmerMoves[1] as WorldEvent)).toBeGreaterThan(
    prayedAt,
  );
});

test("a theft by someone who owns a building asks for punishment, naming the building; by someone who owns none, for help", () => {
  const punished = new World();
  const stolen = punished.apply({
    kind: "theft",
    entityId: "woodcutter",
    victim: "farmer",
    resource: "food",
    amount: 1,
    cause: "director",
  });
  punished.until(() => punished.petitions().length > 0);
  expect(punished.petitions()[0]).toMatchObject({
    cause: stolen.id,
    request: {
      kind: "punish",
      offender: "woodcutter",
      buildings: ["woodshed"],
    },
  });

  const helped = new World();
  const robbed = helped.apply({
    kind: "theft",
    entityId: "drifter",
    victim: "farmer",
    resource: "food",
    amount: 1,
    cause: "director",
  });
  helped.until(() => helped.petitions().length > 0);
  expect(helped.petitions()[0]).toMatchObject({
    cause: robbed.id,
    request: { kind: "help", need: { kind: "resource", resource: "food" } },
  });
});

test("an unmet need is prayed about, citing the need event; spoiled stock too", () => {
  const needy = new World();
  needy.apply({
    kind: "stock-spoiled",
    entityId: "farmer",
    resource: "food",
    amount: 1,
    cause: "director",
  });
  needy.until(() => needy.petitions().length > 0);
  expect(needy.petitions()[0]?.request).toEqual({
    kind: "help",
    need: { kind: "resource", resource: "food" },
  });

  // The woodcutter's food runs out: the scan records the need, and the woodcutter prays about it.
  const hungry = new World();
  const woodcutter = getActor(hungry.state, id("woodcutter"));
  if (!woodcutter) throw new Error("woodcutter");
  hungry.state = withActor(hungry.state, {
    ...woodcutter,
    inventory: new Map(),
  });
  hungry.until(() =>
    hungry.petitions().some((p) => p.petitioner === id("woodcutter")),
  );
  const need = ofKind(hungry.log, "unmet-need").find(
    (e) => e.entityId === id("woodcutter"),
  );
  expect(
    hungry.petitions().find((p) => p.petitioner === id("woodcutter"))?.cause,
  ).toBe(need?.id);
});

test("each cause leads to at most one petition, and the cooldown keeps two prayers from back-to-back ticks", () => {
  const world = new World();
  const first = world.apply({
    kind: "stock-spoiled",
    entityId: "farmer",
    resource: "food",
    amount: 1,
    cause: "director",
  });
  const second = world.apply({
    kind: "theft",
    entityId: "drifter",
    victim: "farmer",
    resource: "food",
    amount: 1,
    cause: "director",
  });
  world.until(() => world.petitions().length >= 1);
  const openedAt = world.state.tick;
  expect(world.petitions()).toHaveLength(1);
  // Within the cooldown nothing more is prayed, however many causes wait.
  const cooldown = petitionBalanceOf(world.state.rules, "prayerCooldownTicks");
  for (let n = 0; n < cooldown - 2; n += 1) world.tick();
  expect(world.petitions()).toHaveLength(1);
  expect(world.state.tick).toBeLessThan(openedAt + cooldown);
  // After it, the other cause is prayed about, once, and the first cause never again.
  world.until(() => world.petitions().length >= 2, cooldown + 10);
  const causes = world.petitions().map((p) => p.cause);
  expect(new Set(causes).size).toBe(2);
  expect(causes).toEqual(expect.arrayContaining([first.id, second.id]));
  for (let n = 0; n < 30; n += 1) world.tick();
  expect(world.petitions()).toHaveLength(2);
});

test("a cause older than the prayable window is not prayed about, and a pray proposal citing one is refused; a fresh cause is accepted", () => {
  const world = new World();
  const old = world.apply({
    kind: "stock-spoiled",
    entityId: "farmer",
    resource: "food",
    amount: 1,
    cause: "director",
  });
  const window = petitionBalanceOf(world.state.rules, "causePrayableTicks");
  world.state = { ...world.state, tick: world.state.tick + window + 1 };
  expect(prayableCauses(world.state, id("farmer"))).toEqual([]);
  const farmer = getActor(world.state, id("farmer"));
  if (!farmer) throw new Error("farmer");
  world.state = withActor(world.state, { ...farmer, locationId: id("altar") });
  const stale = submitProposal({
    schemaVersion: 1,
    actor: "farmer",
    kind: "pray",
    cause: old.id,
    targets: [],
    expectedRevisions: [],
    source: "routine",
    observationId: "obs-p",
  });
  if (!stale.ok) throw new Error("fixture");
  const refused = runTick(world.state, world.prng, [stale.proposal]);
  expect(refused.rejected.map((r) => r.reason)).toEqual(["malformed"]);
  // Control: a cause from this tick is accepted.
  const fresh = world.apply({
    kind: "stock-spoiled",
    entityId: "farmer",
    resource: "food",
    amount: 1,
    cause: "director",
  });
  const accepted = submitProposal({
    schemaVersion: 1,
    actor: "farmer",
    kind: "pray",
    cause: fresh.id,
    targets: [],
    expectedRevisions: [],
    source: "routine",
    observationId: "obs-q",
  });
  if (!accepted.ok) throw new Error("fixture");
  const ran = runTick(world.state, world.prng, [accepted.proposal]);
  expect(ran.rejected).toEqual([]);
  expect(kinds(ran.events)).toContain("petition-opened");
});

test("a mortal with work to do prefers it to prayer: production and repair outrank praying", () => {
  const base = pack();
  const state = createInitialWorldState({
    ...base,
    recipes: {
      planks: {
        inputs: [{ resource: "wood", amount: 2 }],
        outputs: [{ resource: "planks", amount: 1 }],
      },
    },
  });
  const world = new World(state);
  const woodcutter = getActor(world.state, id("woodcutter"));
  if (!woodcutter) throw new Error("woodcutter");
  world.state = withActor(world.state, {
    ...woodcutter,
    drives: { thrift: 0.6, appetite: 0, greed: 0, piety: 0 },
    inventory: new Map([
      ["wood", 2],
      ["food", 1],
    ]),
  });
  world.apply({
    kind: "stock-spoiled",
    entityId: "woodcutter",
    resource: "food",
    amount: 1,
    cause: "director",
  });
  expect(
    decideRoutineProposal(world.state, id("woodcutter"))?.proposal.kind,
  ).toBe("produce");
  // Control: with nothing to produce, the same mortal turns to prayer.
  world.state = withActor(world.state, {
    ...(getActor(world.state, id("woodcutter")) as NonNullable<
      ReturnType<typeof getActor>
    >),
    inventory: new Map([["food", 1]]),
  });
  expect(
    decideRoutineProposal(world.state, id("woodcutter"))?.proposal,
  ).toMatchObject({ kind: "move", to: "altar" });
});

// --- Routing --------------------------------------------------------------------------------

/** Has `mortal` pray at the altar about a fresh cause now, and returns the petition's god. */
function prayer(world: World, mortal: string): string {
  const cause = world.apply({
    kind: "stock-spoiled",
    entityId: mortal,
    resource: "food",
    amount: 1,
    cause: "director",
  });
  const actor = getActor(world.state, id(mortal));
  if (!actor) throw new Error(mortal);
  world.state = withActor(world.state, { ...actor, locationId: id("altar") });
  const submitted = submitProposal({
    schemaVersion: 1,
    actor: mortal,
    kind: "pray",
    cause: cause.id,
    targets: [],
    expectedRevisions: [],
    source: "routine",
    observationId: `obs-${mortal}-${world.log.length}`,
  });
  if (!submitted.ok) throw new Error("fixture");
  const ran = runTick(world.state, world.prng, [submitted.proposal]);
  expect(ran.rejected).toEqual([]);
  world.state = ran.state;
  world.log.push(...ran.events);
  const opened = ofKind(ran.events, "petition-opened")[0];
  if (!opened) throw new Error("no petition");
  return String(opened.god);
}

test("a mortal prays to the god it favors most; on a tie, to the god with fewer petitions; on a full tie, by id", () => {
  // Full tie, nothing prayed yet: id order.
  const world = new World();
  expect(prayer(world, "farmer")).toBe("hera");
  // Hera now has one petition: the next mortal's tie goes to Zeus.
  expect(prayer(world, "woodcutter")).toBe("zeus");
  // Both have one: id order again.
  expect(prayer(world, "drifter")).toBe("hera");

  // Affinity outranks the count: a mortal fond of Zeus prays to him though Hera has fewer.
  const fond = new World();
  const relationships = new Map(fond.state.relationships);
  relationships.set(relationshipKey(id("farmer"), id("zeus")), {
    from: id("farmer"),
    toward: id("zeus"),
    affinity: 3,
    grudge: 0,
    allied: false,
  });
  fond.state = { ...fond.state, relationships };
  expect(prayer(fond, "farmer")).toBe("zeus");
  // Control: with no affinity either way the same mortal is routed by the tie rules.
  const none = new World();
  expect(prayer(none, "farmer")).toBe("hera");
});

test("a dead mortal does not pray, and a god cannot: only a living mortal's routine opens a petition", () => {
  const world = new World();
  const cause = world.apply({
    kind: "stock-spoiled",
    entityId: "farmer",
    resource: "food",
    amount: 1,
    cause: "director",
  });
  const farmer = getActor(world.state, id("farmer"));
  if (!farmer) throw new Error("farmer");
  world.state = withActor(world.state, { ...farmer, alive: false });
  expect(decideRoutineProposal(world.state, id("farmer"))).toBeUndefined();
  const zeus = getActor(world.state, id("zeus"));
  if (!zeus) throw new Error("zeus");
  world.state = withActor(world.state, { ...zeus, locationId: id("altar") });
  const godPrays = submitProposal({
    schemaVersion: 1,
    actor: "zeus",
    kind: "pray",
    cause: cause.id,
    targets: [],
    expectedRevisions: [],
    source: "model",
    observationId: "obs-g",
  });
  if (!godPrays.ok) throw new Error("fixture");
  expect(
    runTick(world.state, world.prng, [godPrays.proposal]).rejected.map(
      (r) => r.reason,
    ),
  ).toEqual(["unauthorized-claim"]);
});

// --- Who hears it ------------------------------------------------------------------------------

test("anyone at the altar saw the prayer; the named god hears it wherever it is and no other god does", () => {
  const world = new World();
  const watcher = getActor(world.state, id("drifter"));
  if (!watcher) throw new Error("drifter");
  world.state = withActor(world.state, { ...watcher, locationId: id("altar") });
  const god = prayer(world, "farmer");
  const opened = ofKind(world.log, "petition-opened")[0] as WorldEvent;
  // The drifter stood at the altar and saw it; the woodcutter in the square did not.
  expect(
    perceive(world.state, id("drifter"), [opened])?.events.map((e) => e.kind),
  ).toEqual(["petition-opened"]);
  expect(
    perceive(world.state, id("woodcutter"), [opened])?.events.map(
      (e) => e.kind,
    ),
  ).toEqual([]);
  // The gods are in the hall, perceiving nothing of it; the named one still has it listed.
  expect(perceive(world.state, id(god), [opened])?.events).toEqual([]);
  expect(openPetitionsFor(world.state, id(god)).map((p) => p.id)).toEqual([
    opened.id,
  ]);
  const other = god === "hera" ? "zeus" : "hera";
  expect(openPetitionsFor(world.state, id(other))).toEqual([]);
});

// --- State -----------------------------------------------------------------------------------------

test("petitions and the causes mortals remember rebuild from the log, survive encode and decode, and decode refuses ghosts", () => {
  const world = new World();
  world.apply({
    kind: "theft",
    entityId: "woodcutter",
    victim: "farmer",
    resource: "food",
    amount: 1,
    cause: "director",
  });
  world.until(() => world.petitions().length > 0);
  const rebuilt = applyEvents(
    world.initial,
    world.log.map((e, i) => ({ ...e, sequence: i + 1 })) as WorldEvent[],
  );
  expect([...rebuilt.petitions]).toEqual([...world.state.petitions]);
  expect([...rebuilt.causes]).toEqual([...world.state.causes]);

  const encoded = JSON.parse(JSON.stringify(encode(world.state)));
  const restored = decode(encoded);
  expect([...restored.petitions]).toEqual([...world.state.petitions]);
  expect([...restored.causes]).toEqual([...world.state.causes]);

  const ghostPetitioner = JSON.parse(JSON.stringify(encoded));
  ghostPetitioner.petitions[0][1].petitioner = "ghost";
  expect(() => decode(ghostPetitioner)).toThrow(/ghost/);
  const ghostGod = JSON.parse(JSON.stringify(encoded));
  ghostGod.petitions[0][1].god = "ghost";
  expect(() => decode(ghostGod)).toThrow(/ghost/);
  // A mortal's home is state too: it survives the round trip.
  expect(getActor(restored, id("farmer"))?.home).toBe(id("square"));
});

test("the petition tunables default to the numbers the authored content states, so a retune edits one place", () => {
  for (const key of Object.keys(DEFAULT_PETITION_BALANCE)) {
    expect(petitionBalanceOf(createInitialWorldState(pack()).rules, key)).toBe(
      DEFAULT_PETITION_BALANCE[key],
    );
  }
  expect(
    petitionBalanceOf(
      { ...pack().rules, petitionBalance: { prayerCooldownTicks: 7 } },
      "prayerCooldownTicks",
    ),
  ).toBe(7);
});

void ({} as EventId);
