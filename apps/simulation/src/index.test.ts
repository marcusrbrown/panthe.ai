// Spawns the TypeScript entry directly via `bun run` -- never the compiled
// binary -- matching tools/probes/backend-lifecycle/src/sidecar.test.ts's
// established pattern. Compiled-binary behavior (offline bun:sqlite, no
// build-host leakage) is covered by scripts/scan-binary.sh.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeStore,
  openStore,
  commitTick as persistCommitTick,
  readClock,
} from "@panthea/persistence";
import { ensureTraceSchema } from "@panthea/telemetry";
import { createPrng } from "@panthea/world";
import { runCatchUp } from "./catchup";
import { refreshStatusAfterCatchUp, resolveAppDataDir } from "./index";
import { createServiceStatusRef, updateServiceStatus } from "./server";
import type { TickDeps } from "./tick";
import {
  createWorldProjectionReducers,
  loadGreekWorldState,
  worldProjectionCodec,
} from "./world-store";

const INDEX_ENTRY = join(import.meta.dir, "index.ts");
const STARTUP_TIMEOUT_MS = 10_000;

describe("resolveAppDataDir", () => {
  test("PANTHEA_APP_DATA_DIR overrides every platform", () => {
    const env = { PANTHEA_APP_DATA_DIR: "/tmp/override" } as NodeJS.ProcessEnv;
    expect(resolveAppDataDir(env, "darwin")).toBe("/tmp/override");
    expect(resolveAppDataDir(env, "win32")).toBe("/tmp/override");
    expect(resolveAppDataDir(env, "linux")).toBe("/tmp/override");
  });

  test("each platform resolves to a distinct, non-empty path without an override", () => {
    const env = {} as NodeJS.ProcessEnv;
    const darwin = resolveAppDataDir(env, "darwin");
    const linux = resolveAppDataDir(env, "linux");
    expect(darwin.length).toBeGreaterThan(0);
    expect(linux.length).toBeGreaterThan(0);
    expect(darwin).not.toBe(linux);
    expect(darwin).toContain("ai.panthe.desktop");
  });
});

