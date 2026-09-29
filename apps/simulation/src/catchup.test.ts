import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeStore,
  openStore,
  commitTick as persistCommitTick,
  readCatchUpProgress,
  readClock,
  readLiveProjections,
  readPrngState,
} from "@panthea/persistence";
import { ensureTraceSchema } from "@panthea/telemetry";
import { createPrng } from "@panthea/world";
import { runCatchUp } from "./catchup";
import type { TickDeps } from "./tick";
import {
  createWorldProjectionReducers,
  deserializePrngState,
  loadGreekWorldState,
  restoreWorldTime,
} from "./world-store";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("a world that is currently paused runs no catch-up at all: paused wall time never becomes catch-up", async () => {
  const storeDir = tempDir("panthea-sim-catchup-paused-");
  try {
    const storePath = join(storeDir, "world.sqlite");
    const seeded = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(seeded);
    const store = openStore(storePath, reducers);
    ensureTraceSchema(store.db);
    store.db.run("UPDATE clock SET paused = 1 WHERE id = 1");

    const nowWallMs = readClock(store.db).cursorWallMs + 5 * 60 * 60 * 1000;
    const result = await runCatchUp(
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

test("a trace write failure rolls back the whole chunk: the clock is unchanged and catch-up reports degraded without throwing", async () => {
  const storeDir = tempDir("panthea-sim-catchup-trace-fail-");
  try {
    const storePath = join(storeDir, "world.sqlite");
    const seeded = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(seeded);
    const store = openStore(storePath, reducers);
    // Deliberately not calling ensureTraceSchema: the trace tables don't
    // exist, so the first chunk's own trace write genuinely fails.

    const beforeClock = readClock(store.db);
    const nowWallMs = beforeClock.cursorWallMs + 5 * 60 * 1000;

    const result = await runCatchUp(
      seeded,
      createPrng(1),
      { store, reducers, traceDb: store.db },
      {
        nowWallMs,
      },
    );

    expect(result.degraded).toBeDefined();
    expect(readClock(store.db)).toEqual(beforeClock);

    closeStore(store);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test("missed time above the cap: exactly one hour is applied and the excess is reported as skipped", async () => {
  const storeDir = tempDir("panthea-sim-catchup-cap-");
  try {
    const storePath = join(storeDir, "world.sqlite");
    const seeded = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(seeded);
    const store = openStore(storePath, reducers);
    ensureTraceSchema(store.db);

    const startCursor = readClock(store.db).cursorWallMs;
    const nowWallMs = startCursor + 5 * 60 * 60 * 1000;

    const result = await runCatchUp(
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
    // The persisted cursor jumps to the sampled "now", not merely
    // startCursor + appliedMs: otherwise the 4 discarded hours would
    // still look like missed time to a later catch-up call and get
    // applied a second time.
    expect(clock.cursorWallMs).toBe(nowWallMs);
    expect(clock.tick).toBe(3600);
    expect(clock.paused).toBe(false);

    const live = restoreWorldTime(readLiveProjections(store, reducers), clock);
    expect(live).toEqual(result.state);

    closeStore(store);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
}, 20_000);

test("a capped catch-up run's discarded excess is never replayed by a later catch-up call", async () => {
  const storeDir = tempDir("panthea-sim-catchup-no-replay-");
  try {
    const storePath = join(storeDir, "world.sqlite");
    const seeded = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(seeded);
    const store = openStore(storePath, reducers);
    ensureTraceSchema(store.db);

    const startCursor = readClock(store.db).cursorWallMs;
    const firstNow = startCursor + 5 * 60 * 60 * 1000;

    const firstRun = await runCatchUp(
      seeded,
      createPrng(1),
      { store, reducers, traceDb: store.db },
      { nowWallMs: firstNow },
    );
    expect(firstRun.degraded).toBeUndefined();
    expect(firstRun.summary.appliedMs).toBe(60 * 60 * 1000);
    expect(firstRun.state.tick).toBe(3600);

    // A live-loop-style second call, moments later: the cursor already
    // sits at (approximately) now, so this applies essentially nothing --
    // never another hour of ticks for the same already-discarded gap.
    const secondNow = firstNow + 500;
    const secondRun = await runCatchUp(
      firstRun.state,
      firstRun.prng,
      { store, reducers, traceDb: store.db },
      { nowWallMs: secondNow },
    );

    expect(secondRun.summary.appliedMs).toBe(0);
    expect(secondRun.state.tick).toBe(3600);
    // Total simulated advance across both calls stays exactly one hour.
    expect(firstRun.summary.appliedMs + secondRun.summary.appliedMs).toBe(
      60 * 60 * 1000,
    );

    closeStore(store);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
}, 20_000);

test("pause during catch-up stops at the chunk boundary, persists paused, and reports the remainder as skipped", async () => {
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
    const result = await runCatchUp(
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

test("a commit that throws partway through catch-up leaves the earlier chunks committed: a reopened store resumes there, applies the rest once, and reports the whole backlog", async () => {
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

    const firstRun = await runCatchUp(
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

    const secondRun = await runCatchUp(
      restoredState,
      restoredPrng,
      { store, reducers: freshReducers, traceDb: store.db },
      { nowWallMs },
    );
    expect(secondRun.degraded).toBeUndefined();
    // The summary covers the whole backlog, including the chunks the first
    // run committed before it failed.
    expect(secondRun.summary.appliedMs).toBe(5 * 60 * 1000);

    const finalClock = readClock(store.db);
    expect(finalClock.cursorWallMs).toBe(startCursor + 5 * 60 * 1000);
    expect(finalClock.tick).toBe(300);

    // No interval was applied twice: 5 minutes of ticks for a 5 minute gap.
    expect(finalClock.tick).toBe(300);

    closeStore(store);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test("a gap shorter than one tick applies nothing, skips nothing, and reports no outcomes", async () => {
  const storeDir = tempDir("panthea-sim-catchup-subtick-");
  try {
    const seeded = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(seeded);
    const store = openStore(join(storeDir, "world.sqlite"), reducers);
    ensureTraceSchema(store.db);
    const before = readClock(store.db);

    const result = await runCatchUp(
      seeded,
      createPrng(1),
      { store, reducers, traceDb: store.db },
      { nowWallMs: before.cursorWallMs + 5 },
    );

    expect(result.summary).toEqual({
      appliedMs: 0,
      skippedMs: 0,
      majorOutcomes: [],
    });
    expect(readClock(store.db)).toEqual(before);

    closeStore(store);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

/** A `commitTick` that throws on its `failOn`-th call: the commit fails as it would if the process died at that point, but the process itself carries on. */
function throwsAtCommit(failOn: number) {
  let attempt = 0;
  return function commitTick<TProjections>(
    ...args: Parameters<typeof persistCommitTick<TProjections>>
  ): ReturnType<typeof persistCommitTick<TProjections>> {
    attempt += 1;
    if (attempt === failOn) {
      throw new Error("simulated commit failure");
    }
    return persistCommitTick(...args);
  };
}

const HOUR_MS = 60 * 60 * 1000;

interface Backlog {
  readonly storePath: string;
  readonly startCursor: number;
  /** Runs catch-up on a store freshly opened from disk, as a restarted service would. */
  run(
    nowWallMs: number,
    commitTick?: TickDeps["commitTick"],
  ): Promise<Awaited<ReturnType<typeof runCatchUp>>>;
  clock(): ReturnType<typeof readClock>;
  progress(): ReturnType<typeof readCatchUpProgress>;
  dispose(): void;
}

function openBacklog(prefix: string): Backlog {
  const storeDir = tempDir(prefix);
  const storePath = join(storeDir, "world.sqlite");
  const first = openStore(
    storePath,
    createWorldProjectionReducers(loadGreekWorldState()),
  );
  const startCursor = readClock(first.db).cursorWallMs;
  closeStore(first);

  async function withStore<T>(
    fn: (store: ReturnType<typeof openStore>) => Promise<T> | T,
  ) {
    const store = openStore(
      storePath,
      createWorldProjectionReducers(loadGreekWorldState()),
    );
    try {
      return await fn(store);
    } finally {
      closeStore(store);
    }
  }

  return {
    storePath,
    startCursor,
    run: (nowWallMs, commitTick) =>
      withStore((store) => {
        const reducers = createWorldProjectionReducers(loadGreekWorldState());
        ensureTraceSchema(store.db);
        const state = restoreWorldTime(
          readLiveProjections(store, reducers),
          readClock(store.db),
        );
        return runCatchUp(
          state,
          deserializePrngState(readPrngState(store.db)) ?? createPrng(1),
          {
            store,
            reducers,
            traceDb: store.db,
            ...(commitTick ? { commitTick } : {}),
          },
          { nowWallMs },
        );
      }),
    clock: () => {
      const store = openStore(
        storePath,
        createWorldProjectionReducers(loadGreekWorldState()),
      );
      try {
        return readClock(store.db);
      } finally {
        closeStore(store);
      }
    },
    progress: () => {
      const store = openStore(
        storePath,
        createWorldProjectionReducers(loadGreekWorldState()),
      );
      try {
        return readCatchUpProgress(store.db);
      } finally {
        closeStore(store);
      }
    },
    dispose: () => rmSync(storeDir, { recursive: true, force: true }),
  };
}

test("a 5 hour gap with a commit that throws after two chunks, then a reopen: the backlog applies exactly the cap in total, skips exactly the excess, and applies nothing twice", async () => {
  const backlog = openBacklog("panthea-sim-catchup-cap-throw-");
  try {
    const gapMs = 5 * HOUR_MS;
    const nowWallMs = backlog.startCursor + gapMs;

    // Commit 1 discards the excess; commits 2 and 3 are chunks; commit 4 throws.
    const firstRun = await backlog.run(nowWallMs, throwsAtCommit(4));
    expect(firstRun.degraded).toBeDefined();
    expect(firstRun.summary).toEqual({
      appliedMs: 2 * 60 * 1000,
      skippedMs: gapMs - HOUR_MS,
      majorOutcomes: [],
    });
    expect(backlog.clock().tick).toBe(120);

    const secondRun = await backlog.run(nowWallMs);
    expect(secondRun.degraded).toBeUndefined();
    expect(secondRun.summary.appliedMs).toBe(HOUR_MS);
    expect(secondRun.summary.skippedMs).toBe(gapMs - HOUR_MS);
    expect(backlog.clock().tick).toBe(3600);
    expect(backlog.clock().cursorWallMs).toBe(nowWallMs);
    expect(backlog.progress()).toBeUndefined();
  } finally {
    backlog.dispose();
  }
}, 30_000);

test("the excess over the cap is discarded in its own commit before any chunk: a commit that throws on the first chunk still leaves a gap no larger than the cap, and the progress records the discard", async () => {
  const backlog = openBacklog("panthea-sim-catchup-cap-discard-");
  try {
    const nowWallMs = backlog.startCursor + 5 * HOUR_MS;
    const result = await backlog.run(nowWallMs, throwsAtCommit(2));

    expect(result.degraded).toBeDefined();
    expect(backlog.clock().tick).toBe(0);
    expect(nowWallMs - backlog.clock().cursorWallMs).toBe(HOUR_MS);
    expect(result.summary).toEqual({
      appliedMs: 0,
      skippedMs: 4 * HOUR_MS,
      majorOutcomes: [],
    });
    expect(backlog.progress()).toEqual({
      appliedMs: 0,
      discardedMs: 4 * HOUR_MS,
    });
  } finally {
    backlog.dispose();
  }
});

test("a commit that throws after the discard and before the first chunk, then a reopen: the restart still reports the discarded excess as skipped", async () => {
  const backlog = openBacklog("panthea-sim-catchup-cap-restart-");
  try {
    const gapMs = 5 * HOUR_MS;
    const nowWallMs = backlog.startCursor + gapMs;
    await backlog.run(nowWallMs, throwsAtCommit(2));

    const restarted = await backlog.run(nowWallMs);

    expect(restarted.degraded).toBeUndefined();
    expect(restarted.summary.appliedMs).toBe(HOUR_MS);
    expect(restarted.summary.skippedMs).toBe(gapMs - HOUR_MS);
    expect(backlog.progress()).toBeUndefined();
  } finally {
    backlog.dispose();
  }
}, 30_000);

test("the cap bounds the remaining backlog: a discard, an immediate failure, and 30 s of downtime apply the cap in total and report the extra 30 s as skipped", async () => {
  const backlog = openBacklog("panthea-sim-catchup-cap-downtime-");
  try {
    const firstNow = backlog.startCursor + 5 * HOUR_MS;
    const downtimeMs = 30_000;
    await backlog.run(firstNow, throwsAtCommit(2));

    const restarted = await backlog.run(firstNow + downtimeMs);

    expect(restarted.summary.appliedMs).toBe(HOUR_MS);
    expect(restarted.summary.skippedMs).toBe(4 * HOUR_MS + downtimeMs);
    expect(backlog.clock().tick).toBe(3600);
  } finally {
    backlog.dispose();
  }
}, 30_000);

test("the cap bounds the remaining backlog, not the total: after a chunks were applied, a restart d later applies C - a + d", async () => {
  const backlog = openBacklog("panthea-sim-catchup-cap-remaining-");
  try {
    const firstNow = backlog.startCursor + 5 * HOUR_MS;
    const downtimeMs = 30_000;
    const applied = 60 * 1000;
    const first = await backlog.run(firstNow, throwsAtCommit(3));
    expect(first.summary.appliedMs).toBe(applied);

    const restarted = await backlog.run(firstNow + downtimeMs);

    // This run applied C - a + d; the summary counts the backlog's total.
    expect(backlog.clock().tick - applied / 1000).toBe(
      (HOUR_MS - applied + downtimeMs) / 1000,
    );
    expect(restarted.summary.appliedMs).toBe(HOUR_MS + downtimeMs);
    expect(restarted.summary.skippedMs).toBe(4 * HOUR_MS);
  } finally {
    backlog.dispose();
  }
}, 30_000);

test("a backlog that fully applied before the final cursor commit failed is finished by the next start: the summary is published and the progress cleared", async () => {
  const backlog = openBacklog("panthea-sim-catchup-final-commit-");
  try {
    const nowWallMs = backlog.startCursor + 2 * 60 * 1000;
    // Commits 1 and 2 are the chunks; commit 3, the final cursor commit, throws.
    const failed = await backlog.run(nowWallMs, throwsAtCommit(3));
    expect(failed.degraded).toBeDefined();
    expect(backlog.progress()).toEqual({ appliedMs: 120_000, discardedMs: 0 });

    const restarted = await backlog.run(nowWallMs);

    expect(restarted.degraded).toBeUndefined();
    expect(restarted.summary).toEqual({
      appliedMs: 120_000,
      skippedMs: 0,
      majorOutcomes: [],
    });
    expect(backlog.progress()).toBeUndefined();
  } finally {
    backlog.dispose();
  }
});

test("once a backlog completes, the next catch-up starts a new one: its summary counts only its own time", async () => {
  const backlog = openBacklog("panthea-sim-catchup-new-backlog-");
  try {
    const firstNow = backlog.startCursor + 2 * 60 * 1000;
    await backlog.run(firstNow);
    expect(backlog.progress()).toBeUndefined();

    const second = await backlog.run(firstNow + 60 * 1000);
    expect(second.summary.appliedMs).toBe(60 * 1000);
  } finally {
    backlog.dispose();
  }
});
