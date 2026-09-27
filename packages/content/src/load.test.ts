import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContentPack } from "./load";

const GREEK_WORLD_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "content",
  "greek",
  "world",
);

function withTempDir(build: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "panthea-content-test-"));
  build(dir);
  return dir;
}

function validLocations(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    realms: ["mortal", "olympus", "underworld"],
    locations: [
      {
        id: "agora",
        realm: "mortal",
        name: "The Agora",
        edges: [{ to: "tavern", transport: "path", bidirectional: true }],
      },
      { id: "tavern", realm: "mortal", name: "The Tavern", edges: [] },
    ],
  };
}

function validRules(): Record<string, unknown> {
  return {
    resources: [{ resource: "currency", amount: 0 }],
    rules: {
      catchUpCapMs: 3_600_000,
      catchUpChunkMs: 60_000,
      checkpointIntervalMs: 60_000,
      importMaxBytes: 50_000_000,
      importMaxRows: 1_000_000,
      importMaxDurationMs: 30_000,
      fireBalance: { spreadChancePerTick: 0.1 },
      economyBalance: { priceFloor: 1, priceCeiling: 100 },
    },
  };
}

test("a valid minimal content pack loads from locations.json and rules.json alone", () => {
  const dir = withTempDir((d) => {
    writeFileSync(join(d, "locations.json"), JSON.stringify(validLocations()));
    writeFileSync(join(d, "rules.json"), JSON.stringify(validRules()));
  });
  const result = loadContentPack(dir);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.locations).toHaveLength(2);
    expect(result.value.buildings).toEqual([]);
    expect(result.value.inhabitants).toEqual([]);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("optional buildings.json and inhabitants.json are picked up when present", () => {
  const dir = withTempDir((d) => {
    writeFileSync(join(d, "locations.json"), JSON.stringify(validLocations()));
    writeFileSync(join(d, "rules.json"), JSON.stringify(validRules()));
    writeFileSync(
      join(d, "buildings.json"),
      JSON.stringify({
        buildings: [
          {
            id: "tavern-bldg",
            locationId: "tavern",
            name: "The Tavern",
            material: "wood",
            services: ["lodging"],
            inventory: [],
          },
        ],
      }),
    );
    writeFileSync(
      join(d, "inhabitants.json"),
      JSON.stringify({
        inhabitants: [
          {
            id: "npc-1",
            name: "Tavernkeeper",
            locationId: "tavern",
            drives: { thrift: 0.5, appetite: 0.2, greed: 0.1, piety: 0.3 },
          },
        ],
      }),
    );
  });
  const result = loadContentPack(dir);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.buildings).toHaveLength(1);
    expect(result.value.inhabitants).toHaveLength(1);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("a missing locations.json fails loudly and distinctly from a parse failure", () => {
  const dir = withTempDir((d) => {
    writeFileSync(join(d, "rules.json"), JSON.stringify(validRules()));
  });
  const result = loadContentPack(dir);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.message).toContain("locations.json");
    expect(result.message).toContain("missing");
  }
  rmSync(dir, { recursive: true, force: true });
});

test("malformed JSON syntax fails loudly with a clear message", () => {
  const dir = withTempDir((d) => {
    writeFileSync(join(d, "locations.json"), "{ not valid json");
    writeFileSync(join(d, "rules.json"), JSON.stringify(validRules()));
  });
  const result = loadContentPack(dir);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.message).toContain("not valid JSON");
  }
  rmSync(dir, { recursive: true, force: true });
});

test("a location referencing an unknown realm fails to load with a clear message", () => {
  const dir = withTempDir((d) => {
    const locations = validLocations();
    (locations.locations as Record<string, unknown>[])[0].realm = "atlantis";
    writeFileSync(join(d, "locations.json"), JSON.stringify(locations));
    writeFileSync(join(d, "rules.json"), JSON.stringify(validRules()));
  });
  const result = loadContentPack(dir);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.path).toBe("locations[0].realm");
  }
  rmSync(dir, { recursive: true, force: true });
});

test("the authored Greek world content loads", () => {
  const result = loadContentPack(GREEK_WORLD_DIR);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(
      `Greek world content failed to load: ${result.path}: ${result.message}`,
    );
  }
  expect(result.value.locations.length).toBeGreaterThan(0);
  expect(result.value.realms).toEqual(
    expect.arrayContaining(["mortal", "olympus", "underworld"]),
  );
});