describe("refreshStatusAfterCatchUp", () => {
  test("a degraded catch-up result still refreshes the status ref's sequence and state from the chunks that did commit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "panthea-sim-index-status-"));
    try {
      const storePath = join(dir, "world.sqlite");
      const seeded = loadGreekWorldState();
      const reducers = createWorldProjectionReducers(seeded);
      const store = openStore(storePath, reducers);
      ensureTraceSchema(store.db);

      const statusRef = createServiceStatusRef(seeded);
      expect(statusRef.sequence).toBe(0);

      const startCursor = readClock(store.db).cursorWallMs;
      const nowWallMs = startCursor + 5 * 60 * 1000; // several chunks worth

      let chunkAttempt = 0;
      const flakyCommitTick: TickDeps["commitTick"] = (
        storeArg,
        reducersArg,
        input,
      ) => {
        chunkAttempt += 1;
        if (chunkAttempt === 2) {
          throw new Error("simulated store write failure");
        }
        return persistCommitTick(storeArg, reducersArg, input);
      };

      const result = await runCatchUp(
        seeded,
        createPrng(1),
        { store, reducers, traceDb: store.db, commitTick: flakyCommitTick },
        { nowWallMs },
      );
      expect(result.degraded).toBeDefined();
      expect(result.state.lastSequence).toBeGreaterThan(0);

      refreshStatusAfterCatchUp(statusRef, result, store);

      expect(statusRef.status).toBe("degraded");
      expect(statusRef.degradedReason).toBe(result.degraded?.reason);
      // The bug: these must reflect the chunks that DID commit, not the
      // pre-catch-up seed state -- a stale /frame would still show
      // sequence 0 here.
      expect(statusRef.sequence).toBe(result.state.lastSequence);
      expect(statusRef.encodedState).toEqual(
        worldProjectionCodec.encode(result.state),
      );

      closeStore(store);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a degraded catch-up result publishes what it committed, discard included", () => {
    const dir = mkdtempSync(
      join(tmpdir(), "panthea-sim-index-degraded-summary-"),
    );
    try {
      const seeded = loadGreekWorldState();
      const reducers = createWorldProjectionReducers(seeded);
      const store = openStore(join(dir, "world.sqlite"), reducers);
      const statusRef = createServiceStatusRef(seeded);

      refreshStatusAfterCatchUp(
        statusRef,
        {
          summary: {
            appliedMs: 120_000,
            skippedMs: 4 * 60 * 60 * 1000,
            majorOutcomes: [],
          },
          state: seeded,
          prng: createPrng(1),
          degraded: { reason: "store-error", message: "disk hiccup" },
        },
        store,
      );

      expect(statusRef.status).toBe("degraded");
      expect(statusRef.catchUpSummary).toMatchObject({
        appliedMs: 120_000,
        skippedMs: 4 * 60 * 60 * 1000,
      });
      closeStore(store);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a degraded catch-up result that committed nothing publishes no summary", () => {
    const dir = mkdtempSync(
      join(tmpdir(), "panthea-sim-index-degraded-empty-"),
    );
    try {
      const seeded = loadGreekWorldState();
      const reducers = createWorldProjectionReducers(seeded);
      const store = openStore(join(dir, "world.sqlite"), reducers);
      const statusRef = createServiceStatusRef(seeded);

      refreshStatusAfterCatchUp(
        statusRef,
        {
          summary: { appliedMs: 0, skippedMs: 0, majorOutcomes: [] },
          state: seeded,
          prng: createPrng(1),
          degraded: { reason: "store-error", message: "disk hiccup" },
        },
        store,
      );

      expect(statusRef.status).toBe("degraded");
      expect(statusRef.catchUpSummary).toBeUndefined();
      closeStore(store);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a catch-up that applied and skipped nothing leaves the earlier summary in place", async () => {
    const dir = mkdtempSync(join(tmpdir(), "panthea-sim-index-empty-summary-"));
    try {
      const seeded = loadGreekWorldState();
      const reducers = createWorldProjectionReducers(seeded);
      const store = openStore(join(dir, "world.sqlite"), reducers);
      const statusRef = createServiceStatusRef(seeded);
      const earlier = {
        appliedMs: 3_600_000,
        skippedMs: 60_000,
        majorOutcomes: ["tavern fire spread"],
      };
      updateServiceStatus(statusRef, seeded, { catchUpSummary: earlier });

      refreshStatusAfterCatchUp(
        statusRef,
        {
          summary: { appliedMs: 0, skippedMs: 0, majorOutcomes: [] },
          state: seeded,
          prng: createPrng(1),
        },
        store,
      );

      expect(statusRef.catchUpSummary).toEqual({
        ...earlier,
        atSequence: seeded.lastSequence,
      });
      closeStore(store);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a catch-up that applied or skipped time replaces the earlier summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "panthea-sim-index-new-summary-"));
    try {
      const seeded = loadGreekWorldState();
      const reducers = createWorldProjectionReducers(seeded);
      const store = openStore(join(dir, "world.sqlite"), reducers);
      const statusRef = createServiceStatusRef(seeded);
      updateServiceStatus(statusRef, seeded, {
        catchUpSummary: { appliedMs: 1000, skippedMs: 0, majorOutcomes: [] },
      });

      refreshStatusAfterCatchUp(
        statusRef,
        {
          summary: { appliedMs: 0, skippedMs: 90_000, majorOutcomes: [] },
          state: seeded,
          prng: createPrng(1),
        },
        store,
      );

      expect(statusRef.catchUpSummary?.skippedMs).toBe(90_000);
      closeStore(store);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

let appDataDir: string;

beforeEach(() => {
  appDataDir = mkdtempSync(join(tmpdir(), "panthea-sim-index-test-"));
});

afterEach(() => {
  rmSync(appDataDir, { recursive: true, force: true });
});

interface SpawnedService {
  readonly proc: ReturnType<typeof Bun.spawn>;
  readonly port: number;
}

/** Spawns the service, writes `token` to stdin, and resolves once the port line is seen. */
async function spawnService(
  token: string,
  extraEnv: Record<string, string> = {},
): Promise<SpawnedService> {
  const proc = Bun.spawn(["bun", "run", INDEX_ENTRY], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PANTHEA_APP_DATA_DIR: appDataDir,
      ...extraEnv,
    },
  });

  const writer = proc.stdin;
  if (typeof writer === "number" || !writer) {
    throw new Error("expected a FileSink stdin (spawned with stdin: 'pipe')");
  }
  writer.write(`${token}\n`);
  await writer.flush();

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const port = await Promise.race([
    (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          throw new Error("service exited before printing PANTHEA_PORT");
        }
        buffer += decoder.decode(value, { stream: true });
        const match = /PANTHEA_PORT=(\d+)/.exec(buffer);
        if (match?.[1]) {
          return Number.parseInt(match[1], 10);
        }
      }
    })(),
    new Promise<number>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for PANTHEA_PORT")),
        STARTUP_TIMEOUT_MS,
      ),
    ),
  ]);
  reader.releaseLock();

  return { proc, port };
}

