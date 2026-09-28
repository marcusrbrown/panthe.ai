import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCausationId,
  createCorrelationId,
  createEntityId,
  createEventId,
  type EntityMovedEvent,
} from "@panthea/contracts";
import { takeSnapshot } from "./snapshot";
import {
  closeStore,
  commitTick,
  openStore,
  type ProjectionReducers,
} from "./store";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "panthea-snapshot-"));
  dbPath = join(dir, "world.sqlite");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface CountProjection {
  readonly total: number;
}

const reducer: ProjectionReducers<CountProjection> = {
  initial: { total: 0 },
  applyEvent(projections) {
    return { total: projections.total + 1 };
  },
  codec: {
    encode: (projections) => projections,
    decode: (value) => value as CountProjection,
  },
};

function makeMoveEvent(sequence: number): EntityMovedEvent {
  return {
    schemaVersion: 2,
    id: createEventId(),
    sequence,
    simTime: sequence,
    correlationId: createCorrelationId(),
    causationId: createCausationId(),
    approximate: false,
    kind: "entity-moved",
    entityId: createEntityId(),
    to: createEntityId(),
  };
}

describe("takeSnapshot", () => {
  test("happy path: pinned to the sequence committed at read time, including clock and PRNG state", () => {
    const store = openStore(dbPath);
    commitTick(store, reducer, {
      events: [makeMoveEvent(1)],
      cursorWallMs: 1000,
      paused: false,
      tick: 1,
      simTimeMs: 1000,
      prngState: "seed-1",
    });
    commitTick(store, reducer, {
      events: [makeMoveEvent(2)],
      cursorWallMs: 2000,
      paused: true,
      tick: 2,
      simTimeMs: 2000,
      prngState: "seed-2",
    });

    const snapshot = takeSnapshot(store, reducer);
    expect(snapshot.sequence).toBe(2);
    expect(snapshot.projections).toEqual({ total: 2 });
    expect(snapshot.clock).toEqual({
      cursorWallMs: 2000,
      paused: true,
      tick: 2,
      simTimeMs: 2000,
    });
    expect(snapshot.prngState).toBe("seed-2");
    expect(snapshot.worldId).toBe(store.worldId);
    closeStore(store);
  });

  test("edge case: a snapshot always reflects exactly one committed sequence, never a partial tick", () => {
    const store = openStore(dbPath);
    for (let i = 1; i <= 10; i++) {
      commitTick(store, reducer, {
        events: [makeMoveEvent(i)],
        cursorWallMs: 100 * i,
        paused: false,
        tick: i,
        simTimeMs: 100 * i,
        prngState: `seed-${i}`,
      });
    }
    const snapshot = takeSnapshot(store, reducer);
    expect(snapshot.sequence).toBe(10);
    expect(snapshot.projections.total).toBe(10);
    closeStore(store);
  });
});
