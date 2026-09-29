import { expect, test } from "bun:test";
import type { ContentPack, WorldEvent } from "@panthea/contracts";
import {
  MAX_PERCEIVED_EVENTS,
  perceive,
  perceivedLocations,
} from "./perception";
import {
  createInitialWorldState,
  getActor,
  toEntityId,
  type WorldState,
  withActor,
} from "./state";

function fixtureState(): WorldState {
  const pack: ContentPack = {
    schemaVersion: 1,
    realms: ["mortal", "olympus", "underworld"],
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
        edges: [
          {
            to: "olympus-gate",
            transport: "divine-transport",
            bidirectional: true,
          },
        ],
      },
      { id: "olympus-gate", realm: "olympus", name: "Olympus Gate", edges: [] },
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
        startingInventory: [{ resource: "divinity", amount: 10 }],
      },
      {
        id: "farmer",
        name: "The Farmer",
        locationId: "tavern",
        startingInventory: [{ resource: "currency", amount: 7 }],
      },
      {
        id: "woodcutter",
        name: "The Woodcutter",
        locationId: "square",
        startingInventory: [{ resource: "currency", amount: 3 }],
      },
    ],
    rules: {
      catchUpCapMs: 3_600_000,
      catchUpChunkMs: 60_000,
      checkpointIntervalMs: 60_000,
      maxProposalsPerTick: 100,
      fireBalance: {},
      economyBalance: {},
    },
    recipes: {},
  };
  return createInitialWorldState(pack);
}

const id = toEntityId;

let nextSequence = 1;

/** A committed event with a fixed envelope; `sequence` defaults to the next unused number. */
function event(
  payload: Record<string, unknown>,
  sequence = nextSequence++,
): WorldEvent {
  return {
    schemaVersion: 1,
    id: `evt-${sequence}`,
    sequence,
    simTime: sequence * 1000,
    correlationId: `obs-${sequence}`,
    causationId: `obs-${sequence}`,
    approximate: false,
    ...payload,
  } as unknown as WorldEvent;
}

const ignited = (building: string, sequence?: number) =>
  event({ kind: "building-ignited", entityId: building }, sequence);
const gathered = (actor: string, sequence?: number) =>
  event(
    { kind: "resource-gathered", entityId: actor, resource: "wood", amount: 2 },
    sequence,
  );
const moved = (actor: string, to: string, sequence?: number) =>
  event({ kind: "entity-moved", entityId: actor, to }, sequence);

function actorAt(
  state: WorldState,
  actorId: string,
  locationId: string,
): WorldState {
  const actor = getActor(state, id(actorId));
  if (!actor) throw new Error(`fixture has no ${actorId}`);
  return withActor(state, { ...actor, locationId: id(locationId) });
}

const ids = (items: readonly { readonly id: string }[]) =>
  items.map((item) => item.id).sort();

test("Zeus at the tavern perceives its location, the actors and buildings there with revisions, and his own goods", () => {
  const snapshot = perceive(fixtureState(), id("zeus"));
  expect(snapshot).toBeDefined();
  if (!snapshot) return;

  expect(snapshot.observer).toBe(id("zeus"));
  expect(snapshot.location as unknown).toEqual({
    id: "tavern",
    name: "The Tavern",
    realm: "mortal",
    revision: 0,
  });
  expect(ids(snapshot.actors)).toEqual(["farmer"]);
  expect(snapshot.actors[0]).toMatchObject({
    id: "farmer",
    locationId: "tavern",
    revision: 0,
  });
  expect(ids(snapshot.buildings)).toEqual(["the-tavern"]);
  expect(snapshot.buildings[0]).toMatchObject({
    id: "the-tavern",
    status: "operational",
    revision: 0,
  });
  expect(snapshot.self).toMatchObject({
    id: "zeus",
    revision: 0,
    divinity: 10,
    inventory: [{ resource: "divinity", amount: 10 }],
  });
  expect(snapshot.exits as unknown).toEqual([
    { to: "square", name: "The Square", realm: "mortal", transport: "path" },
  ]);
});

