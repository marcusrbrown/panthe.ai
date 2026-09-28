import { expect, test } from "bun:test";
import type { ContentPack } from "@panthea/contracts";
import { applyEvent, runTick, submitProposal } from "./actions";
import { decode, encode } from "./codec";
import {
  createInitialWorldState,
  createPrng,
  toEntityId,
  withActor,
} from "./state";

function minimalRules(): ContentPack["rules"] {
  return {
    catchUpCapMs: 3_600_000,
    catchUpChunkMs: 60_000,
    checkpointIntervalMs: 60_000,
    fireBalance: {},
    economyBalance: {},
  };
}

function walkPack(): ContentPack {
  return {
    schemaVersion: 1,
    realms: ["mortal"],
    resources: [],
    locations: [
      {
        id: "grove",
        realm: "mortal",
        name: "Grove",
        edges: [{ to: "square", transport: "path", bidirectional: true }],
      },
      { id: "square", realm: "mortal", name: "Square", edges: [] },
    ],
    buildings: [],
    inhabitants: [],
    rules: minimalRules(),
    recipes: {},
  };
}

function seededState() {
  const state = createInitialWorldState(walkPack());
  return withActor(state, {
    id: toEntityId("wanderer"),
    locationId: toEntityId("grove"),
    alive: true,
    capabilities: ["divine"],
    inventory: new Map([["wood", 3]]),
    revision: 2,
  });
}

test("encode -> JSON round-trip -> decode reproduces the original state", () => {
  const original = seededState();
  const roundTripped = decode(JSON.parse(JSON.stringify(encode(original))));
  expect(roundTripped).toEqual(original);
});

test("the encoded form is JSON-safe (no Maps survive JSON.stringify without the codec)", () => {
  const original = seededState();
  const encoded = encode(original);
  // A plain JSON.stringify of the raw WorldState drops Map contents; the
  // encoded form must not, since it is arrays of entries, not Maps.
  const json = JSON.stringify(encoded);
  const reparsed = JSON.parse(json);
  expect(reparsed.actors).toHaveLength(1);
  expect(reparsed.locations).toHaveLength(2);
});

test("decode rejects a non-object top-level value", () => {
  expect(() => decode(null)).toThrow();
  expect(() => decode("not an object")).toThrow();
  expect(() => decode([])).toThrow();
  expect(() => decode(42)).toThrow();
});

test("decode rejects a non-integer or negative tick or lastSequence, and a negative simTime", () => {
  const base = encode(seededState());
  expect(() => decode({ ...base, tick: -1 })).toThrow();
  expect(() => decode({ ...base, tick: 1.5 })).toThrow();
  expect(() => decode({ ...base, lastSequence: -1 })).toThrow();
  expect(() => decode({ ...base, lastSequence: 1.5 })).toThrow();
  expect(() => decode({ ...base, simTime: -1 })).toThrow();
});

test("decode rejects a location entry that is not [id, object] with the required fields and types", () => {
  const base = encode(seededState());
  expect(() =>
    decode({ ...base, locations: [...base.locations, "not-a-tuple"] }),
  ).toThrow();
  expect(() =>
    decode({ ...base, locations: [...base.locations, ["grove-2", null]] }),
  ).toThrow();
  expect(() =>
    decode({
      ...base,
      locations: [...base.locations, ["grove-2", { id: "grove-2" }]],
    }),
  ).toThrow();
});

test("decode rejects an actor entry that is not [id, object] with the required fields and types", () => {
  const base = encode(seededState());
  expect(() => decode({ ...base, actors: [["wanderer", null]] })).toThrow();
  expect(() =>
    decode({ ...base, actors: [["wanderer", { id: "wanderer" }]] }),
  ).toThrow();
});

test("decode rejects an actor whose locationId is not a known location", () => {
  const base = encode(seededState());
  const [id, actor] = base.actors[0] as unknown as [
    string,
    Record<string, unknown>,
  ];
  expect(() =>
    decode({
      ...base,
      actors: [[id, { ...actor, locationId: "nowhere" }]],
    }),
  ).toThrow();
});

test("decode rejects a location whose realm is not a known realm", () => {
  const base = encode(seededState());
  const [id, location] = base.locations[0] as unknown as [
    string,
    Record<string, unknown>,
  ];
  expect(() =>
    decode({
      ...base,
      locations: [[id, { ...location, realm: "narnia" }], base.locations[1]],
    }),
  ).toThrow();
});

test("decode rejects a location whose edge points to an unknown location id", () => {
  const base = encode(seededState());
  const [id, grove] = base.locations[0] as unknown as [
    string,
    Record<string, unknown>,
  ];
  expect(() =>
    decode({
      ...base,
      locations: [
        [
          id,
          {
            ...grove,
            edges: [{ to: "nowhere", transport: "path", bidirectional: true }],
          },
        ],
        base.locations[1],
      ],
    }),
  ).toThrow();
});

test("decode rejects a duplicate key among the location entries", () => {
  const base = encode(seededState());
  const [id, location] = base.locations[0] as unknown as [
    string,
    Record<string, unknown>,
  ];
  expect(() =>
    decode({
      ...base,
      locations: [...base.locations, [id, { ...location }]],
    }),
  ).toThrow();
});

test("decode rejects a duplicate key among the actor entries", () => {
  const base = encode(seededState());
  const [id, actor] = base.actors[0] as unknown as [
    string,
    Record<string, unknown>,
  ];
  expect(() =>
    decode({
      ...base,
      actors: [...base.actors, [id, { ...actor }]],
    }),
  ).toThrow();
});

