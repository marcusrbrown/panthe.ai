import { expect, test } from "bun:test";
import type { ContentPack } from "@panthea/contracts";
import {
  activeFavors,
  createInitialWorldState,
  createPrng,
  effectiveServices,
  getBuilding,
  getEntityRevision,
  isFavorActive,
  nextPrngValue,
  toEntityId,
  withActor,
  withBuilding,
} from "./state";

test("the same PRNG seed produces the same sequence of values", () => {
  let a = createPrng(42);
  let b = createPrng(42);
  const valuesA: number[] = [];
  const valuesB: number[] = [];
  for (let i = 0; i < 5; i++) {
    const drawA = nextPrngValue(a);
    const drawB = nextPrngValue(b);
    valuesA.push(drawA.value);
    valuesB.push(drawB.value);
    a = drawA.state;
    b = drawB.state;
  }
  expect(valuesA).toEqual(valuesB);
  // Every draw is in [0, 1) and the sequence isn't degenerate (constant).
  for (const value of valuesA) {
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
  }
  expect(new Set(valuesA).size).toBeGreaterThan(1);
});

test("different seeds produce different sequences", () => {
  const drawA = nextPrngValue(createPrng(1));
  const drawB = nextPrngValue(createPrng(2));
  expect(drawA.value).not.toBe(drawB.value);
});

test("getEntityRevision looks up both actors and locations by id", () => {
  const pack = {
    schemaVersion: 1 as const,
    realms: ["mortal"] as const,
    resources: [],
    locations: [
      { id: "agora", realm: "mortal" as const, name: "Agora", edges: [] },
    ],
    buildings: [],
    inhabitants: [],
    rules: {
      catchUpCapMs: 0,
      catchUpChunkMs: 0,
      checkpointIntervalMs: 0,
      fireBalance: {},
      economyBalance: {},
    },
    recipes: {},
  };
  let state = createInitialWorldState(pack);
  state = withActor(state, {
    id: toEntityId("npc-1"),
    locationId: toEntityId("agora"),
    alive: true,
    capabilities: [],
    inventory: new Map(),
    revision: 3,
  });
  state = withBuilding(state, {
    id: toEntityId("shed"),
    locationId: toEntityId("agora"),
    name: "Shed",
    material: "wood",
    combustible: true,
    services: [],
    inventory: new Map(),
    status: "operational",
    revision: 7,
  });
  expect(getEntityRevision(state, toEntityId("npc-1"))).toBe(3);
  expect(getEntityRevision(state, toEntityId("agora"))).toBe(0);
  expect(getEntityRevision(state, toEntityId("shed"))).toBe(7);
  expect(getEntityRevision(state, toEntityId("unknown"))).toBeUndefined();
});

function minimalRules(
  economyBalance: Record<string, number> = {},
): ContentPack["rules"] {
  return {
    catchUpCapMs: 0,
    catchUpChunkMs: 0,
    checkpointIntervalMs: 0,
    fireBalance: {},
    economyBalance,
  };
}

test("createInitialWorldState seeds actors from authored inhabitants, with their inventory and drives", () => {
  const pack: ContentPack = {
    schemaVersion: 1,
    realms: ["mortal"],
    resources: [],
    locations: [{ id: "square", realm: "mortal", name: "Square", edges: [] }],
    buildings: [],
    inhabitants: [
      {
        id: "woodcutter",
        name: "The Woodcutter",
        locationId: "square",
        drives: { thrift: 0.6, appetite: 0.3, greed: 0.4, piety: 0.1 },
        gathers: "wood",
        startingInventory: [{ resource: "currency", amount: 5 }],
      },
    ],
    rules: minimalRules(),
    recipes: {},
  };
  const state = createInitialWorldState(pack);
  const actor = state.actors.get(toEntityId("woodcutter"));
  expect(actor).toMatchObject({
    locationId: "square",
    alive: true,
    revision: 0,
    drives: { thrift: 0.6, appetite: 0.3, greed: 0.4, piety: 0.1 },
    gathers: "wood",
  });
  expect(actor?.inventory.get("currency")).toBe(5);
});

test("createInitialWorldState seeds buildings from authored content, with their inventory and owner", () => {
  const pack: ContentPack = {
    schemaVersion: 1,
    realms: ["mortal"],
    resources: [],
    locations: [{ id: "shop", realm: "mortal", name: "Shop", edges: [] }],
    buildings: [
      {
        id: "agora-shop",
        locationId: "shop",
        name: "The Agora Shop",
        material: "stone",
        combustible: false,
        services: ["trade"],
        inventory: [{ resource: "food", amount: 5 }],
        owner: "farmer",
      },
    ],
    inhabitants: [
      {
        id: "farmer",
        name: "The Farmer",
        locationId: "shop",
        drives: { thrift: 0.2, appetite: 0.5, greed: 0.2, piety: 0.1 },
      },
    ],
    rules: minimalRules(),
    recipes: {},
  };
  const state = createInitialWorldState(pack);
  const building = getBuilding(state, toEntityId("agora-shop"));
  expect(building).toMatchObject({
    locationId: "shop",
    name: "The Agora Shop",
    material: "stone",
    combustible: false,
    services: ["trade"],
    owner: "farmer",
    status: "operational",
    revision: 0,
  });
  expect(building?.inventory.get("food")).toBe(5);
});

