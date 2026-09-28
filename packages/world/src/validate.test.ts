import { expect, test } from "bun:test";
import type { ContentPack, Proposal } from "@panthea/contracts";
import { submitProposal } from "./actions";
import {
  createInitialWorldState,
  toEntityId,
  type WorldState,
  withActor,
} from "./state";
import { validateProposal } from "./validate";

function minimalRules(): ContentPack["rules"] {
  return {
    catchUpCapMs: 3_600_000,
    catchUpChunkMs: 60_000,
    checkpointIntervalMs: 60_000,
    fireBalance: {},
    economyBalance: {},
  };
}

function fixtureState(): WorldState {
  const pack: ContentPack = {
    schemaVersion: 1,
    realms: ["mortal", "olympus", "underworld"],
    resources: [],
    locations: [
      {
        id: "grove",
        realm: "mortal",
        name: "Grove",
        edges: [{ to: "square", transport: "path", bidirectional: true }],
      },
      {
        id: "square",
        realm: "mortal",
        name: "Square",
        edges: [
          { to: "tavern", transport: "path", bidirectional: true },
          {
            to: "ferry-dock",
            transport: "path",
            bidirectional: true,
          },
        ],
      },
      { id: "tavern", realm: "mortal", name: "Tavern", edges: [] },
      {
        id: "ferry-dock",
        realm: "mortal",
        name: "Ferry Dock",
        edges: [
          {
            to: "underworld-shore",
            transport: "divine-transport",
            bidirectional: true,
          },
        ],
      },
      {
        id: "underworld-shore",
        realm: "underworld",
        name: "Underworld Shore",
        edges: [
          { to: "judgment-hall", transport: "path", bidirectional: true },
        ],
      },
      {
        id: "judgment-hall",
        realm: "underworld",
        name: "Hall of Judgment",
        edges: [],
        requiredCapability: "divine",
      },
    ],
    buildings: [],
    inhabitants: [],
    rules: minimalRules(),
  };
  let state = createInitialWorldState(pack);
  state = withActor(state, {
    id: toEntityId("npc-1"),
    locationId: toEntityId("grove"),
    alive: true,
    capabilities: [],
    revision: 0,
  });
  state = withActor(state, {
    id: toEntityId("npc-2"),
    locationId: toEntityId("underworld-shore"),
    alive: true,
    capabilities: ["divine"],
    revision: 0,
  });
  state = withActor(state, {
    id: toEntityId("npc-dead"),
    locationId: toEntityId("grove"),
    alive: false,
    capabilities: [],
    revision: 0,
  });
  return state;
}

/** Parses a raw fixture payload the way a real fixture/routine would submit it. */
function proposal(raw: Record<string, unknown>): Proposal {
  const base = {
    schemaVersion: 1,
    actor: "npc-1",
    targets: [],
    expectedRevisions: [],
    source: "fixture",
    observationId: "obs-1",
    ...raw,
  };
  const result = submitProposal(base);
  if (!result.ok) {
    throw new Error(
      `test fixture proposal failed to parse: ${result.rejection.message}`,
    );
  }
  return result.proposal;
}

test("a move to an adjacent location commits an entity-moved draft", () => {
  const state = fixtureState();
  const outcome = validateProposal(
    state,
    proposal({ kind: "move", to: "square" }),
  );
  expect(outcome.ok).toBe(true);
  if (outcome.ok) {
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]).toMatchObject({
      kind: "entity-moved",
      entityId: "npc-1",
      to: "square",
    });
  }
});

test("a move to a non-adjacent location is rejected as not-adjacent", () => {
  const state = fixtureState();
  const outcome = validateProposal(
    state,
    proposal({ kind: "move", to: "tavern" }),
  );
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.reason).toBe("not-adjacent");
});

test("a plain move across a realm boundary is rejected as restricted-realm", () => {
  const state = withActor(fixtureState(), {
    id: toEntityId("npc-3"),
    locationId: toEntityId("ferry-dock"),
    alive: true,
    capabilities: [],
    revision: 0,
  });
  const outcome = validateProposal(
    state,
    proposal({ actor: "npc-3", kind: "move", to: "underworld-shore" }),
  );
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.reason).toBe("restricted-realm");
});

