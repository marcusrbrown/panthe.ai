import { expect, test } from "bun:test";
import { parseContentPack } from "./content";

function validRules(): Record<string, unknown> {
  return {
    catchUpCapMs: 3_600_000,
    catchUpChunkMs: 60_000,
    checkpointIntervalMs: 60_000,
    importMaxBytes: 50_000_000,
    importMaxRows: 1_000_000,
    importMaxDurationMs: 30_000,
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
        edges: [{ to: "tavern", transport: "path", bidirectional: true }],
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
