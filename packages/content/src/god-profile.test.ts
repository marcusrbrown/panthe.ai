import { expect, test } from "bun:test";
import type { Inhabitant } from "@panthea/contracts";
import { parseGodProfile, parseGodProfiles } from "./god-profile";

function inhabitants(): Inhabitant[] {
  return [
    { id: "zeus", name: "Zeus", locationId: "great-hall", deity: true },
    { id: "hera", name: "Hera", locationId: "great-hall", deity: true },
    { id: "farmer", name: "The Farmer", locationId: "town-square" },
  ];
}

function validProfile(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "zeus",
    name: "Zeus",
    domains: ["sky", "thunder"],
    drives: { sovereignty: 0.9, desire: 0.5 },
    abilities: [
      {
        id: "thunderbolt",
        name: "Thunderbolt",
        action: "strike",
        description: "Strikes a structure with lightning.",
        cost: { resource: "divinity", amount: 3 },
        parameters: { power: 3 },
      },
    ],
    relationships: [{ target: "farmer", kind: "mortal", disposition: 0.1 }],
    sources: [
      {
        id: "theogony",
        title: "Theogony",
        author: "Hesiod",
        translator: "Hugh G. Evelyn-White",
        edition: "Loeb Classical Library, 1914",
      },
    ],
    lore: [
      {
        id: "thunder",
        statement: "The Cyclopes gave Zeus thunder and the thunderbolt.",
        cites: [{ source: "theogony", locator: "lines 501-506" }],
      },
    ],
    variants: [
      {
        id: "kingship",
        note: "Accounts differ on how Zeus became king.",
        cites: [{ source: "theogony", locator: "lines 881-885" }],
      },
    ],
    inventions: [
      {
        id: "strike-on-buildings",
        statement: "The game applies the thunderbolt to buildings.",
        reason: "Strike is the world's only destructive action.",
      },
    ],
    sprite: "placeholder-zeus",
  };
}

function mutate(
  change: (profile: Record<string, unknown>) => void,
): Record<string, unknown> {
  const profile = validProfile();
  change(profile);
  return profile;
}

function parseOne(profile: unknown, roster: Inhabitant[] = inhabitants()) {
  return parseGodProfiles([{ label: "zeus.json", value: profile }], roster);
}

test("a valid profile parses with every section preserved", () => {
  const result = parseOne(validProfile());
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const [zeus] = result.value;
  expect(zeus.id).toBe("zeus");
  expect(zeus.drives).toEqual({ sovereignty: 0.9, desire: 0.5 });
  expect(zeus.abilities[0]).toMatchObject({
    action: "strike",
    cost: { resource: "divinity", amount: 3 },
    parameters: { power: 3 },
  });
  expect(zeus.lore[0].cites).toEqual([
    { source: "theogony", locator: "lines 501-506" },
  ]);
  expect(zeus.variants).toHaveLength(1);
  expect(zeus.inventions).toHaveLength(1);
  expect(zeus.relationships).toHaveLength(1);
});

test("relationships, variants, and inventions default to empty lists", () => {
  const result = parseOne(
    mutate((profile) => {
      delete profile.relationships;
      delete profile.variants;
      delete profile.inventions;
    }),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value[0].relationships).toEqual([]);
  expect(result.value[0].variants).toEqual([]);
  expect(result.value[0].inventions).toEqual([]);
});

test("an ability naming an action the world does not have is rejected", () => {
  const result = parseOne(
    mutate((profile) => {
      (profile.abilities as Record<string, unknown>[])[0].action = "smite";
    }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.path).toBe("zeus.json.abilities[0].action");
    expect(result.message).toContain("strike");
  }
});

test("a lore line citing an unknown source id is rejected", () => {
  const result = parseOne(
    mutate((profile) => {
      const lore = profile.lore as { cites: { source: string }[] }[];
      lore[0].cites[0].source = "iliad";
    }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.path).toBe("zeus.json.lore[0].cites[0].source");
    expect(result.message).toContain("iliad");
  }
});

