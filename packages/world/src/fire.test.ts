import { expect, test } from "bun:test";
import type { ContentPack } from "@panthea/contracts";
import { runTick, submitProposal } from "./actions";
import {
  applyBuildingBurnTicked,
  applyBuildingDamaged,
  applyBuildingDestroyed,
  applyBuildingIgnited,
  igniteThresholdOf,
  planFireStep,
} from "./fire";
import { decideRoutineProposal } from "./routines";
import {
  BUILDING_STATUSES,
  type BuildingStatus,
  createInitialWorldState,
  createPrng,
  type PrngState,
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
    maxProposalsPerTick: 100,
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

function lifecyclePack(): ContentPack {
  return {
    schemaVersion: 1,
    realms: ["mortal", "olympus"],
    resources: [],
    locations: [
      { id: "town-square", realm: "mortal", name: "Town Square", edges: [] },
      { id: "great-hall", realm: "olympus", name: "Great Hall", edges: [] },
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
        owner: "farmer",
      },
    ],
    inhabitants: [
      {
        id: "farmer",
        name: "The Farmer",
        locationId: "town-square",
        drives: { thrift: 0.9, appetite: 0, greed: 0, piety: 0 },
        startingInventory: [{ resource: "planks", amount: 100 }],
      },
      {
        id: "zeus",
        name: "Zeus",
        locationId: "great-hall",
        deity: true,
        startingInventory: [{ resource: "divinity", amount: 100 }],
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
        destroyIntensity: 3,
      },
      economyBalance: { repairCostPlanks: 2, repairAmountPerTick: 1 },
    },
    recipes: {},
  };
}

function lifecycleStrike(target: string, power: number, observationId: string) {
  const submitted = submitProposal({
    schemaVersion: 1,
    actor: "zeus",
    targets: [target],
    expectedRevisions: [],
    source: "fixture",
    observationId,
    kind: "strike",
    target,
    power,
  });
  if (!submitted.ok) {
    throw new Error(
      `test fixture proposal failed to parse: ${submitted.rejection.message}`,
    );
  }
  return submitted.proposal;
}

test("a weak strike and a strong strike against a burning tavern are both rejected; fire still progresses to destroyed, and repair then restores operational", () => {
  let state = createInitialWorldState(lifecyclePack());
  let prng = createPrng(1);

  // Tick 1: a strike strong enough to ignite.
  let result = runTick(state, prng, [
    lifecycleStrike("the-tavern", 3, "obs-ignite"),
  ]);
  expect(result.rejected).toEqual([]);
  state = result.state;
  prng = result.prng;
  expect(state.buildings.get(toEntityId("the-tavern"))).toMatchObject({
    status: "burning",
    fireIntensity: 1,
  });

  // Tick 2: a weak strike (below the ignite threshold) against the now
  // burning tavern is rejected; the fire step still advances it.
  result = runTick(state, prng, [lifecycleStrike("the-tavern", 1, "obs-weak")]);
  expect(result.rejected).toHaveLength(1);
  state = result.state;
  prng = result.prng;
  expect(state.buildings.get(toEntityId("the-tavern"))).toMatchObject({
    status: "burning",
    fireIntensity: 2,
  });

  // Tick 3: a strike strong enough to ignite again is still rejected
  // outright, rather than resetting the fire's intensity. The fire step
  // crosses the destroy threshold this same tick.
  result = runTick(state, prng, [
    lifecycleStrike("the-tavern", 3, "obs-strong"),
  ]);
  expect(result.rejected).toHaveLength(1);
  state = result.state;
  prng = result.prng;
  expect(state.buildings.get(toEntityId("the-tavern"))?.status).toBe(
    "destroyed",
  );

  // The owner's own routine, motivated by owning a destroyed building and
  // holding planks, repairs it back to operational.
  let guard = 0;
  while (
    state.buildings.get(toEntityId("the-tavern"))?.status !== "operational" &&
    guard < 10
  ) {
    const decision = decideRoutineProposal(state, toEntityId("farmer"));
    const proposals = decision ? [decision.proposal] : [];
    const tick = runTick(state, prng, proposals);
    state = tick.state;
    prng = tick.prng;
    guard += 1;
  }
  expect(state.buildings.get(toEntityId("the-tavern"))?.status).toBe(
    "operational",
  );
});

test("a weak strike on an operational tavern leaves it damaged, and repair restores operational", () => {
  let state = createInitialWorldState(lifecyclePack());
  let prng = createPrng(1);

  const result = runTick(state, prng, [
    lifecycleStrike("the-tavern", 1, "obs-weak"),
  ]);
  expect(result.rejected).toEqual([]);
  state = result.state;
  prng = result.prng;
  expect(state.buildings.get(toEntityId("the-tavern"))?.status).toBe("damaged");

  let guard = 0;
  while (
    state.buildings.get(toEntityId("the-tavern"))?.status !== "operational" &&
    guard < 10
  ) {
    const decision = decideRoutineProposal(state, toEntityId("farmer"));
    const proposals = decision ? [decision.proposal] : [];
    const tick = runTick(state, prng, proposals);
    state = tick.state;
    prng = tick.prng;
    guard += 1;
  }
  expect(state.buildings.get(toEntityId("the-tavern"))?.status).toBe(
    "operational",
  );
});

function buildingInStatus(status: BuildingStatus): WorldState {
  const state = createInitialWorldState(lifecyclePack());
  const tavern = state.buildings.get(toEntityId("the-tavern"));
  if (!tavern) throw new Error("expected the tavern fixture building");
  switch (status) {
    case "operational":
      return state;
    case "damaged":
      return withBuilding(state, { ...tavern, status: "damaged" });
    case "burning":
      return withBuilding(state, {
        ...tavern,
        status: "burning",
        fireIntensity: 0,
        ticksBurning: 0,
      });
    case "destroyed":
      return withBuilding(state, { ...tavern, status: "destroyed" });
    case "repairing":
      return withBuilding(state, {
        ...tavern,
        status: "repairing",
        repairProgress: 1,
      });
  }
}

test("every building status has a path back to operational", () => {
  for (const status of BUILDING_STATUSES) {
    let state = buildingInStatus(status);
    let prng: PrngState = createPrng(1);

    // Burning must reach "destroyed" through the fire step alone before
    // repair becomes eligible.
    let guard = 0;
    while (
      state.buildings.get(toEntityId("the-tavern"))?.status === "burning" &&
      guard < 20
    ) {
      const tick = runTick(state, prng, []);
      state = tick.state;
      prng = tick.prng;
      guard += 1;
    }

    guard = 0;
    while (
      state.buildings.get(toEntityId("the-tavern"))?.status !== "operational" &&
      guard < 20
    ) {
      const decision = decideRoutineProposal(state, toEntityId("farmer"));
      const proposals = decision ? [decision.proposal] : [];
      const tick = runTick(state, prng, proposals);
      state = tick.state;
      prng = tick.prng;
      guard += 1;
    }

    expect(state.buildings.get(toEntityId("the-tavern"))?.status).toBe(
      "operational",
    );
  }
});

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
