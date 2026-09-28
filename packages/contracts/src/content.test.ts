import { expect, test } from "bun:test";
import { parseContentPack } from "./content";

function validRules(): Record<string, unknown> {
  return {
    catchUpCapMs: 3_600_000,
    catchUpChunkMs: 60_000,
    checkpointIntervalMs: 60_000,
    fireBalance: { spreadChancePerTick: 0.1 },
    economyBalance: { priceFloor: 1, priceCeiling: 100 },
  };
}

function validPack(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    realms: ["mortal", "olympus", "underworld"],
    resources: [{ resource: "currency", amount: 1000 }],
    locations: [
      {
        id: "agora",
        realm: "mortal",
        name: "The Agora",
        edges: [{ to: "market-road", transport: "path", bidirectional: true }],
      },
      {
        id: "market-road",
        realm: "mortal",
        name: "Market Road",
        edges: [],
      },
    ],
    buildings: [
      {
        id: "tavern",
        locationId: "agora",
        name: "The Tavern",
        material: "wood",
        services: ["lodging"],
        inventory: [{ resource: "wine", amount: 10 }],
        owner: "npc-1",
      },
    ],
    inhabitants: [
      {
        id: "npc-1",
        name: "Tavernkeeper",
        locationId: "agora",
        drives: { thrift: 0.5, appetite: 0.2, greed: 0.1, piety: 0.3 },
      },
    ],
    rules: validRules(),
  };
}

test("a valid minimal content pack parses", () => {
  const result = parseContentPack(validPack());
  expect(result.ok).toBe(true);
});

test("a location referencing an unknown realm fails to load", () => {
  const pack = validPack();
  (pack.locations as Record<string, unknown>[])[0].realm = "atlantis";
  const result = parseContentPack(pack);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.path).toBe("locations[0].realm");
  }
});

test("a location may declare a required capability to enter it", () => {
  const pack = validPack();
  (pack.locations as Record<string, unknown>[])[0].requiredCapability =
    "divine";
  const result = parseContentPack(pack);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.locations[0]).toMatchObject({
      requiredCapability: "divine",
    });
  }
});

test("a location without a required capability parses with it absent", () => {
  const result = parseContentPack(validPack());
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.locations[0].requiredCapability).toBeUndefined();
  }
});

test("a location with a non-string required capability is rejected", () => {
  const pack = validPack();
  (pack.locations as Record<string, unknown>[])[0].requiredCapability = 42;
  const result = parseContentPack(pack);
  expect(result.ok).toBe(false);
});

test("a building with a negative inventory amount is rejected", () => {
  const pack = validPack();
  (pack.buildings as Record<string, unknown>[])[0].inventory = [
    { resource: "wine", amount: -1 },
  ];
  const result = parseContentPack(pack);
  expect(result.ok).toBe(false);
});

test("an unsupported content schema version is rejected", () => {
  const pack = validPack();
  pack.schemaVersion = 99;
  const result = parseContentPack(pack);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe("unsupported-version");
  }
});

test("rules with a non-numeric balance value are rejected", () => {
  const pack = validPack();
  (pack.rules as Record<string, unknown>).fireBalance = {
    spreadChancePerTick: "high",
  };
  const result = parseContentPack(pack);
  expect(result.ok).toBe(false);
});

test("an edge referencing an unknown location fails referential integrity", () => {
  const pack = validPack();
  (pack.locations as Record<string, unknown>[])[0].edges = [
    { to: "nowhere", transport: "path", bidirectional: true },
  ];
  const result = parseContentPack(pack);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe("malformed");
    expect(result.path).toBe("locations[0].edges[0].to");
  }
});

test("a location realm not declared in the pack's realms list fails referential integrity", () => {
  const pack = validPack();
  pack.realms = ["mortal"];
  (pack.locations as Record<string, unknown>[]).push({
    id: "underworld-entry",
    realm: "underworld",
    name: "Underworld Entry",
    edges: [],
  });
  const result = parseContentPack(pack);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe("malformed");
    expect(result.path).toBe("locations[2].realm");
  }
});

test("a building referencing an unknown location fails referential integrity", () => {
  const pack = validPack();
  (pack.buildings as Record<string, unknown>[])[0].locationId = "nowhere";
  const result = parseContentPack(pack);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe("malformed");
    expect(result.path).toBe("buildings[0].locationId");
  }
});

test("an inhabitant referencing an unknown location fails referential integrity", () => {
  const pack = validPack();
  (pack.inhabitants as Record<string, unknown>[])[0].locationId = "nowhere";
  const result = parseContentPack(pack);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe("malformed");
    expect(result.path).toBe("inhabitants[0].locationId");
  }
});

test("an inhabitant may declare a gathered resource and a starting inventory", () => {
  const pack = validPack();
  (pack.inhabitants as Record<string, unknown>[])[0].gathers = "wine";
  (pack.inhabitants as Record<string, unknown>[])[0].startingInventory = [
    { resource: "currency", amount: 5 },
  ];
  const result = parseContentPack(pack);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.inhabitants[0]).toMatchObject({
      gathers: "wine",
      startingInventory: [{ resource: "currency", amount: 5 }],
    });
  }
});

test("an inhabitant without gathers, wants, or startingInventory parses with them absent", () => {
  const result = parseContentPack(validPack());
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.inhabitants[0].gathers).toBeUndefined();
    expect(result.value.inhabitants[0].wants).toBeUndefined();
    expect(result.value.inhabitants[0].startingInventory).toBeUndefined();
  }
});

test("an inhabitant may declare a wanted resource to buy", () => {
  const pack = validPack();
  (pack.inhabitants as Record<string, unknown>[])[0].wants = "planks";
  const result = parseContentPack(pack);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.inhabitants[0]).toMatchObject({ wants: "planks" });
  }
});

test("a building owner referencing an unknown inhabitant fails referential integrity", () => {
  const pack = validPack();
  (pack.buildings as Record<string, unknown>[])[0].owner = "nobody";
  const result = parseContentPack(pack);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe("malformed");
    expect(result.path).toBe("buildings[0].owner");
  }
});

test("a valid recipe converting inputs to outputs parses", () => {
  const pack = validPack();
  pack.recipes = {
    planks: {
      inputs: [{ resource: "wood", amount: 2 }],
      outputs: [{ resource: "planks", amount: 1 }],
    },
  };
  const result = parseContentPack(pack);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.recipes.planks).toMatchObject({
      inputs: [{ resource: "wood", amount: 2 }],
      outputs: [{ resource: "planks", amount: 1 }],
    });
  }
});

test("a pack with no recipes key parses with an empty recipes record", () => {
  const result = parseContentPack(validPack());
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.recipes).toEqual({});
  }
});

test("a recipe with a malformed input is rejected", () => {
  const pack = validPack();
  pack.recipes = {
    planks: {
      inputs: [{ resource: "wood", amount: -1 }],
      outputs: [{ resource: "planks", amount: 1 }],
    },
  };
  const result = parseContentPack(pack);
  expect(result.ok).toBe(false);
});

test("duplicate location ids fail referential integrity", () => {
  const pack = validPack();
  (pack.locations as Record<string, unknown>[]).push({
    id: "agora",
    realm: "mortal",
    name: "Duplicate Agora",
    edges: [],
  });
  const result = parseContentPack(pack);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe("malformed");
    expect(result.path).toBe("locations[2].id");
  }
});
