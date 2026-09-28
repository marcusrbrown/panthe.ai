import { expect, test } from "bun:test";
import type { ContentPack } from "@panthea/contracts";
import {
  applyBuildingBurnTicked,
  applyBuildingDamaged,
  applyBuildingDestroyed,
  applyBuildingIgnited,
  igniteThresholdOf,
  planFireStep,
} from "./fire";
import {
  createInitialWorldState,
  createPrng,
  toEntityId,
  type WorldState,
  withBuilding,
} from "./state";

function minimalRules(
  fireBalance: Record<string, number> = {},
): ContentPack["rules"] {
  return {
    catchUpCapMs: 0,
    catchUpChunkMs: 0,
    checkpointIntervalMs: 0,
    fireBalance,
    economyBalance: {},
  };
}

function townPack(fireBalance: Record<string, number> = {}): ContentPack {
  return {
    schemaVersion: 1,
    realms: ["mortal"],
    resources: [],
    locations: [
      {
        id: "town-square",
        realm: "mortal",
        name: "Town Square",
        edges: [{ to: "shore", transport: "path", bidirectional: true }],
      },
      { id: "shore", realm: "mortal", name: "Shore", edges: [] },
    ],
    buildings: [
      {
        id: "the-tavern",
        locationId: "town-square",
        name: "The Tavern",
        material: "wood",
        combustible: true,
        services: ["drink"],
        inventory: [{ resource: "wine", amount: 4 }],
        owner: "farmer",
      },
      {
        id: "old-oak",
        locationId: "town-square",
        name: "The Old Oak",
        material: "wood",
        combustible: true,
        services: [],
        inventory: [],
      },
      {
        id: "agora-shop",
        locationId: "town-square",
        name: "The Agora Shop",
        material: "stone",
        combustible: false,
        services: ["trade"],
        inventory: [],
        owner: "farmer",
      },
    ],
    inhabitants: [
      {
        id: "farmer",
        name: "The Farmer",
        locationId: "town-square",
      },
    ],
    rules: minimalRules(fireBalance),
    recipes: {},
  };
}

function burning(state: WorldState): WorldState {
  const tavern = state.buildings.get(toEntityId("the-tavern"));
  if (!tavern) throw new Error("expected the tavern fixture building");
  return withBuilding(state, {
    ...tavern,
    status: "burning",
    fireIntensity: 0,
    ticksBurning: 0,
  });
}

test("igniteThresholdOf reads the content-authored threshold, defaulting to unreachable", () => {
  const withoutThreshold = createInitialWorldState(townPack());
  expect(igniteThresholdOf(withoutThreshold)).toBe(Number.POSITIVE_INFINITY);
  const withThreshold = createInitialWorldState(
    townPack({ igniteThreshold: 3 }),
  );
  expect(igniteThresholdOf(withThreshold)).toBe(3);
});

test("a burning building's intensity grows each step until it crosses the destroy threshold", () => {
  const state = burning(
    createInitialWorldState(
      townPack({ intensityGrowthPerTick: 1, destroyIntensity: 2 }),
    ),
  );
  const step = planFireStep(state, createPrng(1));
  expect(step.events).toContainEqual(
    expect.objectContaining({
      kind: "building-burn-ticked",
      entityId: "the-tavern",
      fireIntensity: 1,
      ticksBurning: 1,
    }),
  );
});

test("a building is destroyed once its intensity crosses the threshold, disposing its inventory", () => {
  const state = burning(
    createInitialWorldState(
      townPack({ intensityGrowthPerTick: 5, destroyIntensity: 3 }),
    ),
  );
  const step = planFireStep(state, createPrng(1));
  expect(step.events).toContainEqual(
    expect.objectContaining({
      kind: "building-destroyed",
      entityId: "the-tavern",
      disposedInventory: [{ resource: "wine", amount: 4 }],
    }),
  );
});

test("a non-combustible neighbor never ignites, regardless of spread chance", () => {
  const state = burning(
    createInitialWorldState(
      townPack({ spreadChancePerTick: 1, maxSpreadPerTick: 10 }),
    ),
  );
  const step = planFireStep(state, createPrng(1));
  const ignitedIds = step.events
    .filter((event) => event.kind === "building-ignited")
    .map((event) => (event as { entityId: string }).entityId);
  expect(ignitedIds).not.toContain("agora-shop");
});

test("spread is bounded by maxSpreadPerTick even when every neighbor rolls a hit", () => {
  const state = burning(
    createInitialWorldState(
      townPack({ spreadChancePerTick: 1, maxSpreadPerTick: 1 }),
    ),
  );
  const step = planFireStep(state, createPrng(1));
  const ignitions = step.events.filter(
    (event) => event.kind === "building-ignited",
  );
  expect(ignitions.length).toBeLessThanOrEqual(1);
});

test("the same seed and state produce the same fire outcome", () => {
  const state = burning(
    createInitialWorldState(
      townPack({
        spreadChancePerTick: 0.5,
        maxSpreadPerTick: 5,
        intensityGrowthPerTick: 1,
        destroyIntensity: 5,
      }),
    ),
  );
  const stepA = planFireStep(state, createPrng(7));
  const stepB = planFireStep(state, createPrng(7));
  expect(stepA.events).toEqual(stepB.events);
  expect(stepA.prng).toEqual(stepB.prng);
});

test("applyBuildingDamaged marks a building damaged without touching its inventory", () => {
  const state = createInitialWorldState(townPack());
  const next = applyBuildingDamaged(state, toEntityId("the-tavern"));
  const tavern = next.buildings.get(toEntityId("the-tavern"));
  expect(tavern?.status).toBe("damaged");
  expect(tavern?.inventory.get("wine")).toBe(4);
});

test("applyBuildingIgnited starts a fresh burn at zero intensity and ticks", () => {
  const state = createInitialWorldState(townPack());
  const next = applyBuildingIgnited(state, toEntityId("the-tavern"));
  expect(next.buildings.get(toEntityId("the-tavern"))).toMatchObject({
    status: "burning",
    fireIntensity: 0,
    ticksBurning: 0,
  });
});

test("applyBuildingBurnTicked updates intensity and tick count in place", () => {
  const state = burning(createInitialWorldState(townPack()));
  const next = applyBuildingBurnTicked(state, toEntityId("the-tavern"), 2, 2);
  expect(next.buildings.get(toEntityId("the-tavern"))).toMatchObject({
    fireIntensity: 2,
    ticksBurning: 2,
  });
});

test("applyBuildingDestroyed disposes inventory and exposes no services", () => {
  const state = burning(createInitialWorldState(townPack()));
  const next = applyBuildingDestroyed(state, toEntityId("the-tavern"));
  const tavern = next.buildings.get(toEntityId("the-tavern"));
  expect(tavern?.status).toBe("destroyed");
  expect(tavern?.inventory.size).toBe(0);
});