test("an inhabitant with no authored drives seeds an actor with drives absent", () => {
  const pack: ContentPack = {
    schemaVersion: 1,
    realms: ["olympus"],
    resources: [],
    locations: [
      { id: "great-hall", realm: "olympus", name: "Great Hall", edges: [] },
    ],
    buildings: [],
    inhabitants: [
      {
        id: "zeus",
        name: "Zeus",
        locationId: "great-hall",
        startingInventory: [{ resource: "divinity", amount: 10 }],
      },
    ],
    rules: minimalRules(),
    recipes: {},
  };
  const state = createInitialWorldState(pack);
  const actor = state.actors.get(toEntityId("zeus"));
  expect(actor?.drives).toBeUndefined();
  expect(actor?.inventory.get("divinity")).toBe(10);
});

test("withBuilding adds or replaces a building without touching others", () => {
  const pack: ContentPack = {
    schemaVersion: 1,
    realms: ["mortal"],
    resources: [],
    locations: [{ id: "square", realm: "mortal", name: "Square", edges: [] }],
    buildings: [],
    inhabitants: [],
    rules: minimalRules(),
    recipes: {},
  };
  let state = createInitialWorldState(pack);
  state = withBuilding(state, {
    id: toEntityId("shed"),
    locationId: toEntityId("square"),
    name: "Shed",
    material: "wood",
    combustible: true,
    services: [],
    inventory: new Map(),
    status: "operational",
    revision: 0,
  });
  expect(getBuilding(state, toEntityId("shed"))).toMatchObject({
    name: "Shed",
  });
});

test("isFavorActive is true strictly before the expiry tick, and false at or after it", () => {
  const favor = {
    source: toEntityId("zeus"),
    effect: "divine-favor",
    expiresAtTick: 10,
  };
  expect(isFavorActive(favor, 9)).toBe(true);
  expect(isFavorActive(favor, 10)).toBe(false);
  expect(isFavorActive(favor, 11)).toBe(false);
});

test("activeFavors filters out expired favors without mutating the actor", () => {
  const actor = {
    id: toEntityId("farmer"),
    locationId: toEntityId("town-square"),
    alive: true,
    capabilities: [],
    inventory: new Map(),
    favors: [
      { source: toEntityId("zeus"), effect: "divine-favor", expiresAtTick: 5 },
      { source: toEntityId("zeus"), effect: "divine-favor", expiresAtTick: 20 },
    ],
    revision: 0,
  };
  expect(activeFavors(actor, 10)).toEqual([
    { source: toEntityId("zeus"), effect: "divine-favor", expiresAtTick: 20 },
  ]);
  expect(actor.favors).toHaveLength(2);
});

test("effectiveServices exposes the authored list only while operational", () => {
  const operational = {
    id: toEntityId("the-tavern"),
    locationId: toEntityId("tavern"),
    name: "The Tavern",
    material: "wood",
    combustible: true,
    services: ["drink"],
    inventory: new Map(),
    status: "operational" as const,
    revision: 0,
  };
  expect(effectiveServices(operational)).toEqual(["drink"]);
  for (const status of [
    "damaged",
    "burning",
    "destroyed",
    "repairing",
  ] as const) {
    expect(effectiveServices({ ...operational, status })).toEqual([]);
  }
});

test("createInitialWorldState seeds every building as operational with no fire or repair state", () => {
  const pack: ContentPack = {
    schemaVersion: 1,
    realms: ["mortal"],
    resources: [],
    locations: [
      { id: "town-square", realm: "mortal", name: "Town Square", edges: [] },
    ],
    buildings: [
      {
        id: "the-tavern",
        locationId: "town-square",
        name: "The Tavern",
        material: "wood",
        combustible: true,
        services: ["drink"],
        inventory: [],
      },
    ],
    inhabitants: [],
    rules: minimalRules(),
    recipes: {},
  };
  const state = createInitialWorldState(pack);
  const building = getBuilding(state, toEntityId("the-tavern"));
  expect(building?.status).toBe("operational");
  expect(building?.fireIntensity).toBeUndefined();
  expect(building?.ticksBurning).toBeUndefined();
  expect(building?.repairProgress).toBeUndefined();
});
