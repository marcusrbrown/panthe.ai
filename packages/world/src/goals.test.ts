import { expect, test } from "bun:test";
import type { ContentPack, Proposal, WorldEvent } from "@panthea/contracts";
import { applyEvents, runTick, submitProposal } from "./actions";
import { decode, encode } from "./codec";
import { getGoal } from "./goals";
import { perceive } from "./perception";
import {
  createInitialWorldState,
  createPrng,
  toEntityId,
  type WorldState,
} from "./state";

const id = toEntityId;

function pack(): ContentPack {
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
      { id: "square", realm: "mortal", name: "The Square", edges: [] },
    ],
    buildings: [
      {
        id: "the-tavern",
        locationId: "tavern",
        name: "The Tavern House",
        material: "wood",
        combustible: true,
        services: [],
        inventory: [],
        owner: "farmer",
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
      { id: "hera", name: "Hera", locationId: "tavern", deity: true },
      { id: "farmer", name: "The Farmer", locationId: "tavern" },
      { id: "bard", name: "The Bard", locationId: "square" },
    ],
    rules: {
      catchUpCapMs: 0,
      catchUpChunkMs: 0,
      checkpointIntervalMs: 0,
      maxProposalsPerTick: 100,
      fireBalance: { igniteThreshold: 3 },
      economyBalance: {},
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
    source: "model",
    observationId: `obs-g${observations}`,
    ...raw,
  });
  if (!submitted.ok) throw new Error(submitted.rejection.message);
  return submitted.proposal;
}

const SET = (text: string, target: string) => ({ set: { text, target } });
const END = (outcome: string) => ({ end: { outcome } });

function tick(state: WorldState, ...queue: Proposal[]) {
  return runTick(state, createPrng(1), queue);
}

const kinds = (events: readonly WorldEvent[]) => events.map((e) => e.kind);
const goalEvents = (events: readonly WorldEvent[]) =>
  events.filter((e) => e.kind === "goal-set" || e.kind === "goal-ended");

const start = () => createInitialWorldState(pack());

// --- Setting and ending -------------------------------------------------------------------

test("a goal set on a move proposal records goal-set and the active goal shows its text, target, and the event that set it", () => {
  const result = tick(
    start(),
    propose({
      actor: "hera",
      kind: "move",
      to: "square",
      goal: SET("Win the farmer's devotion.", "farmer"),
    }),
  );
  expect(result.rejected).toEqual([]);
  const set = result.events.find((e) => e.kind === "goal-set");
  expect(set).toMatchObject({
    kind: "goal-set",
    entityId: "hera",
    text: "Win the farmer's devotion.",
    target: "farmer",
  });
  expect(getGoal(result.state, id("hera")) as unknown).toEqual({
    text: "Win the farmer's devotion.",
    target: "farmer",
    eventId: set?.id,
    sequence: set?.sequence,
  });
  // The action itself still happened, and the goal came with its proposal's observation.
  expect(kinds(result.events)).toContain("entity-moved");
  expect(set?.correlationId as string).toBe(
    result.committed[0]?.proposal.observationId as string,
  );
  // Control: no one else has a goal.
  expect(getGoal(result.state, id("zeus"))).toBeUndefined();
});

test("a goal ended as achieved records goal-ended with that outcome, naming the goal it ends, and clears the active goal", () => {
  const first = tick(
    start(),
    propose({
      actor: "zeus",
      kind: "goal",
      goal: SET("Punish the farmer.", "farmer"),
    }),
  );
  const setId = getGoal(first.state, id("zeus"))?.eventId;
  const ended = tick(
    first.state,
    propose({ actor: "zeus", kind: "goal", goal: END("achieved") }),
  );
  expect(ended.events.find((e) => e.kind === "goal-ended")).toMatchObject({
    entityId: "zeus",
    outcome: "achieved",
    goalEventId: setId,
  });
  expect(getGoal(ended.state, id("zeus"))).toBeUndefined();
  // Control: ending with no active goal records nothing.
  const nothing = tick(
    ended.state,
    propose({ actor: "zeus", kind: "goal", goal: END("failed") }),
  );
  expect(goalEvents(nothing.events)).toEqual([]);
});