describe("service (bun run src/index.ts)", () => {
  test("error path: a request without the launch token is rejected", async () => {
    const { proc, port } = await spawnService("test-token-1");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      expect(response.status).toBe(401);

      const authorized = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: "Bearer test-token-1" },
      });
      expect(authorized.status).toBe(200);
    } finally {
      proc.kill();
    }
  });

  test("stdin EOF triggers a graceful exit", async () => {
    const { proc, port } = await spawnService("test-token-2");
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: "Bearer test-token-2" },
    });
    expect(response.status).toBe(200);

    const stdin = proc.stdin;
    if (typeof stdin === "number" || !stdin) {
      throw new Error("expected a FileSink stdin (spawned with stdin: 'pipe')");
    }
    stdin.end();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });

  test("a five hour gap whose first chunk never committed after the discard: the restarted service's /frame reports the whole backlog, discard included", async () => {
    const HOUR_MS = 60 * 60 * 1000;
    const seeded = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(seeded);
    const storePath = join(appDataDir, "active", "world.sqlite");
    const store = openStore(storePath, reducers);
    ensureTraceSchema(store.db);
    store.db.run("UPDATE clock SET cursor_wall_ms = ? WHERE id = 1", [
      Date.now() - 5 * HOUR_MS,
    ]);
    let attempt = 0;
    const interrupted = await runCatchUp(
      seeded,
      createPrng(1),
      {
        store,
        reducers,
        traceDb: store.db,
        commitTick: (storeArg, reducersArg, input) => {
          attempt += 1;
          if (attempt === 2) throw new Error("simulated commit failure");
          return persistCommitTick(storeArg, reducersArg, input);
        },
      },
      { nowWallMs: Date.now() },
    );
    expect(interrupted.degraded).toBeDefined();
    expect(readClock(store.db).tick).toBe(0);
    closeStore(store);

    const { proc, port } = await spawnService("test-token-frame");
    try {
      const summary = await (async () => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const response = await fetch(`http://127.0.0.1:${port}/frame`, {
            headers: { Authorization: "Bearer test-token-frame" },
          });
          const frame = (await response.json()) as {
            catchUpSummary?: { appliedMs: number; skippedMs: number };
          };
          if (frame.catchUpSummary) return frame.catchUpSummary;
          await Bun.sleep(50);
        }
        throw new Error("no catch-up summary appeared in /frame");
      })();

      // The cap is applied once; everything else in the five hours, and the
      // seconds the restart took, was discarded.
      expect(summary.appliedMs).toBe(HOUR_MS);
      expect(summary.skippedMs).toBeGreaterThanOrEqual(4 * HOUR_MS);
      expect(summary.skippedMs).toBeLessThan(4 * HOUR_MS + 60_000);
    } finally {
      proc.kill();
    }
  }, 60_000);

  test("error path: stdin EOF before any token line refuses to start (non-zero exit, never serves)", async () => {
    const proc = Bun.spawn(["bun", "run", INDEX_ENTRY], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PANTHEA_APP_DATA_DIR: appDataDir },
    });

    const stdin = proc.stdin;
    if (typeof stdin === "number" || !stdin) {
      throw new Error("expected a FileSink stdin (spawned with stdin: 'pipe')");
    }
    stdin.end();

    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    const stdout = await new Response(proc.stdout).text();
    expect(stdout).not.toContain("PANTHEA_PORT=");
  });

  test("a duplicate launch against the same app data dir is refused", async () => {
    const first = await spawnService("test-token-3");
    try {
      const second = Bun.spawn(["bun", "run", INDEX_ENTRY], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PANTHEA_APP_DATA_DIR: appDataDir },
      });
      const secondStdin = second.stdin;
      if (typeof secondStdin === "number" || !secondStdin) {
        throw new Error("expected a FileSink stdin");
      }
      secondStdin.write("test-token-4\n");
      await secondStdin.flush();
      const exitCode = await second.exited;
      expect(exitCode).toBe(3);
    } finally {
      first.proc.kill();
    }
  });
});

