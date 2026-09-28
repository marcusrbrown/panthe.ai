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
  };
}

function seededState() {
  const state = createInitialWorldState(walkPack());
  return withActor(state, {
    id: toEntityId("wanderer"),
    locationId: toEntityId("grove"),
    alive: true,
    capabilities: ["divine"],
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
