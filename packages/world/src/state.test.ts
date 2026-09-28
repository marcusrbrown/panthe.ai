import { expect, test } from "bun:test";
import {
  createInitialWorldState,
  createPrng,
  getEntityRevision,
  nextPrngValue,
  toEntityId,
  withActor,
} from "./state";

test("the same PRNG seed produces the same sequence of values", () => {
  let a = createPrng(42);
  let b = createPrng(42);
  const valuesA: number[] = [];
  const valuesB: number[] = [];
  for (let i = 0; i < 5; i++) {
    const drawA = nextPrngValue(a);
    const drawB = nextPrngValue(b);
    valuesA.push(drawA.value);
    valuesB.push(drawB.value);
    a = drawA.state;
    b = drawB.state;
  }
  expect(valuesA).toEqual(valuesB);
  // Every draw is in [0, 1) and the sequence isn't degenerate (constant).
  for (const value of valuesA) {
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
  }
  expect(new Set(valuesA).size).toBeGreaterThan(1);
});

test("different seeds produce different sequences", () => {
  const drawA = nextPrngValue(createPrng(1));
  const drawB = nextPrngValue(createPrng(2));
  expect(drawA.value).not.toBe(drawB.value);
});

test("getEntityRevision looks up both actors and locations by id", () => {
  const pack = {
    schemaVersion: 1 as const,
    realms: ["mortal"] as const,
    resources: [],
    locations: [
      { id: "agora", realm: "mortal" as const, name: "Agora", edges: [] },
    ],
    buildings: [],
    inhabitants: [],
    rules: {
      catchUpCapMs: 0,
      catchUpChunkMs: 0,
      checkpointIntervalMs: 0,
      fireBalance: {},
      economyBalance: {},
    },
  };
  let state = createInitialWorldState(pack);
  state = withActor(state, {
    id: toEntityId("npc-1"),
    locationId: toEntityId("agora"),
    alive: true,
    capabilities: [],
    revision: 3,
  });
  expect(getEntityRevision(state, toEntityId("npc-1"))).toBe(3);
  expect(getEntityRevision(state, toEntityId("agora"))).toBe(0);
  expect(getEntityRevision(state, toEntityId("unknown"))).toBeUndefined();
});
