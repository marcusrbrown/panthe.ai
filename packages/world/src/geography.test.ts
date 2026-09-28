import { expect, test } from "bun:test";
import type { ContentPack } from "@panthea/contracts";
import {
  crossesRealm,
  findEdge,
  isAdjacent,
  locationsInRealm,
  outgoingEdges,
} from "./geography";
import { createInitialWorldState, toEntityId } from "./state";

function minimalRules(): ContentPack["rules"] {
  return {
    catchUpCapMs: 3_600_000,
    catchUpChunkMs: 60_000,
    checkpointIntervalMs: 60_000,
    fireBalance: {},
    economyBalance: {},
  };
}

function pack(locations: ContentPack["locations"]): ContentPack {
  return {
    schemaVersion: 1,
    realms: ["mortal", "olympus", "underworld"],
    resources: [],
    locations,
    buildings: [],
    inhabitants: [],
    rules: minimalRules(),
    recipes: {},
  };
}

test("a declared edge makes two locations adjacent", () => {
  const state = createInitialWorldState(
    pack([
      {
        id: "grove",
        realm: "mortal",
        name: "Grove",
        edges: [{ to: "square", transport: "path", bidirectional: true }],
      },
      { id: "square", realm: "mortal", name: "Square", edges: [] },
    ]),
  );
  expect(isAdjacent(state, toEntityId("grove"), toEntityId("square"))).toBe(
    true,
  );
});

test("a bidirectional edge is traversable from either endpoint without being declared twice", () => {
  const state = createInitialWorldState(
    pack([
      {
        id: "grove",
        realm: "mortal",
        name: "Grove",
        edges: [{ to: "square", transport: "path", bidirectional: true }],
      },
      { id: "square", realm: "mortal", name: "Square", edges: [] },
    ]),
  );
  expect(isAdjacent(state, toEntityId("square"), toEntityId("grove"))).toBe(
    true,
  );
  expect(
    findEdge(state, toEntityId("square"), toEntityId("grove")),
  ).toMatchObject({ to: "grove" });
});

test("a one-way edge is not traversable in reverse", () => {
  const state = createInitialWorldState(
    pack([
      {
        id: "ferry-dock",
        realm: "mortal",
        name: "Ferry Dock",
        edges: [
          {
            to: "underworld-shore",
            transport: "divine-transport",
            bidirectional: false,
          },
        ],
      },
      {
        id: "underworld-shore",
        realm: "underworld",
        name: "Underworld Shore",
        edges: [],
      },
    ]),
  );
  expect(
    isAdjacent(state, toEntityId("ferry-dock"), toEntityId("underworld-shore")),
  ).toBe(true);
  expect(
    isAdjacent(state, toEntityId("underworld-shore"), toEntityId("ferry-dock")),
  ).toBe(false);
});

test("unrelated locations are not adjacent", () => {
  const state = createInitialWorldState(
    pack([
      { id: "a", realm: "mortal", name: "A", edges: [] },
      { id: "b", realm: "mortal", name: "B", edges: [] },
    ]),
  );
  expect(isAdjacent(state, toEntityId("a"), toEntityId("b"))).toBe(false);
});

test("crossesRealm reports true only when the two locations declare different realms", () => {
  const state = createInitialWorldState(
    pack([
      {
        id: "mountain-path",
        realm: "mortal",
        name: "Mountain Path",
        edges: [
          {
            to: "olympus-gate",
            transport: "divine-transport",
            bidirectional: true,
          },
        ],
      },
      { id: "olympus-gate", realm: "olympus", name: "Olympus Gate", edges: [] },
      { id: "town-square", realm: "mortal", name: "Town Square", edges: [] },
    ]),
  );
  expect(
    crossesRealm(
      state,
      toEntityId("mountain-path"),
      toEntityId("olympus-gate"),
    ),
  ).toBe(true);
  expect(
    crossesRealm(state, toEntityId("mountain-path"), toEntityId("town-square")),
  ).toBe(false);
});

test("locationsInRealm returns only locations in that realm", () => {
  const state = createInitialWorldState(
    pack([
      { id: "a", realm: "mortal", name: "A", edges: [] },
      { id: "b", realm: "olympus", name: "B", edges: [] },
      { id: "c", realm: "mortal", name: "C", edges: [] },
    ]),
  );
  expect(
    locationsInRealm(state, "mortal")
      .map((loc) => String(loc.id))
      .sort(),
  ).toEqual(["a", "c"]);
});

test("outgoingEdges includes both declared and synthesized reverse edges", () => {
  const state = createInitialWorldState(
    pack([
      {
        id: "square",
        realm: "mortal",
        name: "Square",
        edges: [
          { to: "tavern", transport: "path", bidirectional: true },
          { to: "shop", transport: "path", bidirectional: true },
        ],
      },
      { id: "tavern", realm: "mortal", name: "Tavern", edges: [] },
      { id: "shop", realm: "mortal", name: "Shop", edges: [] },
    ]),
  );
  const edges = outgoingEdges(state, toEntityId("tavern"));
  expect(edges).toHaveLength(1);
  expect(edges[0]).toMatchObject({ to: "square" });
});