test("a move into a location requiring an uncarried capability is rejected as restricted-realm", () => {
  const state = withActor(fixtureState(), {
    id: toEntityId("npc-4"),
    locationId: toEntityId("underworld-shore"),
    alive: true,
    capabilities: [],
    revision: 0,
  });
  const outcome = validateProposal(
    state,
    proposal({ actor: "npc-4", kind: "move", to: "judgment-hall" }),
  );
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.reason).toBe("restricted-realm");
});

test("a move by a dead actor is rejected as dead-actor and state is unaffected", () => {
  const state = fixtureState();
  const outcome = validateProposal(
    state,
    proposal({ actor: "npc-dead", kind: "move", to: "grove" }),
  );
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.reason).toBe("dead-actor");
  expect(state).toEqual(fixtureState());
});

test("a move by an unknown actor is rejected as dead-actor", () => {
  const state = fixtureState();
  const outcome = validateProposal(
    state,
    proposal({ actor: "npc-nonexistent", kind: "move", to: "grove" }),
  );
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.reason).toBe("dead-actor");
});

test("a stale expected revision is rejected as stale-target", () => {
  const state = fixtureState();
  const outcome = validateProposal(
    state,
    proposal({
      kind: "move",
      to: "square",
      targets: ["npc-2"],
      expectedRevisions: [{ entityId: "npc-2", revision: 99 }],
    }),
  );
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.reason).toBe("stale-target");
});

test("a realm-transition using the authored transport element arrives in the Underworld", () => {
  const state = withActor(fixtureState(), {
    id: toEntityId("npc-5"),
    locationId: toEntityId("ferry-dock"),
    alive: true,
    capabilities: [],
    revision: 0,
  });
  const outcome = validateProposal(
    state,
    proposal({
      actor: "npc-5",
      kind: "realm-transition",
      to: "underworld-shore",
      via: "ferry-dock",
    }),
  );
  expect(outcome.ok).toBe(true);
  if (outcome.ok) {
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]).toMatchObject({
      kind: "realm-transitioned",
      entityId: "npc-5",
      to: "underworld-shore",
      via: "ferry-dock",
    });
  }
});

test("a realm-transition attempted from off the transport element is rejected as not-adjacent", () => {
  const state = fixtureState();
  const outcome = validateProposal(
    state,
    proposal({
      kind: "realm-transition",
      to: "underworld-shore",
      via: "ferry-dock",
    }),
  );
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.reason).toBe("not-adjacent");
});

function crossRealmPathFixtureState(): WorldState {
  const pack: ContentPack = {
    schemaVersion: 1,
    realms: ["mortal", "underworld"],
    resources: [],
    locations: [
      {
        id: "crossing",
        realm: "mortal",
        name: "Crossing",
        edges: [{ to: "far-shore", transport: "path", bidirectional: true }],
      },
      { id: "far-shore", realm: "underworld", name: "Far Shore", edges: [] },
    ],
    buildings: [],
    inhabitants: [],
    rules: minimalRules(),
  };
  let state = createInitialWorldState(pack);
  state = withActor(state, {
    id: toEntityId("npc-6"),
    locationId: toEntityId("crossing"),
    alive: true,
    capabilities: [],
    revision: 0,
  });
  return state;
}

test("a realm-transition over a cross-realm path edge is rejected as restricted-realm", () => {
  const state = crossRealmPathFixtureState();
  const outcome = validateProposal(
    state,
    proposal({
      actor: "npc-6",
      kind: "realm-transition",
      to: "far-shore",
      via: "crossing",
    }),
  );
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.reason).toBe("restricted-realm");
  expect(state).toEqual(crossRealmPathFixtureState());
});

test("a claim never commits state, even a true-sounding one", () => {
  const state = fixtureState();
  const outcome = validateProposal(
    state,
    proposal({ kind: "claim", assertion: "I own the tavern" }),
  );
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.reason).toBe("unauthorized-claim");
});
