import { expect, test } from "bun:test";
import type { ContentPack } from "@panthea/contracts";
import { decideRoutineProposal } from "./routines";
import { createInitialWorldState, toEntityId, withActor } from "./state";

function rules(
  economyBalance: Record<string, number> = {},
): ContentPack["rules"] {
  return {
    catchUpCapMs: 0,
    catchUpChunkMs: 0,
    checkpointIntervalMs: 0,
    fireBalance: {},
    economyBalance,
  };
}

function pack(overrides: Partial<ContentPack> = {}): ContentPack {
  return {
    schemaVersion: 1,
    realms: ["mortal"],
    resources: [],
    locations: [{ id: "square", realm: "mortal", name: "Square", edges: [] }],
    buildings: [],
    inhabitants: [],
    rules: rules({ gatherAmount: 2, consumeAmount: 1, value_food: 3 }),
    recipes: {},
    ...overrides,
  };
}

test("a dead actor never gets a routine proposal", () => {
  let state = createInitialWorldState(pack());
  state = withActor(state, {
    id: toEntityId("ghost"),
    locationId: toEntityId("square"),
    alive: false,
    capabilities: [],
    inventory: new Map(),
    drives: { thrift: 1, appetite: 0, greed: 0, piety: 0 },
    revision: 0,
  });
  expect(decideRoutineProposal(state, toEntityId("ghost"))).toBeUndefined();
});

test("an actor with no authored drives is not routine-driven", () => {
  let state = createInitialWorldState(pack());
  state = withActor(state, {
    id: toEntityId("wanderer"),
    locationId: toEntityId("square"),
    alive: true,
    capabilities: [],
    inventory: new Map(),
    revision: 0,
  });
  expect(decideRoutineProposal(state, toEntityId("wanderer"))).toBeUndefined();
});

test("with nothing else eligible, a gatherer falls back to gathering its own resource", () => {
  let state = createInitialWorldState(pack());
  state = withActor(state, {
    id: toEntityId("woodcutter"),
    locationId: toEntityId("square"),
    alive: true,
    capabilities: [],
    inventory: new Map(),
    drives: { thrift: 0.5, appetite: 0.1, greed: 0.3, piety: 0 },
    gathers: "wood",
    revision: 0,
  });
  const result = decideRoutineProposal(state, toEntityId("woodcutter"));
  if (!result) throw new Error("expected a routine result");
  expect(result.proposal).toMatchObject({
    kind: "gather",
    resource: "wood",
    amount: 2,
  });
  expect(result.proposal.observationId).toBe(result.observation.id);
  expect(result.observation.observer).toBe(toEntityId("woodcutter"));
  expect(result.observation.source).toBe("routine");
});

test("two inhabitants with different dominant drives choose different actions from the same state", () => {
  const base = () => {
    let state = createInitialWorldState(pack());
    state = withActor(state, {
      id: toEntityId("self"),
      locationId: toEntityId("square"),
      alive: true,
      capabilities: [],
      inventory: new Map([["wood", 4]]),
      gathers: "wood",
      revision: 0,
      drives: { thrift: 0, appetite: 0, greed: 0, piety: 0 },
    });
    state = withActor(state, {
      id: toEntityId("buyer"),
      locationId: toEntityId("square"),
      alive: true,
      capabilities: [],
      inventory: new Map([["currency", 10]]),
      revision: 0,
    });
    return state;
  };

  const appetiteState = withActor(base(), {
    id: toEntityId("self"),
    locationId: toEntityId("square"),
    alive: true,
    capabilities: [],
    inventory: new Map([["wood", 4]]),
    gathers: "wood",
    revision: 0,
    drives: { thrift: 0, appetite: 0.9, greed: 0, piety: 0 },
  });
  const greedState = withActor(base(), {
    id: toEntityId("self"),
    locationId: toEntityId("square"),
    alive: true,
    capabilities: [],
    inventory: new Map([["wood", 4]]),
    gathers: "wood",
    revision: 0,
    drives: { thrift: 0, appetite: 0, greed: 0.9, piety: 0 },
  });

  const appetiteChoice = decideRoutineProposal(
    appetiteState,
    toEntityId("self"),
  );
  const greedChoice = decideRoutineProposal(greedState, toEntityId("self"));

  // Appetite has no eligible consume/buy path here (no food anywhere), so
  // it falls back to the same low-utility gather as everyone else; greed
  // outranks that fallback with the higher-utility sell candidate.
  expect(appetiteChoice?.proposal.kind).toBe("gather");
  expect(greedChoice?.proposal.kind).toBe("trade");
});

test("a hungry actor with currency buys food from a co-located seller over gathering", () => {
  let state = createInitialWorldState(pack());
  state = withActor(state, {
    id: toEntityId("hungry"),
    locationId: toEntityId("square"),
    alive: true,
    capabilities: [],
    inventory: new Map([["currency", 10]]),
    gathers: "wood",
    revision: 0,
    drives: { thrift: 0, appetite: 0.9, greed: 0, piety: 0 },
  });
  state = withActor(state, {
    id: toEntityId("seller"),
    locationId: toEntityId("square"),
    alive: true,
    capabilities: [],
    inventory: new Map([["food", 5]]),
    revision: 0,
  });
  const result = decideRoutineProposal(state, toEntityId("hungry"));
  expect(result?.proposal).toMatchObject({
    kind: "trade",
    counterparty: "seller",
    give: [{ resource: "currency", amount: 3 }],
    receive: [{ resource: "food", amount: 1 }],
  });
});

test("an actor holding enough food consumes it", () => {
  let state = createInitialWorldState(pack());
  state = withActor(state, {
    id: toEntityId("fed"),
    locationId: toEntityId("square"),
    alive: true,
    capabilities: [],
    inventory: new Map([["food", 2]]),
    revision: 0,
    drives: { thrift: 0, appetite: 0.9, greed: 0, piety: 0 },
  });
  const result = decideRoutineProposal(state, toEntityId("fed"));
  expect(result?.proposal).toMatchObject({
    kind: "consume",
    resource: "food",
    amount: 1,
  });
});

test("an actor holding recipe inputs proposes to produce over gathering", () => {
  let state = createInitialWorldState(
    pack({
      recipes: {
        planks: {
          inputs: [{ resource: "wood", amount: 2 }],
          outputs: [{ resource: "planks", amount: 1 }],
        },
      },
    }),
  );
  state = withActor(state, {
    id: toEntityId("carpenter"),
    locationId: toEntityId("square"),
    alive: true,
    capabilities: [],
    inventory: new Map([["wood", 2]]),
    gathers: "wood",
    revision: 0,
    drives: { thrift: 0.9, appetite: 0, greed: 0, piety: 0 },
  });
  const result = decideRoutineProposal(state, toEntityId("carpenter"));
  expect(result?.proposal).toMatchObject({
    kind: "produce",
    output: "planks",
    quantity: 1,
  });
});

test("an actor without a gatherable resource and nothing else eligible gets no proposal", () => {
  let state = createInitialWorldState(pack());
  state = withActor(state, {
    id: toEntityId("idle"),
    locationId: toEntityId("square"),
    alive: true,
    capabilities: [],
    inventory: new Map(),
    revision: 0,
    drives: { thrift: 0, appetite: 0, greed: 0, piety: 0 },
  });
  expect(decideRoutineProposal(state, toEntityId("idle"))).toBeUndefined();
});
