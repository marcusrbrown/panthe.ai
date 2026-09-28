import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSyncFrame } from "@panthea/contracts";
import { decode } from "@panthea/world";

import { baseState, framePayload, locationsWorld } from "../fixtures";
import { toViewModel, type ViewLocation, type WorldViewModel } from "../store";
import { realmPaths } from "./presentation";

function place(id: string, edgesTo: readonly string[]): ViewLocation {
  return {
    id,
    name: id,
    realm: "mortal",
    edges: edgesTo.map((to) => ({
      to,
      transport: "path",
      bidirectional: true,
    })),
    actors: [],
    buildings: [],
  };
}

function viewOf(state: ReturnType<typeof baseState>): WorldViewModel {
  const parsed = parseSyncFrame(framePayload(state));
  if (!parsed.ok) throw new Error(parsed.message);
  return toViewModel(parsed.value, decode(parsed.value.state));
}

const sorted = (pairs: readonly (readonly [string, string])[]) =>
  pairs.map((pair) => [...pair].sort().join("|")).sort();

test("an edge declared only from the lexically larger id is included", () => {
  const paths = realmPaths([place("b", ["a"]), place("a", [])]);

  expect(sorted(paths)).toEqual(["a|b"]);
});

test("an edge declared in both directions appears once", () => {
  const paths = realmPaths([place("a", ["b"]), place("b", ["a"])]);

  expect(paths).toHaveLength(1);
  expect(sorted(paths)).toEqual(["a|b"]);
});

test("an edge declared twice in one direction still appears once", () => {
  const paths = realmPaths([place("a", ["b", "b"]), place("b", [])]);

  expect(paths).toHaveLength(1);
});

test("an edge to a location outside the realm is excluded", () => {
  const paths = realmPaths([place("a", ["elsewhere", "b"]), place("b", [])]);

  expect(sorted(paths)).toEqual(["a|b"]);
});

test("an edge from a location to itself is not a path", () => {
  expect(realmPaths([place("a", ["a"])])).toEqual([]);
});

test("a realm's cross-realm edges are excluded and its two-way path is drawn once", () => {
  const view = viewOf(baseState());

  expect(sorted(realmPaths(view.realms.mortal))).toEqual(["agora|town-square"]);
  expect(realmPaths(view.realms.olympus)).toEqual([]);
  expect(realmPaths(view.realms.underworld)).toEqual([]);
});

test("the authored Greek world draws every same-realm route, including the ones declared from the larger id", () => {
  const raw = JSON.parse(
    readFileSync(
      join(import.meta.dir, "../../../../content/greek/world/locations.json"),
      "utf8",
    ),
  ) as {
    locations: {
      id: string;
      realm: "mortal" | "olympus" | "underworld";
      name: string;
      edges: { to: string }[];
    }[];
  };
  const view = viewOf(
    locationsWorld(
      raw.locations.map((location) => ({
        id: location.id,
        realm: location.realm,
        name: location.name,
        edgesTo: location.edges.map((edge) => edge.to),
      })),
    ),
  );
  const drawn = new Set([
    ...sorted(realmPaths(view.realms.mortal)),
    ...sorted(realmPaths(view.realms.olympus)),
    ...sorted(realmPaths(view.realms.underworld)),
  ]);

  for (const route of [
    ["wilderness-grove", "ancient-olive-tree"],
    ["wilderness-path", "town-square"],
    ["underworld-shore", "asphodel-meadow"],
  ]) {
    expect(drawn.has([...route].sort().join("|"))).toBe(true);
  }

  const realmOf = new Map(raw.locations.map((l) => [l.id, l.realm]));
  const declared = new Set(
    raw.locations.flatMap((location) =>
      location.edges
        .filter((edge) => realmOf.get(edge.to) === location.realm)
        .map((edge) => [location.id, edge.to].sort().join("|")),
    ),
  );
  expect(declared.size).toBeGreaterThan(0);
  expect([...drawn].sort()).toEqual([...declared].sort());
});