describe("refreshStatusAfterCatchUp: nothing happened", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "panthea-sim-index-nothing-"));
    const seeded = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(seeded);
    const store = openStore(join(dir, "world.sqlite"), reducers);
    ensureTraceSchema(store.db);
    return {
      seeded,
      reducers,
      store,
      dispose() {
        closeStore(store);
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  test("a fresh world's startup catch-up, run milliseconds after the store was created, leaves the frame with no catch-up summary", async () => {
    const world = setup();
    try {
      const statusRef = createServiceStatusRef(world.seeded);
      const result = await runCatchUp(
        world.seeded,
        createPrng(1),
        {
          store: world.store,
          reducers: world.reducers,
          traceDb: world.store.db,
        },
        { nowWallMs: readClock(world.store.db).cursorWallMs + 5 },
      );

      refreshStatusAfterCatchUp(statusRef, result, world.store);

      expect(statusRef.catchUpSummary).toBeUndefined();
    } finally {
      world.dispose();
    }
  });

  test("a catch-up that applied less than one tick and has no outcomes leaves the earlier summary in place", () => {
    const world = setup();
    try {
      const statusRef = createServiceStatusRef(world.seeded);
      const earlier = {
        appliedMs: 3_600_000,
        skippedMs: 60_000,
        majorOutcomes: ["tavern fire spread"],
      };
      updateServiceStatus(statusRef, world.seeded, {
        catchUpSummary: earlier,
      });

      refreshStatusAfterCatchUp(
        statusRef,
        {
          summary: { appliedMs: 400, skippedMs: 0, majorOutcomes: [] },
          state: world.seeded,
          prng: createPrng(1),
        },
        world.store,
      );

      expect(statusRef.catchUpSummary?.appliedMs).toBe(3_600_000);
    } finally {
      world.dispose();
    }
  });

  test("a catch-up that applied less than one tick but found an outcome still reports it", () => {
    const world = setup();
    try {
      const statusRef = createServiceStatusRef(world.seeded);
      refreshStatusAfterCatchUp(
        statusRef,
        {
          summary: {
            appliedMs: 0,
            skippedMs: 0,
            majorOutcomes: ["building-ignited:the-tavern"],
          },
          state: world.seeded,
          prng: createPrng(1),
        },
        world.store,
      );
      expect(statusRef.catchUpSummary?.majorOutcomes).toEqual([
        "building-ignited:the-tavern",
      ]);
    } finally {
      world.dispose();
    }
  });
});
