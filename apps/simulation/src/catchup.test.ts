import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCatchUpProgress,
  closeStore,
  exportArchive,
  getExternalProposal,
  insertExternalProposal,
  listEvents,
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
import { refreshStatusAfterCatchUp } from "./index";
import { createServiceStatusRef } from "./server";
import type { TickDeps } from "./tick";
import {
  createWorldProjectionReducers,
  deserializePrngState,
  loadGreekWorldState,
  restoreWorldTime,
} from "./world-store";
import { importWorldArchive } from "./worlds";

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
    // The service publishes the summary and closes the backlog before any
    // later call; a second call that finds it open would report its totals.
    clearCatchUpProgress(store.db);

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
    /** Called at each between-chunk yield, where a request could arrive; returning `true` pauses catch-up there, anything else lets it go on. */
    betweenChunks?: (db: Database) => boolean | undefined,
    /** `crashBeforePublish` stops the run where the service would have died after the last commit and before publishing the summary. */
    options?: { readonly crashBeforePublish?: boolean },
  ): Promise<Awaited<ReturnType<typeof runCatchUp>>>;
  /** Exports the store, as it stands on disk, to `archivePath`. */
  exportTo(archivePath: string): void;
  /** Runs `fn` against the store opened fresh from disk. */
  withDb<T>(fn: (db: Database) => T): T;
  clock(): ReturnType<typeof readClock>;
  progress(): ReturnType<typeof readCatchUpProgress>;
  dispose(): void;
}

function openBacklog(prefix: string): Backlog {
  const storeDir = tempDir(prefix);
  return backlogAt(join(storeDir, "world.sqlite"), () =>
    rmSync(storeDir, { recursive: true, force: true }),
  );
}