test("setting a goal while one is active ends the old one as abandoned, then sets the new one", () => {
  const first = tick(
    start(),
    propose({
      actor: "hera",
      kind: "goal",
      goal: SET("Make Zeus admit it.", "zeus"),
    }),
  );
  const oldId = getGoal(first.state, id("hera"))?.eventId;
  const second = tick(
    first.state,
    propose({
      actor: "hera",
      kind: "goal",
      goal: SET("Win the farmer.", "farmer"),
    }),
  );
  const events = goalEvents(second.events);
  expect(events.map((e) => e.kind)).toEqual(["goal-ended", "goal-set"]);
  expect(events[0]).toMatchObject({ outcome: "abandoned", goalEventId: oldId });
  expect(String(getGoal(second.state, id("hera"))?.target)).toBe("farmer");
  // Sequence follows the order: the end comes first.
  expect(events[0]?.sequence).toBeLessThan(events[1]?.sequence ?? 0);
});

test("an explicit end and a new set in one turn record the end first, as the declared outcome, with no extra abandonment", () => {
  const first = tick(
    start(),
    propose({
      actor: "hera",
      kind: "goal",
      goal: SET("Make Zeus admit it.", "zeus"),
    }),
  );
  const second = tick(
    first.state,
    propose({
      actor: "hera",
      kind: "move",
      to: "square",
      goal: { ...END("achieved"), ...SET("Win the farmer.", "farmer") },
    }),
  );
  const events = goalEvents(second.events);
  expect(events.map((e) => e.kind)).toEqual(["goal-ended", "goal-set"]);
  expect(events[0]).toMatchObject({ outcome: "achieved" });
  expect(getGoal(second.state, id("hera"))?.text).toBe("Win the farmer.");
});

// --- Whatever becomes of the action ----------------------------------------------------------

test("a strike rejected as stale-target still records the goal set it carried, and its rejection is unchanged", () => {
  const proposal = propose({
    actor: "zeus",
    kind: "strike",
    target: "the-tavern",
    power: 1,
    // A revision the building does not have: the proposal is stale.
    expectedRevisions: [{ entityId: "the-tavern", revision: 99 }],
    goal: SET("Burn the farmer's tavern.", "farmer"),
  });
  const result = tick(start(), proposal);
  expect(result.committed).toEqual([]);
  expect(result.rejected).toHaveLength(1);
  expect(result.rejected[0]?.reason).toBe("stale-target");
  // The goal is recorded and listed with the rejection.
  const goal = goalEvents(result.events);
  expect(kinds(goal)).toEqual(["goal-set"]);
  expect(result.rejected[0]?.goalEvents.map((e) => e.id)).toEqual(
    goal.map((e) => e.id),
  );
  expect(getGoal(result.state, id("zeus"))?.text).toBe(
    "Burn the farmer's tavern.",
  );
  // Control: the same strike with current revisions commits, and the goal rides along.
  const fresh = tick(
    start(),
    propose({
      actor: "zeus",
      kind: "strike",
      target: "the-tavern",
      power: 1,
      goal: SET("Burn the farmer's tavern.", "farmer"),
    }),
  );
  expect(fresh.rejected).toEqual([]);
  expect(kinds(fresh.committed[0]?.events ?? [])).toContain("goal-set");
});

test("a proposal rejected as busy-actor still records its goal change: goal events never use the action slot", () => {
  const result = tick(
    start(),
    propose({ actor: "hera", kind: "move", to: "square" }),
    propose({
      actor: "hera",
      kind: "move",
      to: "tavern",
      goal: SET("Win the farmer.", "farmer"),
    }),
  );
  expect(result.rejected.map((r) => r.reason)).toEqual(["busy-actor"]);
  expect(String(getGoal(result.state, id("hera"))?.target)).toBe("farmer");
});

test("a goal-only proposal records its goal event and no action event, and leaves the actor's action slot free", () => {
  const result = tick(
    start(),
    propose({
      actor: "hera",
      kind: "goal",
      goal: SET("Win the farmer.", "farmer"),
    }),
    propose({ actor: "hera", kind: "move", to: "square" }),
  );
  expect(result.rejected).toEqual([]);
  expect(result.committed).toHaveLength(2);
  expect(kinds(result.committed[0]?.events ?? [])).toEqual(["goal-set"]);
  expect(kinds(result.committed[1]?.events ?? [])).toEqual(["entity-moved"]);
  // Control: two actions in one tick still collide.
  const twice = tick(
    start(),
    propose({ actor: "hera", kind: "move", to: "square" }),
    propose({ actor: "hera", kind: "move", to: "tavern" }),
  );
  expect(twice.rejected.map((r) => r.reason)).toEqual(["busy-actor"]);
});

