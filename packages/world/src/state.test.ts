import { expect, test } from "bun:test";
import type { ContentPack } from "@panthea/contracts";
import {
  createInitialWorldState,
  createPrng,
  getBuilding,
  getEntityRevision,
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
  expect(getEntityRevision(state, toEntityId("npc-1"))).toBe(3);
  expect(getEntityRevision(state, toEntityId("agora"))).toBe(0);
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
    services: ["trade"],
    owner: "farmer",
    revision: 0,
  });
  expect(building?.inventory.get("food")).toBe(5);
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
    services: [],
    inventory: new Map(),
    revision: 0,
  });
  expect(getBuilding(state, toEntityId("shed"))).toMatchObject({
    name: "Shed",
  });
});