/** A backlog over the store at `storePath` (created if new), reopened from disk for every operation. */
function backlogAt(storePath: string, dispose: () => void = () => {}): Backlog {
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
    exportTo: (archivePath) => {
      const store = openStore(
        storePath,
        createWorldProjectionReducers(loadGreekWorldState()),
      );
      try {
        exportArchive(store, archivePath);
      } finally {
        closeStore(store);
      }
    },
    run: (nowWallMs, commitTick, betweenChunks, options) =>
      withStore(async (store) => {
        const reducers = createWorldProjectionReducers(loadGreekWorldState());
        ensureTraceSchema(store.db);
        const state = restoreWorldTime(
          readLiveProjections(store, reducers),
          readClock(store.db),
        );
        const result = await runCatchUp(
          state,
          deserializePrngState(readPrngState(store.db)) ?? createPrng(1),
          {
            store,
            reducers,
            traceDb: store.db,
            ...(commitTick ? { commitTick } : {}),
          },
          {
            nowWallMs,
            ...(betweenChunks
              ? { onChunkCommitted: () => betweenChunks(store.db) === true }
              : {}),
          },
        );
        // What the service does with a result: publish it, then close the
        // backlog. A run that "crashes" stops before that.
        if (!options?.crashBeforePublish) {
          refreshStatusAfterCatchUp(
            createServiceStatusRef(result.state),
            result,
            store,
          );
        }
        return result;
      }),
    withDb: (fn) => {
      const store = openStore(
        storePath,
        createWorldProjectionReducers(loadGreekWorldState()),
      );
      try {
        return fn(store.db);
      } finally {
        closeStore(store);
      }
    },
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
    dispose,
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
      startSequence: 0,
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
    expect(backlog.progress()).toEqual({
      appliedMs: 120_000,
      discardedMs: 0,
      startSequence: 0,
    });

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

/** A journal entry for a strike by zeus, which has no routine of its own. */
function strikeEntry(id: string) {
  return {
    proposalId: `proposal-catchup-${id}`,
    proposal: {
      schemaVersion: 1,
      kind: "strike",
      actor: "zeus",
      target: "the-tavern",
      power: 3,
      targets: [],
      expectedRevisions: [],
      source: "fixture",
      observationId: `obs-catchup-${id}`,
    },
    observation: {
      schemaVersion: 1,
      id: `obs-catchup-${id}`,
      observer: "zeus",
      stateRevision: 0,
      factsRead: [],
      source: "fixture",
    },
  };
}

test("a pending external proposal runs in the first tick of the next catch-up chunk, marked approximate, and is consumed there", async () => {
  const backlog = openBacklog("panthea-sim-catchup-journal-first-");
  try {
    backlog.withDb((db) => insertExternalProposal(db, strikeEntry("a")));

    await backlog.run(backlog.startCursor + 3 * 60 * 1000);

    backlog.withDb((db) => {
      expect(getExternalProposal(db, "proposal-catchup-a")).toMatchObject({
        targetTick: 1,
        consumedTick: 1,
      });
      const caused = listEvents(db).filter(
        (event) => String(event.correlationId) === "obs-catchup-a",
      );
      expect(caused.map((event) => event.kind)).toEqual([
        "resource-consumed",
        "building-ignited",
      ]);
      expect(caused.every((event) => event.approximate)).toBe(true);
    });
  } finally {
    backlog.dispose();
  }
});

test("a proposal accepted while catch-up yields between chunks targets the next committed tick and runs in the next chunk", async () => {
  const backlog = openBacklog("panthea-sim-catchup-journal-between-");
  try {
    let accepted = false;
    await backlog.run(backlog.startCursor + 3 * 60 * 1000, undefined, (db) => {
      if (!accepted) {
        accepted = true;
        insertExternalProposal(db, strikeEntry("b"));
      }
      return undefined;
    });

    backlog.withDb((db) => {
      expect(getExternalProposal(db, "proposal-catchup-b")).toMatchObject({
        targetTick: 61,
        consumedTick: 61,
      });
    });
  } finally {
    backlog.dispose();
  }
});

test("the cap discard neither consumes nor reschedules a pending proposal: it stays targeted at its tick and runs when ticking resumes", async () => {
  const backlog = openBacklog("panthea-sim-catchup-journal-discard-");
  try {
    const nowWallMs = backlog.startCursor + 5 * HOUR_MS;
    backlog.withDb((db) => insertExternalProposal(db, strikeEntry("c")));

    // The discard commits; the first chunk fails.
    await backlog.run(nowWallMs, throwsAtCommit(2));
    backlog.withDb((db) => {
      expect(getExternalProposal(db, "proposal-catchup-c")).toMatchObject({
        targetTick: 1,
        consumedTick: undefined,
      });
    });

    await backlog.run(nowWallMs);
    backlog.withDb((db) => {
      expect(getExternalProposal(db, "proposal-catchup-c")?.consumedTick).toBe(
        1,
      );
    });
  } finally {
    backlog.dispose();
  }
}, 30_000);

test("a chunk that fails to commit leaves the pending proposal pending, with no outcome and no effects, and the retry runs it once", async () => {
  const backlog = openBacklog("panthea-sim-catchup-journal-fail-");
  try {
    const nowWallMs = backlog.startCursor + 3 * 60 * 1000;
    backlog.withDb((db) => insertExternalProposal(db, strikeEntry("d")));

    const failed = await backlog.run(nowWallMs, throwsAtCommit(1));
    expect(failed.degraded).toBeDefined();
    backlog.withDb((db) => {
      expect(
        getExternalProposal(db, "proposal-catchup-d")?.consumedTick,
      ).toBeUndefined();
      expect(listEvents(db)).toEqual([]);
    });

    await backlog.run(nowWallMs);
    backlog.withDb((db) => {
      expect(getExternalProposal(db, "proposal-catchup-d")?.consumedTick).toBe(
        1,
      );
      expect(
        listEvents(db).filter(
          (event) => String(event.correlationId) === "obs-catchup-d",
        ),
      ).toHaveLength(2);
    });
  } finally {
    backlog.dispose();
  }
});

// --- A backlog's summary across restarts, crashes, pauses, and restores ---------

const THREE_MINUTES_MS = 3 * 60 * 1000;

/** A backlog holding the strike entry, so its first chunk ignites the tavern. */
function backlogWithStrike(prefix: string, id: string): Backlog {
  const backlog = openBacklog(prefix);
  backlog.withDb((db) => insertExternalProposal(db, strikeEntry(id)));
  return backlog;
}

/** What one uninterrupted run over the strike backlog reports: the yardstick every interrupted variant must equal. */
async function uninterruptedSummary() {
  const backlog = backlogWithStrike("panthea-sim-catchup-yardstick-", "y");
  try {
    const result = await backlog.run(backlog.startCursor + THREE_MINUTES_MS);
    expect(result.degraded).toBeUndefined();
    return result.summary;
  } finally {
    backlog.dispose();
  }
}

test("the yardstick: an uninterrupted run over the strike backlog reports the ignition and its consequences among its outcomes", async () => {
  const summary = await uninterruptedSummary();

  expect(summary.appliedMs).toBe(THREE_MINUTES_MS);
  expect(summary.majorOutcomes).toContain("building-ignited:the-tavern");
  expect(summary.majorOutcomes).toContain("building-destroyed:the-tavern");
});

test("a backlog interrupted after a chunk that found outcomes reports them after the restart, and its whole summary equals an uninterrupted run's", async () => {
  const yardstick = await uninterruptedSummary();
  const backlog = backlogWithStrike("panthea-sim-catchup-outcomes-", "o");
  try {
    const nowWallMs = backlog.startCursor + THREE_MINUTES_MS;

    // Two chunks commit, the third fails.
    const interrupted = await backlog.run(nowWallMs, throwsAtCommit(3));
    expect(interrupted.degraded).toBeDefined();
    expect(interrupted.summary.majorOutcomes).toContain(
      "building-ignited:the-tavern",
    );

    const resumed = await backlog.run(nowWallMs);

    expect(resumed.degraded).toBeUndefined();
    expect(resumed.summary).toEqual(yardstick);
  } finally {
    backlog.dispose();
  }
}, 30_000);

test("the process dying after the last commit and before the summary is published: the next start publishes the same summary, then closes the backlog", async () => {
  const yardstick = await uninterruptedSummary();
  const backlog = backlogWithStrike("panthea-sim-catchup-crash-window-", "w");
  try {
    const nowWallMs = backlog.startCursor + THREE_MINUTES_MS;

    const finished = await backlog.run(nowWallMs, undefined, undefined, {
      crashBeforePublish: true,
    });
    expect(finished.summary).toEqual(yardstick);
    expect(backlog.progress()).toBeDefined();

    const restarted = await backlog.run(nowWallMs);

    expect(restarted.summary).toEqual(yardstick);
    expect(backlog.progress()).toBeUndefined();
  } finally {
    backlog.dispose();
  }
}, 30_000);

test("a backlog ended by a mid-catch-up pause keeps its summary until published: a restart while paused reports it, then closes the backlog", async () => {
  const backlog = backlogWithStrike("panthea-sim-catchup-pause-", "p");
  try {
    const nowWallMs = backlog.startCursor + THREE_MINUTES_MS;

    const paused = await backlog.run(nowWallMs, undefined, () => true, {
      crashBeforePublish: true,
    });
    expect(backlog.clock().paused).toBe(true);
    expect(paused.summary.appliedMs).toBe(60_000);
    expect(paused.summary.skippedMs).toBe(2 * 60_000);
    expect(paused.summary.majorOutcomes).toContain(
      "building-ignited:the-tavern",
    );

    const restartedWhilePaused = await backlog.run(nowWallMs);

    expect(restartedWhilePaused.summary).toEqual(paused.summary);
    expect(backlog.progress()).toBeUndefined();
  } finally {
    backlog.dispose();
  }
}, 30_000);

test("a closed backlog's outcomes never leak into the next one: the second summary counts only events committed after its own start", async () => {
  const backlog = backlogWithStrike("panthea-sim-catchup-two-backlogs-", "t");
  try {
    const firstNow = backlog.startCursor + THREE_MINUTES_MS;
    const first = await backlog.run(firstNow);
    expect(first.summary.majorOutcomes).toContain(
      "building-ignited:the-tavern",
    );
    const sequenceAfterFirst = backlog.withDb(
      (db) => listEvents(db).at(-1)?.sequence ?? 0,
    );

    const failed = await backlog.run(firstNow + 2 * 60_000, throwsAtCommit(2));
    expect(failed.degraded).toBeDefined();
    expect(backlog.progress()?.startSequence).toBe(sequenceAfterFirst);

    const second = await backlog.run(firstNow + 2 * 60_000);

    expect(second.summary.majorOutcomes).not.toContain(
      "building-ignited:the-tavern",
    );
    const expected = backlog.withDb((db) =>
      listEvents(db, { fromSequence: sequenceAfterFirst })
        .filter((event) =>
          [
            "building-ignited",
            "building-destroyed",
            "building-repaired",
            "legend-recorded",
          ].includes(event.kind),
        )
        .map((event) => `${event.kind}:${String(event.entityId)}`),
    );
    expect(second.summary.majorOutcomes).toEqual(expected);
  } finally {
    backlog.dispose();
  }
}, 30_000);

test("a backlog's progress records the event sequence it started after", async () => {
  const backlog = backlogWithStrike("panthea-sim-catchup-start-sequence-", "s");
  try {
    await backlog.run(
      backlog.startCursor + THREE_MINUTES_MS,
      throwsAtCommit(2),
    );

    expect(backlog.progress()?.startSequence).toBe(0);
  } finally {
    backlog.dispose();
  }
});

test("an archive exported mid-backlog, imported, and resumed reports the same summary as an uninterrupted run: applied, skipped, and outcomes", async () => {
  const yardstick = await uninterruptedSummary();
  const backlog = backlogWithStrike("panthea-sim-catchup-archive-", "a");
  const slotsDir = tempDir("panthea-sim-catchup-archive-slots-");
  try {
    const nowWallMs = backlog.startCursor + THREE_MINUTES_MS;
    const interrupted = await backlog.run(nowWallMs, throwsAtCommit(3));
    expect(interrupted.degraded).toBeDefined();
    const archivePath = join(slotsDir, "mid-backlog.sqlite");
    backlog.exportTo(archivePath);

    const slot = importWorldArchive(
      archivePath,
      join(slotsDir, "slots"),
      createWorldProjectionReducers(loadGreekWorldState()).codec,
    );
    const restored = backlogAt(join(slot.slotPath, "world.sqlite"));
    const resumed = await restored.run(nowWallMs);

    expect(resumed.degraded).toBeUndefined();
    expect(resumed.summary).toEqual(yardstick);
  } finally {
    backlog.dispose();
    rmSync(slotsDir, { recursive: true, force: true });
  }
}, 30_000);
