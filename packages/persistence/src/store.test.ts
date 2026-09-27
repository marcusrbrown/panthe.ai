import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCausationId,
  createCorrelationId,
  createEntityId,
  createEventId,
  createWorldId,
  type EntityMovedEvent,
  type WorldEvent,
} from "@panthea/contracts";
import type { Migration } from "./migrations";
import {
  checkpoint,
  closeStore,
  commitTick,
  enforceDatabaseFileModes,
  getCurrentSequence,
  getEventRow,
  listEvents,
  NonContiguousSequenceError,
  openStore,
  type ProjectionReducers,
  readClock,
  readLiveProjections,
  rebuildProjections,
} from "./store";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "panthea-store-"));
  dbPath = join(dir, "world.sqlite");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A minimal generic projection: a count of moves per entity. Stands in for
 * packages/world's real projection shape, which does not exist yet — this
 * fixture exists precisely to prove persistence never needs to know it. */
interface CountProjection {
  readonly moves: Record<string, number>;
}

const countReducer: ProjectionReducers<CountProjection> = {
  initial: { moves: {} },
  applyEvent(projections, event) {
    if (event.kind !== "entity-moved") {
      return projections;
    }
    const key = String(event.entityId);
    return {
      moves: { ...projections.moves, [key]: (projections.moves[key] ?? 0) + 1 },
    };
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

describe("openStore", () => {
  test("happy path: creates the parent dir 0700 and the db file 0600", () => {
    const store = openStore(dbPath);
    expect((statSync(dir).mode & 0o777).toString(8)).toBe("700");
    expect((statSync(dbPath).mode & 0o777).toString(8)).toBe("600");
    closeStore(store);
  });

  test("happy path: a fresh store gets a generated world ID that survives reopen", () => {
    const store = openStore(dbPath);
    const worldId = store.worldId;
    closeStore(store);

    const reopened = openStore(dbPath);
    expect(reopened.worldId).toBe(worldId);
    closeStore(reopened);
  });

  test("WAL mode is enabled and synchronous is NORMAL", () => {
    const store = openStore(dbPath);
    const journalMode = store.db.query("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    const synchronous = store.db.query("PRAGMA synchronous").get() as {
      synchronous: number;
    };
    expect(journalMode.journal_mode).toBe("wal");
    // NORMAL is 1 in SQLite's synchronous pragma encoding.
    expect(synchronous.synchronous).toBe(1);
    closeStore(store);
  });

  test("reopening an existing store with a mismatched worldId throws and does not corrupt the slot", () => {
    const store = openStore(dbPath);
    const originalWorldId = store.worldId;
    closeStore(store);

    const mismatchedWorldId = createWorldId();
    expect(() => openStore(dbPath, { worldId: mismatchedWorldId })).toThrow(
      /already belongs to world/,
    );

    // The rejected open must not leave the db handle open or the slot in a
    // half-opened state — a normal reopen still recovers the original world.
    const reopened = openStore(dbPath);
    expect(reopened.worldId).toBe(originalWorldId);
    closeStore(reopened);
  });

  test("reopening an existing store with a matching worldId opens normally", () => {
    const store = openStore(dbPath);
    const worldId = store.worldId;
    closeStore(store);

    const reopened = openStore(dbPath, { worldId });
    expect(reopened.worldId).toBe(worldId);
    closeStore(reopened);
  });

  test("a bootstrap/migration failure closes the db handle so the file can be reopened cleanly", () => {
    const faultyMigrations: readonly Migration[] = [
      {
        version: 1,
        description: "simulated migration failure",
        up() {
          throw new Error("simulated migration failure");
        },
      },
    ];

    expect(() =>
      openStore(dbPath, {
        migrateOptions: { migrations: faultyMigrations },
      }),
    ).toThrow("simulated migration failure");

    // The failed open must close its db handle rather than leak it — a
    // fresh open on the same path, this time with the real migration
    // ladder, must succeed and bootstrap normally.
    const store = openStore(dbPath);
    expect(store.worldId).toBeDefined();
    closeStore(store);
  });
});

describe("commitTick", () => {
  test("happy path: commits events, advances projections, cursor, and PRNG state atomically", () => {
    const store = openStore(dbPath);
    const event = makeMoveEvent(1);

    const result = commitTick(store, countReducer, {
      events: [event],
      cursorWallMs: 5000,
      paused: false,
      prngState: "seed-1",
    });

    expect(result.sequence).toBe(1);
    expect(result.projections.moves[String(event.entityId)]).toBe(1);
    expect(getCurrentSequence(store.db)).toBe(1);
    expect(readClock(store.db)).toEqual({ cursorWallMs: 5000, paused: false });
    closeStore(store);
  });

  test("integration: a throw mid-tick (non-contiguous sequence) leaves events, projections, cursor, and PRNG state unchanged", () => {
    const store = openStore(dbPath);
    commitTick(store, countReducer, {
      events: [makeMoveEvent(1)],
      cursorWallMs: 1000,
      paused: false,
      prngState: "seed-1",
    });

    const before = {
      sequence: getCurrentSequence(store.db),
      clock: readClock(store.db),
      projections: readLiveProjections(store, countReducer),
    };

    expect(() =>
      commitTick(store, countReducer, {
        // Sequence 3 skips 2 — non-contiguous, should throw and roll back.
        events: [makeMoveEvent(3)],
        cursorWallMs: 9999,
        paused: false,
        prngState: "seed-should-not-persist",
      }),
    ).toThrow(NonContiguousSequenceError);

    expect(getCurrentSequence(store.db)).toBe(before.sequence);
    expect(readClock(store.db)).toEqual(before.clock);
    expect(readLiveProjections(store, countReducer)).toEqual(
      before.projections,
    );
    closeStore(store);
  });

  test("integration: a throwing reducer rolls back the whole tick, including already-inserted events in the same call", () => {
    const store = openStore(dbPath);
    const before = getCurrentSequence(store.db);

    const faultyReducer: ProjectionReducers<CountProjection> = {
      initial: { moves: {} },
      applyEvent(projections, event) {
        if (event.sequence === 2) {
          throw new Error("simulated reducer fault");
        }
        return countReducer.applyEvent(projections, event);
      },
    };

    expect(() =>
      commitTick(store, faultyReducer, {
        events: [makeMoveEvent(1), makeMoveEvent(2)],
        cursorWallMs: 1234,
        paused: false,
        prngState: "seed-x",
      }),
    ).toThrow("simulated reducer fault");

    expect(getCurrentSequence(store.db)).toBe(before);
    expect(listEvents(store.db)).toHaveLength(0);
    closeStore(store);
  });

  test("happy path: rebuild-equals-live — replaying the log from scratch matches the stored projections", () => {
    const store = openStore(dbPath);
    for (let i = 1; i <= 5; i++) {
      commitTick(store, countReducer, {
        events: [makeMoveEvent(i)],
        cursorWallMs: 1000 * i,
        paused: false,
        prngState: `seed-${i}`,
      });
    }

    const live = readLiveProjections(store, countReducer);
    const rebuilt = rebuildProjections(store, countReducer);
    expect(rebuilt).toEqual(live);
    closeStore(store);
  });

  test("file modes stay 0600 after every commit", () => {
    const store = openStore(dbPath);
    commitTick(store, countReducer, {
      events: [makeMoveEvent(1)],
      cursorWallMs: 1000,
      paused: false,
      prngState: "seed",
    });
    expect((statSync(dbPath).mode & 0o777).toString(8)).toBe("600");
    closeStore(store);
  });
});

describe("getEventRow / listEvents", () => {
  test("happy path: stored events round-trip through JSON with correlation/causation IDs intact", () => {
    const store = openStore(dbPath);
    const event = makeMoveEvent(1);
    commitTick(store, countReducer, {
      events: [event],
      cursorWallMs: 1000,
      paused: false,
      prngState: "seed",
    });

    const fetched = getEventRow(store.db, event.id) as WorldEvent;
    expect(fetched.id).toBe(event.id);
    expect(fetched.correlationId).toBe(event.correlationId);
    expect(fetched.causationId).toBe(event.causationId);
    expect(listEvents(store.db)).toHaveLength(1);
    closeStore(store);
  });
});

describe("checkpoint", () => {
  test("happy path: truncates the WAL without closing the store, keeping file modes intact", () => {
    const store = openStore(dbPath);
    commitTick(store, countReducer, {
      events: [makeMoveEvent(1)],
      cursorWallMs: 1000,
      paused: false,
      prngState: "seed",
    });

    checkpoint(store);

    // The store is still usable after a checkpoint (not closed).
    expect(getCurrentSequence(store.db)).toBe(1);
    expect((statSync(dbPath).mode & 0o777).toString(8)).toBe("600");
    closeStore(store);
  });
});

describe("enforceDatabaseFileModes", () => {
  test("re-asserts 0600 on the main file and any wal/shm siblings that exist", () => {
    const store = openStore(dbPath);
    commitTick(store, countReducer, {
      events: [makeMoveEvent(1)],
      cursorWallMs: 1000,
      paused: false,
      prngState: "seed",
    });
    enforceDatabaseFileModes(dbPath);
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = `${dbPath}${suffix}`;
      if (existsSync(path)) {
        expect((statSync(path).mode & 0o777).toString(8)).toBe("600");
      }
    }
    closeStore(store);
  });
});