test("a variant citing an unknown source id is rejected", () => {
  const result = parseOne(
    mutate((profile) => {
      const variants = profile.variants as { cites: { source: string }[] }[];
      variants[0].cites[0].source = "iliad";
    }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.path).toBe("zeus.json.variants[0].cites[0].source");
  }
});

test("a lore line with no citation is rejected, whether empty or absent", () => {
  const empty = parseOne(
    mutate((profile) => {
      (profile.lore as Record<string, unknown>[])[0].cites = [];
    }),
  );
  expect(empty.ok).toBe(false);
  if (!empty.ok) expect(empty.path).toBe("zeus.json.lore[0].cites");

  const absent = parseOne(
    mutate((profile) => {
      delete (profile.lore as Record<string, unknown>[])[0].cites;
    }),
  );
  expect(absent.ok).toBe(false);
  if (!absent.ok) expect(absent.path).toBe("zeus.json.lore[0].cites");
});

test("a citation without a locator is rejected", () => {
  const result = parseOne(
    mutate((profile) => {
      const lore = profile.lore as { cites: Record<string, unknown>[] }[];
      delete lore[0].cites[0].locator;
    }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.path).toBe("zeus.json.lore[0].cites[0].locator");
});

test("an invention that carries citations is rejected: inventions are never presented as sourced", () => {
  const result = parseOne(
    mutate((profile) => {
      (profile.inventions as Record<string, unknown>[])[0].cites = [
        { source: "theogony", locator: "lines 501-506" },
      ];
    }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.path).toBe("zeus.json.inventions[0].cites");
});

test("a profile whose id matches no inhabitant is rejected", () => {
  const result = parseOne(
    mutate((profile) => {
      profile.id = "athena";
    }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.path).toBe("zeus.json.id");
    expect(result.message).toContain("athena");
  }
});

test("a profile whose inhabitant is not a deity is rejected", () => {
  const result = parseOne(
    mutate((profile) => {
      profile.id = "farmer";
    }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toContain("deity");
});

test("two profiles for one inhabitant are rejected", () => {
  const result = parseGodProfiles(
    [
      { label: "zeus.json", value: validProfile() },
      { label: "zeus-again.json", value: validProfile() },
    ],
    inhabitants(),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.path).toBe("zeus-again.json.id");
});

test("a relationship targeting an unknown inhabitant is rejected", () => {
  const result = parseOne(
    mutate((profile) => {
      (profile.relationships as Record<string, unknown>[])[0].target = "athena";
    }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.path).toBe("zeus.json.relationships[0].target");
  }
});

test("a duplicate source id is rejected", () => {
  const result = parseOne(
    mutate((profile) => {
      const sources = profile.sources as Record<string, unknown>[];
      sources.push({ ...sources[0] });
    }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.path).toBe("zeus.json.sources[1].id");
});

test("an unknown drive, an out-of-range weight, and an empty drive set are rejected", () => {
  for (const drives of [{ ambition: 0.5 }, { sovereignty: 1.5 }, {}]) {
    const result = parseOne(
      mutate((profile) => {
        profile.drives = drives;
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.path.startsWith("zeus.json.drives")).toBe(true);
  }
});

test("a relationship disposition outside -1..1 is rejected", () => {
  const result = parseOne(
    mutate((profile) => {
      (profile.relationships as Record<string, unknown>[])[0].disposition = 2;
    }),
  );
  expect(result.ok).toBe(false);
});

test("an unsupported schema version is rejected", () => {
  const result = parseGodProfile(
    { ...validProfile(), schemaVersion: 2 },
    "zeus.json",
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe("unsupported-version");
});

test("a profile missing a sprite id is rejected", () => {
  const result = parseOne(
    mutate((profile) => {
      delete profile.sprite;
    }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.path).toBe("zeus.json.sprite");
});