test("an actor, building, and events at another location are absent; moving Zeus there makes them present", () => {
  const events = [
    ignited("old-oak"),
    gathered("woodcutter"),
    ignited("the-tavern"),
  ];

  const atTavern = perceive(fixtureState(), id("zeus"), events);
  expect(atTavern).toBeDefined();
  if (!atTavern) return;
  expect(ids(atTavern.actors)).not.toContain("woodcutter");
  expect(ids(atTavern.buildings)).not.toContain("old-oak");
  expect(atTavern.events.map((e) => e.kind)).toEqual(["building-ignited"]);
  expect(JSON.stringify(atTavern.events)).toContain("the-tavern");
  expect(JSON.stringify(atTavern)).not.toContain("old-oak");
  expect(JSON.stringify(atTavern)).not.toContain("woodcutter");

  const atSquare = perceive(
    actorAt(fixtureState(), "zeus", "square"),
    id("zeus"),
    events,
  );
  expect(atSquare).toBeDefined();
  if (!atSquare) return;
  expect(ids(atSquare.actors)).toEqual(["woodcutter"]);
  expect(ids(atSquare.buildings)).toEqual(["old-oak"]);
  expect(atSquare.events.map((e) => e.kind).sort()).toEqual([
    "building-ignited",
    "resource-gathered",
  ]);
  expect(ids(atSquare.actors)).not.toContain("farmer");
  expect(JSON.stringify(atSquare)).not.toContain("the-tavern");
});

test("other actors are seen by id and revision only: their inventories stay unseen", () => {
  const snapshot = perceive(fixtureState(), id("zeus"));
  if (!snapshot) throw new Error("expected a snapshot");
  expect(Object.keys(snapshot.actors[0]).sort()).toEqual([
    "id",
    "isDeity",
    "locationId",
    "revision",
  ]);
  expect(JSON.stringify(snapshot.actors)).not.toContain("currency");
});

test("an actor's event is placed where the actor was when it happened, not where it is now", () => {
  // The farmer gathered at the square, then walked to the tavern. Zeus at the
  // tavern sees the arrival but not the earlier gather.
  const afterWalk = actorAt(fixtureState(), "farmer", "tavern");
  const events = [gathered("farmer", 10), moved("farmer", "tavern", 11)];
  const seen = perceive(afterWalk, id("zeus"), events);
  expect(seen?.events.map((e) => e.kind)).toEqual(["entity-moved"]);

  // The farmer arrived at the tavern, gathered, then left for the square:
  // the gather happened in front of Zeus.
  const afterLeaving = actorAt(fixtureState(), "farmer", "square");
  const arrivedThenLeft = [
    moved("farmer", "tavern", 20),
    gathered("farmer", 21),
    moved("farmer", "square", 22),
  ];
  const witnessed = perceive(afterLeaving, id("zeus"), arrivedThenLeft);
  expect(witnessed?.events.map((e) => e.sequence)).toEqual([20, 21]);
});

test("the snapshot keeps only the most recent perceived events, oldest first", () => {
  const many = Array.from({ length: MAX_PERCEIVED_EVENTS + 3 }, (_, index) =>
    ignited("the-tavern", 100 + index),
  );
  const snapshot = perceive(fixtureState(), id("zeus"), many);
  expect(snapshot?.events).toHaveLength(MAX_PERCEIVED_EVENTS);
  expect(snapshot?.events[0]?.sequence).toBe(103);
  expect(snapshot?.events.at(-1)?.sequence).toBe(
    100 + MAX_PERCEIVED_EVENTS + 2,
  );
});

test("a dead or unknown observer perceives nothing, and dead neighbors are not listed", () => {
  const state = fixtureState();
  expect(perceive(state, id("nobody"))).toBeUndefined();

  const farmer = getActor(state, id("farmer"));
  if (!farmer) throw new Error("fixture has no farmer");
  const withDeadFarmer = withActor(state, { ...farmer, alive: false });
  expect(perceive(withDeadFarmer, id("farmer"))).toBeUndefined();
  expect(ids(perceive(withDeadFarmer, id("zeus"))?.actors ?? [])).toEqual([]);
});

test("perceive is a pure function of state and events", () => {
  const state = fixtureState();
  const events = [ignited("the-tavern")];
  const before = JSON.stringify(perceive(state, id("zeus"), events));
  expect(JSON.stringify(perceive(state, id("zeus"), events))).toBe(before);
  expect(state.tick).toBe(0);
  expect(getActor(state, id("zeus"))?.locationId).toBe(id("tavern"));
});

test("the locations an actor perceives are its own location alone until a sensing power widens them", () => {
  const state = fixtureState();
  const zeus = getActor(state, id("zeus"));
  if (!zeus) throw new Error("fixture has no zeus");
  expect([...perceivedLocations(state, zeus)]).toEqual([id("tavern")]);
});