test("a goal change from an actor who does not exist or is dead records nothing", () => {
  const nobody = tick(
    start(),
    propose({ actor: "nobody", kind: "goal", goal: SET("Be.", "zeus") }),
  );
  expect(goalEvents(nobody.events)).toEqual([]);
  const state = start();
  const hera = state.actors.get(id("hera"));
  if (!hera) throw new Error("no hera");
  const dead: WorldState = {
    ...state,
    actors: new Map(state.actors).set(id("hera"), { ...hera, alive: false }),
  };
  const result = tick(
    dead,
    propose({ actor: "hera", kind: "goal", goal: SET("Be.", "zeus") }),
  );
  expect(goalEvents(result.events)).toEqual([]);
  // Control: the living actor's identical change records.
  expect(
    goalEvents(
      tick(
        start(),
        propose({ actor: "hera", kind: "goal", goal: SET("Be.", "zeus") }),
      ).events,
    ),
  ).toHaveLength(1);
});

test("the world never judges a goal: a target that is dead, absent, or not an actor at all is recorded as given", () => {
  const result = tick(
    start(),
    propose({
      actor: "hera",
      kind: "goal",
      goal: SET("Find the unseen.", "nowhere-at-all"),
    }),
  );
  expect(String(getGoal(result.state, id("hera"))?.target)).toBe(
    "nowhere-at-all",
  );
});

// --- Privacy -----------------------------------------------------------------------------------

test("another actor never perceives a goal event, and no witnessed memory is formed of one", () => {
  const result = tick(
    start(),
    propose({
      actor: "hera",
      kind: "goal",
      goal: SET("Win the farmer.", "farmer"),
    }),
  );
  expect(kinds(result.events)).toEqual(["goal-set"]);
  for (const observer of ["zeus", "farmer", "hera", "bard"]) {
    const seen = perceive(result.state, id(observer), result.events);
    expect(seen?.events ?? []).toEqual([]);
  }
  expect(result.derivedEvents).toEqual([]);
  expect(result.state.memories.size).toBe(0);
  // Control: a visible event beside it is perceived.
  const moved = tick(
    start(),
    propose({
      actor: "hera",
      kind: "move",
      to: "square",
      goal: SET("Win the farmer.", "farmer"),
    }),
  );
  const seen = perceive(moved.state, id("bard"), moved.events);
  expect(seen?.events.map((e) => e.kind)).toEqual(["entity-moved"]);
});

// --- Replay and storage ----------------------------------------------------------------------------

test("replaying the log reproduces every god's active goal, and the projection survives encode and decode", () => {
  let state = start();
  const initial = state;
  const log: WorldEvent[] = [];
  for (const queue of [
    [
      propose({
        actor: "hera",
        kind: "goal",
        goal: SET("Make Zeus admit it.", "zeus"),
      }),
    ],
    [
      propose({
        actor: "zeus",
        kind: "goal",
        goal: SET("Punish the farmer.", "farmer"),
      }),
    ],
    [
      propose({
        actor: "hera",
        kind: "move",
        to: "square",
        goal: SET("Win the farmer.", "farmer"),
      }),
    ],
    [propose({ actor: "zeus", kind: "goal", goal: END("achieved") })],
  ]) {
    const result = tick(state, ...queue);
    state = result.state;
    log.push(...result.events);
  }
  const replayed = applyEvents(initial, log);
  expect([...replayed.goals]).toEqual([...state.goals]);
  expect(String(getGoal(replayed, id("hera"))?.target)).toBe("farmer");
  expect(getGoal(replayed, id("zeus"))).toBeUndefined();

  const restored = decode(JSON.parse(JSON.stringify(encode(state))));
  expect([...restored.goals]).toEqual([...state.goals]);
});

test("decode refuses a goal held by someone who is not an actor", () => {
  const state = tick(
    start(),
    propose({
      actor: "hera",
      kind: "goal",
      goal: SET("Win the farmer.", "farmer"),
    }),
  ).state;
  const encoded = JSON.parse(JSON.stringify(encode(state)));
  expect(() => decode(encoded)).not.toThrow();
  const [, goal] = encoded.goals[0];
  expect(() => decode({ ...encoded, goals: [["ghost", goal]] })).toThrow(
    /ghost/,
  );
  expect(() =>
    decode({ ...encoded, goals: [["hera", { ...goal, text: "" }]] }),
  ).toThrow();
});
