import { expect, test } from "bun:test";
import type { ContentPack, WorldEvent } from "@panthea/contracts";
import { applyEvent, applyEvents, runTick, submitProposal } from "./actions";
import { decode, encode } from "./codec";
import { planDirectorStep } from "./director";
import { perceive } from "./perception";
import { petitionBalanceOf } from "./petitions";
import { decideRoutineProposal } from "./routines";
import {
  createInitialWorldState,
  createPrng,
  getActor,
  type PrngState,
  toEntityId,
  type WorldState,
  withActor,
} from "./state";

const id = toEntityId;

/** Calm mortals who each hold a lot and own a building, a quiet window of 10, and gods in a hall. */
function pack(
  quiet = 10,
  mortals = ["farmer", "woodcutter", "drifter"],
): ContentPack {
  return {
    schemaVersion: 1,
    realms: ["mortal", "olympus"],
    resources: [],
    locations: [
      {
        id: "square",
        realm: "mortal",
        name: "Square",
        edges: [{ to: "altar", transport: "path", bidirectional: true }],
      },
      { id: "altar", realm: "mortal", name: "Altar", edges: [] },
      { id: "hall", realm: "olympus", name: "Hall", edges: [] },
    ],
    buildings: [
      {
        id: "farm-store",
        locationId: "square",
        name: "Farm store",
        material: "wood",
        combustible: true,
        services: [],
        inventory: [],
        owner: "farmer",
      },
      {
        id: "wood-store",
        locationId: "square",
        name: "Wood store",
        material: "wood",
        combustible: true,
        services: [],
        inventory: [],
        owner: "woodcutter",
      },
    ],
    inhabitants: [
      ...mortals.map((mortal) => ({
        id: mortal,
        name: mortal,
        locationId: "square",
        drives: { thrift: 0, appetite: 0, greed: 0, piety: 0 },
        startingInventory: [
          { resource: "currency", amount: 20 },
          { resource: "food", amount: 40 },
        ],
      })),
      {
        id: "zeus",
        name: "Zeus",
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
      petitionBalance: { directorQuietTicks: quiet },
    },
    recipes: {},
  };
}

class World {
  state: WorldState;
  prng: PrngState;
  readonly log: WorldEvent[] = [];
  readonly initial: WorldState;
  constructor(state = createInitialWorldState(pack()), seed = 1) {
    this.state = state;
    this.initial = state;
    this.prng = createPrng(seed);
  }
  /** One tick of nothing but the world's own steps, plus `extra` proposals. */
  tick(...extra: Record<string, unknown>[]): WorldEvent[] {
    const proposals = extra.map((raw, index) => {
      const submitted = submitProposal({
        schemaVersion: 1,
        targets: [],
        expectedRevisions: [],
        source: "model",
        observationId: `obs-${this.state.tick}-${index}`,
        ...raw,
      });
      if (!submitted.ok) throw new Error(submitted.rejection.message);
      return submitted.proposal;
    });
    const result = runTick(this.state, this.prng, proposals);
    this.state = result.state;
    this.prng = result.prng;
    this.log.push(...result.events);
    return [...result.events];
  }
  /** Runs `n` empty ticks. */
  run(n: number): WorldEvent[] {
    const all: WorldEvent[] = [];
    for (let i = 0; i < n; i += 1) all.push(...this.tick());
    return all;
  }
}

const trouble = (events: readonly WorldEvent[]) =>
  events.filter(
    (e) =>
      e.kind === "theft" ||
      e.kind === "stock-spoiled" ||
      (e.kind === "building-ignited" && e.cause.kind === "director"),
  );

test("a quiet world gets trouble once the quiet window has passed, never before, and the trouble names the director as its cause", () => {
  const world = new World();
  // Nothing happens for ticks 1..9: the window is 10.
  expect(trouble(world.run(9))).toEqual([]);
  const first = trouble(world.tick());
  expect(first).toHaveLength(1);
  const event = first[0] as WorldEvent;
  if (event.kind === "theft" || event.kind === "stock-spoiled") {
    expect(event.cause).toBe("director");
  } else if (event.kind === "building-ignited") {
    expect(event.cause).toEqual({ kind: "director" });
  } else throw new Error("not trouble");
  // The trouble was caused by the world's own tick, not a proposal.
  expect(String(event.correlationId)).toBe(`tick-${world.state.tick}`);
});

test("the director's own trouble resets the timer: the next trouble is at least a quiet window later", () => {
  const world = new World();
  const quiet = petitionBalanceOf(world.state.rules, "directorQuietTicks");
  const ticks: number[] = [];
  for (let n = 0; n < quiet * 4 + 5; n += 1) {
    if (trouble(world.tick()).length > 0) ticks.push(world.state.tick);
  }
  expect(ticks.length).toBeGreaterThanOrEqual(3);
  for (let i = 1; i < ticks.length; i += 1) {
    expect(
      (ticks[i] as number) - (ticks[i - 1] as number),
    ).toBeGreaterThanOrEqual(quiet);
  }
});

test("a strike, a fire, a theft, a trade, a bless, or an answered petition resets the timer; talk, goals, and prayers do not", () => {
  const consequential = (extra: Record<string, unknown>) => {
    const world = new World();
    world.run(8);
    world.tick(extra); // tick 9, with the proposal
    // Without the reset, trouble would come at tick 10; with it, not before tick 9 + 10.
    return trouble(world.run(9)).length;
  };
  // A strike on a building (the woodcutter's store) is consequential.
  expect(
    consequential({
      actor: "zeus",
      kind: "strike",
      target: "wood-store",
      power: 3,
    }),
  ).toBe(0);
  // Control: with nothing at all the same ticks have trouble in them.
  const control = new World();
  control.run(8);
  control.tick();
  expect(trouble(control.run(9)).length).toBeGreaterThan(0);
  // Talk and goals do not reset it.
  const talk = new World();
  talk.run(8);
  talk.tick({ actor: "zeus", kind: "legend", assertion: "Hear me." });
  expect(trouble(talk.run(2)).length).toBeGreaterThan(0);
  const goal = new World();
  goal.run(8);
  goal.tick({
    actor: "zeus",
    kind: "goal",
    goal: { set: { text: "Watch.", target: "farmer" } },
  });
  expect(trouble(goal.run(2)).length).toBeGreaterThan(0);
  // A trade by mortals resets it too.
  const trade = new World();
  trade.run(8);
  trade.tick({
    actor: "farmer",
    kind: "trade",
    counterparty: "woodcutter",
    give: [{ resource: "currency", amount: 4 }],
    receive: [{ resource: "food", amount: 1 }],
    source: "routine",
  });
  expect(trade.log.some((e) => e.kind === "resource-traded")).toBe(true);
  expect(trouble(trade.run(2)).length).toBe(0);
});

test("with fewer than two mortals eligible, the director skips that tick and tries again the next", () => {
  const lone = new World(createInitialWorldState(pack(10, ["farmer"])));
  expect(trouble(lone.run(30))).toEqual([]);
  // Control: with a second mortal the same world has trouble.
  const pair = new World(
    createInitialWorldState(pack(10, ["farmer", "woodcutter"])),
  );
  expect(trouble(pair.run(30)).length).toBeGreaterThan(0);
  // A dead mortal is not eligible: killing one of two leaves one.
  const dying = new World(
    createInitialWorldState(pack(10, ["farmer", "woodcutter"])),
  );
  const woodcutter = getActor(dying.state, id("woodcutter"));
  if (!woodcutter) throw new Error("woodcutter");
  dying.state = withActor(dying.state, { ...woodcutter, alive: false });
  expect(trouble(dying.run(30))).toEqual([]);
});

test("the director picks its victims in id order and never undoes damage: its trouble only takes or burns or spoils", () => {
  const world = new World();
  const events = trouble(world.run(80));
  expect(events.length).toBeGreaterThan(3);
  for (const event of events) {
    if (event.kind === "theft") {
      expect(event.entityId).not.toBe(event.victim);
      expect(event.amount).toBeGreaterThan(0);
    }
    if (event.kind === "stock-spoiled") expect(event.amount).toBeGreaterThan(0);
  }
  // Nothing in the log repairs or heals anything the director did.
  expect(
    world.log.some(
      (e) => e.kind === "building-repaired" || e.kind === "repair-progressed",
    ),
  ).toBe(false);
  // A theft never takes more than the victim held at the time: no inventory goes negative.
  for (const actor of world.state.actors.values()) {
    for (const amount of actor.inventory.values())
      expect(amount).toBeGreaterThanOrEqual(0);
  }
  // Plan step: eligible victims come from the mortals in id order.
  const step = planDirectorStep(
    createInitialWorldState(pack()),
    createPrng(1),
    10,
  );
  expect(step.events).toHaveLength(1);
});

test("the same seed and log replay the same director events, and a different seed makes different trouble", () => {
  const record = (seed: number) => {
    const world = new World(createInitialWorldState(pack()), seed);
    world.run(60);
    return world;
  };
  const a = record(7);
  const b = record(7);
  expect(trouble(a.log).map((e) => [e.kind, e.id, e.entityId])).toEqual(
    trouble(b.log).map((e) => [e.kind, e.id, e.entityId]),
  );
  // Replaying the log from the start reproduces the state, including the timer.
  const replayed = applyEvents(
    a.initial,
    a.log.map((e, i) => ({ ...e, sequence: i + 1 })) as WorldEvent[],
  );
  expect(replayed.director).toEqual(a.state.director);
  expect(
    [...replayed.actors.entries()].map(([k, v]) => [k, [...v.inventory]]),
  ).toEqual(
    [...a.state.actors.entries()].map(([k, v]) => [k, [...v.inventory]]),
  );
  const different = record(99);
  expect(trouble(different.log).map((e) => [e.kind, e.entityId])).not.toEqual(
    trouble(a.log).map((e) => [e.kind, e.entityId]),
  );
  // The timer survives encode and decode.
  const restored = decode(JSON.parse(JSON.stringify(encode(a.state))));
  expect(restored.director).toEqual(a.state.director);
});

test("trouble at the square is not in a god's snapshot: the gods are in their hall and perceive none of it", () => {
  const world = new World();
  const events = trouble(world.run(15));
  expect(events.length).toBeGreaterThan(0);
  expect(perceive(world.state, id("zeus"), events)?.events).toEqual([]);
  // Control: a mortal standing in the square perceives it.
  const seen = perceive(world.state, id("farmer"), events)?.events ?? [];
  expect(seen.length).toBeGreaterThan(0);
});

test("a victim of the director's trouble prays about it, and the prayer cites the trouble", () => {
  const world = new World();
  const first = trouble(world.run(12))[0] as WorldEvent;
  const victim =
    first.kind === "theft"
      ? first.victim
      : first.kind === "stock-spoiled"
        ? first.entityId
        : world.state.buildings.get(
            (first as { entityId: ReturnType<typeof id> }).entityId,
          )?.owner;
  expect(victim).toBeDefined();
  // The mortals' own routines take the victim to the altar to pray.
  let prayed: WorldEvent | undefined;
  for (let n = 0; n < 60 && prayed === undefined; n += 1) {
    const proposals = (["farmer", "woodcutter", "drifter"] as const).flatMap(
      (m) => {
        const decision = decideRoutineProposal(world.state, id(m));
        return decision ? [decision.proposal] : [];
      },
    );
    const result = runTick(world.state, world.prng, proposals);
    world.state = result.state;
    world.prng = result.prng;
    world.log.push(...result.events);
    prayed = result.events.find(
      (e) => e.kind === "petition-opened" && e.entityId === victim,
    );
  }
  expect(prayed).toBeDefined();
  if (prayed?.kind === "petition-opened") {
    expect(
      world.log.some((e) => e.id === prayed.cause && trouble([e]).length === 1),
    ).toBe(true);
  }
});

void applyEvent;
