import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeStore,
  openStore,
  commitTick as persistCommitTick,
  readClock,
  readLiveProjections,
  readPrngState,
} from "@panthea/persistence";
import { ensureTraceSchema } from "@panthea/telemetry";
import { createPrng } from "@panthea/world";
import { runCatchUp } from "./catchup";
import {
  createWorldProjectionReducers,
  deserializePrngState,
  loadGreekWorldState,
  restoreWorldTime,
} from "./world-store";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("a world that is currently paused runs no catch-up at all: paused wall time never becomes catch-up", () => {
  const storeDir = tempDir("panthea-sim-catchup-paused-");
  try {
    const storePath = join(storeDir, "world.sqlite");
    const seeded = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(seeded);
    const store = openStore(storePath, reducers);
    ensureTraceSchema(store.db);
    store.db.run("UPDATE clock SET paused = 1 WHERE id = 1");

    const nowWallMs = readClock(store.db).cursorWallMs + 5 * 60 * 60 * 1000;
    const result = runCatchUp(
      seeded,
      createPrng(1),
      { store, reducers, traceDb: store.db },
      {
        nowWallMs,
      },
    );

    expect(result.summary).toEqual({
      appliedMs: 0,
      skippedMs: 0,
      majorOutcomes: [],
    });
    expect(result.state).toEqual(seeded);
    expect(readClock(store.db).tick).toBe(0);

    closeStore(store);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test("missed time above the cap: exactly one hour is applied and the excess is reported as skipped", () => {
  const storeDir = tempDir("panthea-sim-catchup-cap-");
  try {
    const storePath = join(storeDir, "world.sqlite");
    const seeded = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(seeded);
    const store = openStore(storePath, reducers);
    ensureTraceSchema(store.db);

    const startCursor = readClock(store.db).cursorWallMs;
    const nowWallMs = startCursor + 5 * 60 * 60 * 1000;

    const result = runCatchUp(
      seeded,
      createPrng(1),
      { store, reducers, traceDb: store.db },
      {
        nowWallMs,
      },
    );

    expect(result.degraded).toBeUndefined();
    expect(result.summary.appliedMs).toBe(60 * 60 * 1000);
    expect(result.summary.skippedMs).toBe(4 * 60 * 60 * 1000);
    expect(result.state.tick).toBe(3600);

    const clock = readClock(store.db);
    expect(clock.cursorWallMs).toBe(startCursor + 60 * 60 * 1000);
    expect(clock.tick).toBe(3600);
    expect(clock.paused).toBe(false);

    const live = restoreWorldTime(readLiveProjections(store, reducers), clock);
    expect(live).toEqual(result.state);

    closeStore(store);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
}, 20_000);

test("pause during catch-up stops at the chunk boundary, persists paused, and reports the remainder as skipped", () => {
  const storeDir = tempDir("panthea-sim-catchup-pause-mid-");
  try {
    const storePath = join(storeDir, "world.sqlite");
    const seeded = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(seeded);
    const store = openStore(storePath, reducers);
    ensureTraceSchema(store.db);

    const startCursor = readClock(store.db).cursorWallMs;
    const nowWallMs = startCursor + 5 * 60 * 1000; // 5 chunks of 60s each

    let chunksCommitted = 0;
    const result = runCatchUp(
      seeded,
      createPrng(1),
      { store, reducers, traceDb: store.db },
      {
        nowWallMs,
        onChunkCommitted: () => {
          chunksCommitted += 1;
          return chunksCommitted === 2;
        },
      },
    );

    expect(result.degraded).toBeUndefined();
    expect(result.summary.appliedMs).toBe(2 * 60 * 1000);
    expect(result.summary.skippedMs).toBe(3 * 60 * 1000);

    const clock = readClock(store.db);
    expect(clock.paused).toBe(true);
    expect(clock.cursorWallMs).toBe(startCursor + 2 * 60 * 1000);
    expect(clock.tick).toBe(120);

    closeStore(store);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test("kill during a catch-up chunk: restart resumes from the last committed chunk, the cap is never exceeded, and no interval is applied twice", () => {
  const storeDir = tempDir("panthea-sim-catchup-crash-");
  try {
    const storePath = join(storeDir, "world.sqlite");
    const seeded = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(seeded);
    let store = openStore(storePath, reducers);
    ensureTraceSchema(store.db);

    const startCursor = readClock(store.db).cursorWallMs;
    const nowWallMs = startCursor + 5 * 60 * 1000; // 5 chunks of 60s each

    let chunkAttempt = 0;
    function flakyCommitTick<TProjections>(
      ...args: Parameters<typeof persistCommitTick<TProjections>>
    ): ReturnType<typeof persistCommitTick<TProjections>> {
      chunkAttempt += 1;
      if (chunkAttempt === 3) {
        throw new Error("simulated crash mid-chunk");
      }
      return persistCommitTick(...args);
    }

    const firstRun = runCatchUp(
      seeded,
      createPrng(1),
      { store, reducers, traceDb: store.db, commitTick: flakyCommitTick },
      { nowWallMs },
    );
    expect(firstRun.degraded).toBeDefined();
    expect(firstRun.summary.appliedMs).toBe(2 * 60 * 1000);

    const clockAfterCrash = readClock(store.db);
    expect(clockAfterCrash.cursorWallMs).toBe(startCursor + 2 * 60 * 1000);
    expect(clockAfterCrash.tick).toBe(120);
    expect(clockAfterCrash.paused).toBe(false);

    closeStore(store);

    // Restart: a freshly constructed composition root, reopened from the
    // same path, holding no reference to the crashed run's in-memory
    // state or PRNG -- the same shape as world-store.test.ts's restart
    // scenarios.
    const freshReducers = createWorldProjectionReducers(loadGreekWorldState());
    store = openStore(storePath, freshReducers);
    const restoredClock = readClock(store.db);
    const restoredState = restoreWorldTime(
      readLiveProjections(store, freshReducers),
      restoredClock,
    );
    expect(restoredState.tick).toBe(120);
    const restoredPrng =
      deserializePrngState(readPrngState(store.db)) ?? createPrng(1);

    const secondRun = runCatchUp(
      restoredState,
      restoredPrng,
      { store, reducers: freshReducers, traceDb: store.db },
      { nowWallMs },
    );
    expect(secondRun.degraded).toBeUndefined();
    expect(secondRun.summary.appliedMs).toBe(3 * 60 * 1000);

    const finalClock = readClock(store.db);
    expect(finalClock.cursorWallMs).toBe(startCursor + 5 * 60 * 1000);
    expect(finalClock.tick).toBe(300);

    // Total applied across both runs equals exactly the elapsed window --
    // the cap is never exceeded and no interval was ever double-counted.
    expect(firstRun.summary.appliedMs + secondRun.summary.appliedMs).toBe(
      5 * 60 * 1000,
    );

    closeStore(store);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});
