import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
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
import {
  clearCatchUpProgress,
  closeStore,
  commitTick,
  getCurrentSequence,
  getEventRow,
  listEvents,
  NonContiguousSequenceError,
  openStore,
  type ProjectionReducers,
  readCatchUpProgress,
  readClock,
  readLiveProjections,
  rebuildProjections,
  writeCatchUpProgress,
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
 * packages/world's real projection shape. */
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

describe("openStore", () => {
  test("happy path: creates the parent dir 0700 and the db file 0600 once, at creation", () => {
    const store = openStore(dbPath, countReducer);
    expect((statSync(dir).mode & 0o777).toString(8)).toBe("700");
    expect((statSync(dbPath).mode & 0o777).toString(8)).toBe("600");
    closeStore(store);
  });

  test("happy path: a fresh store gets a generated world ID that survives reopen", () => {
    const store = openStore(dbPath, countReducer);
    const worldId = store.worldId;
    closeStore(store);

    const reopened = openStore(dbPath, countReducer);
    expect(reopened.worldId).toBe(worldId);
    closeStore(reopened);
  });

  test("WAL mode is enabled and synchronous is NORMAL", () => {
    const store = openStore(dbPath, countReducer);
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
    const store = openStore(dbPath, countReducer);
    const originalWorldId = store.worldId;
    closeStore(store);

    const mismatchedWorldId = createWorldId();
    expect(() =>
      openStore(dbPath, countReducer, { worldId: mismatchedWorldId }),
    ).toThrow(/already belongs to world/);

    const reopened = openStore(dbPath, countReducer);
    expect(reopened.worldId).toBe(originalWorldId);
    closeStore(reopened);
  });

  test("reopening an existing store with a matching worldId opens normally", () => {
    const store = openStore(dbPath, countReducer);
    const worldId = store.worldId;
    closeStore(store);

    const reopened = openStore(dbPath, countReducer, { worldId });
    expect(reopened.worldId).toBe(worldId);
    closeStore(reopened);
  });

  test("opening an existing store whose schema version does not match this build's version throws and never resets it", () => {
    const store = openStore(dbPath, countReducer);
    closeStore(store);

    const db = new Database(dbPath);
    db.exec("PRAGMA user_version = 99");
    db.close();

    expect(() => openStore(dbPath, countReducer)).toThrow(/schema version 99/);
    // The failed open closes its handle rather than leaking it -- a repeat
    // attempt fails the same way, not with a "database is locked" error.
    expect(() => openStore(dbPath, countReducer)).toThrow(/schema version 99/);
  });

  test("an existing version 1 store is refused and left untouched: same bytes, no new files, no reset", () => {
    const v1 = new Database(dbPath, { create: true });
    v1.exec("PRAGMA journal_mode = WAL");
    v1.exec(
      "CREATE TABLE world (id INTEGER PRIMARY KEY CHECK (id = 1), world_id TEXT NOT NULL) STRICT",
    );
    v1.run("INSERT INTO world (id, world_id) VALUES (1, 'world-from-v1')");
    v1.exec("PRAGMA user_version = 1");
    v1.close();
    const bytesBefore = readFileSync(dbPath);
    const filesBefore = readdirSync(dir).sort();

    expect(() => openStore(dbPath, countReducer)).toThrow(/schema version 1/);

    expect(readFileSync(dbPath).equals(bytesBefore)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(filesBefore);
    const check = new Database(dbPath, { readonly: true });
    expect(
      (check.query("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    ).toBe(1);
    check.close();
  });

  test("this build stamps schema version 2", () => {
    const store = openStore(dbPath, countReducer);
    expect(
      (
        store.db.query("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
    ).toBe(2);
    closeStore(store);
  });

  test("happy path: a brand-new store's genesis row round-trips through the codec and matches its own projections row at creation", () => {
    const store = openStore(dbPath, countReducer);
    const genesisRow = store.db
      .query("SELECT data FROM genesis WHERE id = 1")
      .get() as {
      data: string;
    };
    expect(JSON.parse(genesisRow.data)).toEqual(countReducer.initial);
    closeStore(store);
  });

  test("under umask 022, the db file and its WAL/SHM siblings are all created 0600, not 0644", () => {
    const previousUmask = process.umask(0o022);
    try {
      const store = openStore(dbPath, countReducer);
      commitTick(store, countReducer, {
        events: [makeMoveEvent(1)],
        cursorWallMs: 1000,
        paused: false,
        tick: 1,
        simTimeMs: 1000,
        prngState: "seed",
      });

      expect((statSync(dbPath).mode & 0o777).toString(8)).toBe("600");
      expect((statSync(`${dbPath}-wal`).mode & 0o777).toString(8)).toBe("600");
      expect((statSync(`${dbPath}-shm`).mode & 0o777).toString(8)).toBe("600");

      closeStore(store);
    } finally {
      process.umask(previousUmask);
    }
  });
});

describe("commitTick", () => {
  test("happy path: commits events, advances projections, cursor, and PRNG state atomically", () => {
    const store = openStore(dbPath, countReducer);
    const event = makeMoveEvent(1);

    const result = commitTick(store, countReducer, {
      events: [event],
      cursorWallMs: 5000,
      paused: false,
      tick: 1,
      simTimeMs: 5000,
      prngState: "seed-1",
    });

    expect(result.sequence).toBe(1);
    expect(result.projections.moves[String(event.entityId)]).toBe(1);
    expect(getCurrentSequence(store.db)).toBe(1);
    expect(readClock(store.db)).toEqual({
      cursorWallMs: 5000,
      paused: false,
      tick: 1,
      simTimeMs: 5000,
    });
    closeStore(store);
  });

  test("integration: a throw mid-tick (non-contiguous sequence) leaves events, projections, cursor, and PRNG state unchanged", () => {
    const store = openStore(dbPath, countReducer);
    commitTick(store, countReducer, {
      events: [makeMoveEvent(1)],
      cursorWallMs: 1000,
      paused: false,
      tick: 1,
      simTimeMs: 1000,
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
        tick: 2,
        simTimeMs: 9999,
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
    const store = openStore(dbPath, countReducer);
    const before = getCurrentSequence(store.db);

    const faultyReducer: ProjectionReducers<CountProjection> = {
      ...countReducer,
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
        tick: 1,
        simTimeMs: 1234,
        prngState: "seed-x",
      }),
    ).toThrow("simulated reducer fault");

    expect(getCurrentSequence(store.db)).toBe(before);
    expect(listEvents(store.db)).toHaveLength(0);
    closeStore(store);
  });

  test("happy path: onCommitted runs inside the same transaction, after events/projections/clock/PRNG are written", () => {
    const store = openStore(dbPath, countReducer);
    let sawEventCountInsideHook: number | undefined;

    commitTick(store, countReducer, {
      events: [makeMoveEvent(1)],
      cursorWallMs: 1000,
      paused: false,
      tick: 1,
      simTimeMs: 1000,
      prngState: "seed-1",
      onCommitted: (db) => {
        db.run(
          "CREATE TABLE IF NOT EXISTS side_effect (id INTEGER PRIMARY KEY)",
        );
        db.run("INSERT INTO side_effect (id) VALUES (1)");
        sawEventCountInsideHook = getCurrentSequence(db);
      },
    });

    expect(sawEventCountInsideHook).toBe(1);
    const sideEffectRow = store.db
      .query("SELECT id FROM side_effect WHERE id = 1")
      .get();
    expect(sideEffectRow).toEqual({ id: 1 });
    closeStore(store);
  });

  test("integration: a throwing onCommitted rolls back the whole tick, including events/projections/clock/PRNG already written in the same call", () => {
    const store = openStore(dbPath, countReducer);
    const before = {
      sequence: getCurrentSequence(store.db),
      clock: readClock(store.db),
      projections: readLiveProjections(store, countReducer),
    };

    expect(() =>
      commitTick(store, countReducer, {
        events: [makeMoveEvent(1)],
        cursorWallMs: 5000,
        paused: false,
        tick: 1,
        simTimeMs: 5000,
        prngState: "seed-should-not-persist",
        onCommitted: () => {
          throw new Error("simulated trace write failure");
        },
      }),
    ).toThrow("simulated trace write failure");

    expect(getCurrentSequence(store.db)).toBe(before.sequence);
    expect(readClock(store.db)).toEqual(before.clock);
    expect(readLiveProjections(store, countReducer)).toEqual(
      before.projections,
    );
    expect(listEvents(store.db)).toHaveLength(0);
    closeStore(store);
  });

  test("happy path: rebuild-equals-live — replaying the log from scratch matches the stored projections", () => {
    const store = openStore(dbPath, countReducer);
    for (let i = 1; i <= 5; i++) {
      commitTick(store, countReducer, {
        events: [makeMoveEvent(i)],
        cursorWallMs: 1000 * i,
        paused: false,
        tick: i,
        simTimeMs: 1000 * i,
        prngState: `seed-${i}`,
      });
    }

    const live = readLiveProjections(store, countReducer);
    const rebuilt = rebuildProjections(store, countReducer);
    expect(rebuilt).toEqual(live);
    closeStore(store);
  });

  test("rebuild starts from the store's own persisted genesis row, not the caller's reducers.initial", () => {
    const store = openStore(dbPath, countReducer);
    commitTick(store, countReducer, {
      events: [makeMoveEvent(1)],
      cursorWallMs: 1000,
      paused: false,
      tick: 1,
      simTimeMs: 1000,
      prngState: "seed-1",
    });
    closeStore(store);

    // A reducers object with a *different* initial value and no relation to
    // whatever the store was actually created with -- genesis makes rebuild
    // independent of this.
    const unrelatedReducers: ProjectionReducers<CountProjection> = {
      ...countReducer,
      initial: { moves: { phantom: 999 } },
    };
    const reopened = openStore(dbPath, unrelatedReducers);
    const rebuilt = rebuildProjections(reopened, unrelatedReducers);
    const live = readLiveProjections(reopened, unrelatedReducers);

    expect(rebuilt).toEqual(live);
    expect(rebuilt.moves.phantom).toBeUndefined();
    closeStore(reopened);
  });
});

describe("clock tick/simTime", () => {
  test("happy path: committing two ticks and reopening restores tick 2 and its simTime from the clock row", () => {
    const store = openStore(dbPath, countReducer);
    commitTick(store, countReducer, {
      events: [makeMoveEvent(1)],
      cursorWallMs: 1000,
      paused: false,
      tick: 1,
      simTimeMs: 1000,
      prngState: "seed-1",
    });
    commitTick(store, countReducer, {
      events: [makeMoveEvent(2)],
      cursorWallMs: 2000,
      paused: false,
      tick: 2,
      simTimeMs: 2000,
      prngState: "seed-2",
    });
    closeStore(store);

    const reopened = openStore(dbPath, countReducer);
    expect(readClock(reopened.db)).toEqual({
      cursorWallMs: 2000,
      paused: false,
      tick: 2,
      simTimeMs: 2000,
    });
    closeStore(reopened);
  });

  test("integration: a thrown mid-tick transaction leaves tick and simTime unchanged", () => {
    const store = openStore(dbPath, countReducer);
    commitTick(store, countReducer, {
      events: [makeMoveEvent(1)],
      cursorWallMs: 1000,
      paused: false,
      tick: 1,
      simTimeMs: 1000,
      prngState: "seed-1",
    });
    const before = readClock(store.db);

    expect(() =>
      commitTick(store, countReducer, {
        events: [makeMoveEvent(3)],
        cursorWallMs: 9999,
        paused: false,
        tick: 99,
        simTimeMs: 9999,
        prngState: "seed-should-not-persist",
      }),
    ).toThrow(NonContiguousSequenceError);

    expect(readClock(store.db)).toEqual(before);
    closeStore(store);
  });
});

describe("getEventRow / listEvents", () => {
  test("happy path: stored events round-trip through JSON with correlation/causation IDs intact", () => {
    const store = openStore(dbPath, countReducer);
    const event = makeMoveEvent(1);
    commitTick(store, countReducer, {
      events: [event],
      cursorWallMs: 1000,
      paused: false,
      tick: 1,
      simTimeMs: 1000,
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

describe("projection codec", () => {
  interface MapProjection {
    readonly counts: Map<string, number>;
  }

  const mapCodec = {
    encode(projections: MapProjection): unknown {
      return { counts: Object.fromEntries(projections.counts) };
    },
    decode(value: unknown): MapProjection {
      const raw = value as { counts: Record<string, number> };
      return { counts: new Map(Object.entries(raw.counts)) };
    },
  };

  const mapReducer: ProjectionReducers<MapProjection> = {
    initial: { counts: new Map() },
    applyEvent(projections, event) {
      if (event.kind !== "entity-moved") {
        return projections;
      }
      const key = String(event.entityId);
      const counts = new Map(projections.counts);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { counts };
    },
    codec: mapCodec,
  };

  test("happy path: a Map-bearing projection round-trips through a Map-aware codec across commit -> close -> reopen for both readLiveProjections and rebuildProjections", () => {
    const store = openStore(dbPath, mapReducer);
    const event = makeMoveEvent(1);
    commitTick(store, mapReducer, {
      events: [event],
      cursorWallMs: 1000,
      paused: false,
      tick: 1,
      simTimeMs: 1000,
      prngState: "seed",
    });
    closeStore(store);

    const reopened = openStore(dbPath, mapReducer);
    const live = readLiveProjections(reopened, mapReducer);
    const rebuilt = rebuildProjections(reopened, mapReducer);

    expect(live.counts).toBeInstanceOf(Map);
    expect(live.counts.get(String(event.entityId))).toBe(1);
    expect(rebuilt.counts).toBeInstanceOf(Map);
    expect(rebuilt.counts.get(String(event.entityId))).toBe(1);
    expect(live.counts).toEqual(rebuilt.counts);
    closeStore(reopened);
  });
});

describe("catch-up progress", () => {
  function tick(store: ReturnType<typeof openStore>, n: number, extra = {}) {
    commitTick(store, countReducer, {
      events: [makeMoveEvent(n)],
      cursorWallMs: 1000 * n,
      paused: false,
      tick: n,
      simTimeMs: 1000 * n,
      prngState: "seed",
      ...extra,
    });
  }

  test("a new store has no catch-up progress", () => {
    const store = openStore(dbPath, countReducer);
    expect(readCatchUpProgress(store.db)).toBeUndefined();
    closeStore(store);
  });

  test("progress written in a tick's transaction survives a reopen, and clearing removes it", () => {
    const store = openStore(dbPath, countReducer);
    tick(store, 1, {
      onCommitted: (db: Database) =>
        writeCatchUpProgress(db, { appliedMs: 60_000, discardedMs: 4_000 }),
    });
    closeStore(store);

    const reopened = openStore(dbPath, countReducer);
    expect(readCatchUpProgress(reopened.db)).toEqual({
      appliedMs: 60_000,
      discardedMs: 4_000,
    });
    tick(reopened, 2, {
      onCommitted: (db: Database) =>
        writeCatchUpProgress(db, { appliedMs: 120_000, discardedMs: 4_000 }),
    });
    expect(readCatchUpProgress(reopened.db)?.appliedMs).toBe(120_000);
    tick(reopened, 3, { onCommitted: clearCatchUpProgress });
    expect(readCatchUpProgress(reopened.db)).toBeUndefined();
    closeStore(reopened);
  });

  test("progress is rolled back with the tick when the transaction fails", () => {
    const store = openStore(dbPath, countReducer);
    expect(() =>
      tick(store, 1, {
        onCommitted: (db: Database) => {
          writeCatchUpProgress(db, { appliedMs: 1, discardedMs: 1 });
          throw new Error("fail after writing progress");
        },
      }),
    ).toThrow();
    expect(readCatchUpProgress(store.db)).toBeUndefined();
    expect(readClock(store.db).tick).toBe(0);
    closeStore(store);
  });
});