test("decode rejects a location entry whose array key does not equal its own id field", () => {
  const base = encode(seededState());
  // "square" (locations[1]) is not the actor's own location and nothing
  // else references it by id, so this isolates the key-vs-id check from
  // the unrelated "unknown location" referential check that a mismatched
  // "grove" key would otherwise trip instead.
  const [, square] = base.locations[1] as unknown as [
    string,
    Record<string, unknown>,
  ];
  expect(() =>
    decode({
      ...base,
      locations: [base.locations[0], ["mismatched-key", square]],
    }),
  ).toThrow();
});

test("decode rejects an actor entry whose array key does not equal its own id field", () => {
  const base = encode(seededState());
  const [, actor] = base.actors[0] as unknown as [
    string,
    Record<string, unknown>,
  ];
  expect(() =>
    decode({
      ...base,
      actors: [["mismatched-key", actor]],
    }),
  ).toThrow();
});

test("applying events to a decoded state equals applying them to the original", () => {
  const original = seededState();
  const submitted = submitProposal({
    schemaVersion: 1,
    actor: "wanderer",
    targets: [],
    expectedRevisions: [],
    source: "fixture",
    observationId: "obs-1",
    kind: "move",
    to: "square",
  });
  if (!submitted.ok) throw new Error("test fixture proposal failed to parse");

  const tick = runTick(original, createPrng(1), [submitted.proposal]);
  const event = tick.committed[0]?.events[0];
  if (!event) throw new Error("expected a committed event");

  const viaOriginal = applyEvent(original, event);
  const roundTripped = decode(JSON.parse(JSON.stringify(encode(original))));
  const viaDecoded = applyEvent(roundTripped, event);

  expect(viaDecoded).toEqual(viaOriginal);
});

function economyPack(): ContentPack {
  return {
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
        wants: "planks",
        startingInventory: [{ resource: "currency", amount: 10 }],
      },
    ],
    rules: {
      catchUpCapMs: 1,
      catchUpChunkMs: 2,
      checkpointIntervalMs: 3,
      fireBalance: { spreadChancePerTick: 0.1 },
      economyBalance: { value_food: 3 },
    },
    recipes: {
      planks: {
        inputs: [{ resource: "wood", amount: 2 }],
        outputs: [{ resource: "planks", amount: 1 }],
      },
    },
  };
}

test("encode -> JSON round-trip -> decode reproduces buildings, rules, recipes, and actor inventory/drives", () => {
  const original = createInitialWorldState(economyPack());
  const roundTripped = decode(JSON.parse(JSON.stringify(encode(original))));
  expect(roundTripped).toEqual(original);
  const farmer = roundTripped.actors.get(toEntityId("farmer"));
  expect(farmer?.inventory.get("currency")).toBe(10);
  expect(farmer?.wants).toBe("planks");
  expect(farmer?.drives).toEqual({
    thrift: 0.2,
    appetite: 0.5,
    greed: 0.2,
    piety: 0.1,
  });
  const shop = roundTripped.buildings.get(toEntityId("agora-shop"));
  expect(shop?.inventory.get("food")).toBe(5);
  expect(shop?.owner).toBe(toEntityId("farmer"));
  expect(roundTripped.rules).toEqual(original.rules);
  expect(roundTripped.recipes).toEqual(original.recipes);
});

test("decode rejects a building whose owner references an unknown actor", () => {
  const base = encode(createInitialWorldState(economyPack()));
  const [id, building] = base.buildings[0] as unknown as [
    string,
    Record<string, unknown>,
  ];
  expect(() =>
    decode({
      ...base,
      buildings: [[id, { ...building, owner: "nobody" }]],
    }),
  ).toThrow();
});

test("decode rejects a building whose locationId is not a known location", () => {
  const base = encode(createInitialWorldState(economyPack()));
  const [id, building] = base.buildings[0] as unknown as [
    string,
    Record<string, unknown>,
  ];
  expect(() =>
    decode({
      ...base,
      buildings: [[id, { ...building, locationId: "nowhere" }]],
    }),
  ).toThrow();
});

test("decode rejects a duplicate key among the building entries", () => {
  const base = encode(createInitialWorldState(economyPack()));
  const [id, building] = base.buildings[0] as unknown as [
    string,
    Record<string, unknown>,
  ];
  expect(() =>
    decode({
      ...base,
      buildings: [...base.buildings, [id, building]],
    }),
  ).toThrow();
});

test("decode rejects an inventory entry with a negative amount", () => {
  const base = encode(createInitialWorldState(economyPack()));
  const [id, building] = base.buildings[0] as unknown as [
    string,
    Record<string, unknown>,
  ];
  expect(() =>
    decode({
      ...base,
      buildings: [[id, { ...building, inventory: [["food", -1]] }]],
    }),
  ).toThrow();
});

test("decode rejects a duplicate resource within one inventory", () => {
  const base = encode(createInitialWorldState(economyPack()));
  const [id, building] = base.buildings[0] as unknown as [
    string,
    Record<string, unknown>,
  ];
  expect(() =>
    decode({
      ...base,
      buildings: [
        [
          id,
          {
            ...building,
            inventory: [
              ["food", 1],
              ["food", 2],
            ],
          },
        ],
      ],
    }),
  ).toThrow();
});

test("decode rejects a malformed recipes record", () => {
  const base = encode(createInitialWorldState(economyPack()));
  expect(() =>
    decode({ ...base, recipes: { planks: { inputs: "not-an-array" } } }),
  ).toThrow();
});

test("decode rejects a rules object missing a required numeric field", () => {
  const base = encode(createInitialWorldState(economyPack()));
  const { catchUpCapMs: _omit, ...incompleteRules } = base.rules;
  expect(() => decode({ ...base, rules: incompleteRules })).toThrow();
});
