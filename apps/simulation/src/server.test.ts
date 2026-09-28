import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createObservationId,
  createSessionId,
  type EventId,
} from "@panthea/contracts";
import { closeStore, openStore, readClock } from "@panthea/persistence";
import {
  ensureTraceSchema,
  getProposalOutcomeByProposalId,
  listReceiptsByEvent,
} from "@panthea/telemetry";
import { createPrng } from "@panthea/world";
import { runCatchUp } from "./catchup";
import {
  applyLiveTick,
  type CatchUpControl,
  createExternalQueue,
  createServiceStatusRef,
  createSimulationServer,
} from "./server";
import { applyOneTick, buildRoutineQueue, type TickDeps } from "./tick";
import {
  createWorldProjectionReducers,
  loadGreekWorldState,
} from "./world-store";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

interface Harness {
  readonly baseUrl: string;
  readonly token: string;
  readonly committedEventId: EventId;
  readonly db: import("bun:sqlite").Database;
  stop(): void;
}

function startHarness(
  options: { readonly commitTick?: TickDeps["commitTick"] } = {},
): Harness {
  const storeDir = tempDir("panthea-sim-server-");
  const slotsDir = tempDir("panthea-sim-server-slots-");
  const storePath = join(storeDir, "world.sqlite");
  const seeded = loadGreekWorldState();
  const reducers = createWorldProjectionReducers(seeded);
  const store = openStore(storePath, reducers);
  ensureTraceSchema(store.db);

  // One real committed tick (through the same tick.ts path a live service
  // uses) so a trace observation/outcome exists to exercise /trace and
  // /receipts against.
  const queue = buildRoutineQueue(seeded);
  if (queue.length === 0) {
    throw new Error(
      "expected at least one routine-driven proposal to seed a committed event",
    );
  }
  const step = applyOneTick(
    seeded,
    createPrng(1),
    queue,
    { store, reducers, traceDb: store.db },
    { cursorWallMs: 1_000, paused: false },
  );
  if (step.kind !== "committed")
    throw new Error("expected a committed seed tick");
  let committedEventId: EventId | undefined;
  for (const queued of queue) {
    const outcome = getProposalOutcomeByProposalId(store.db, queued.id);
    if (outcome?.outcome === "committed" && outcome.eventId) {
      committedEventId = outcome.eventId;
      break;
    }
  }
  if (!committedEventId)
    throw new Error("expected at least one seed proposal to commit an event");

  const token = "the-launch-token";
  const statusRef = createServiceStatusRef(step.state);
  const externalQueue = createExternalQueue();

  const handle = createSimulationServer({
    token,
    store,
    reducers,
    traceDb: store.db,
    slotsDir,
    statusRef,
    externalQueue,
    port: 0,
    ...(options.commitTick ? { commitTick: options.commitTick } : {}),
  });

  return {
    baseUrl: `http://127.0.0.1:${handle.port}`,
    token,
    committedEventId,
    db: store.db,
    stop() {
      handle.stop(true);
      closeStore(store);
      rmSync(storeDir, { recursive: true, force: true });
      rmSync(slotsDir, { recursive: true, force: true });
    },
  };
}

describe("request guards", () => {
  test("a missing or wrong token gets 401, and the token never appears in server output", async () => {
    const harness = startHarness();
    const logs: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    console.warn = console.log;
    console.error = console.log;
    try {
      const missing = await fetch(`${harness.baseUrl}/health`);
      expect(missing.status).toBe(401);

      const wrong = await fetch(`${harness.baseUrl}/health`, {
        headers: { Authorization: "Bearer not-the-token" },
      });
      expect(wrong.status).toBe(401);

      const right = await fetch(`${harness.baseUrl}/health`, {
        headers: { Authorization: `Bearer ${harness.token}` },
      });
      expect(right.status).toBe(200);

      for (const line of logs) {
        expect(line).not.toContain(harness.token);
      }
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
      harness.stop();
    }
  });

  test("a request carrying an Origin header is rejected even with a valid token", async () => {
    const harness = startHarness();
    try {
      const response = await fetch(`${harness.baseUrl}/health`, {
        headers: {
          Authorization: `Bearer ${harness.token}`,
          Origin: "http://evil.example",
        },
      });
      expect(response.status).toBe(401);
    } finally {
      harness.stop();
    }
  });

  test("a request carrying a Sec-Fetch-* header is rejected even with a valid token", async () => {
    const harness = startHarness();
    try {
      const response = await fetch(`${harness.baseUrl}/health`, {
        headers: {
          Authorization: `Bearer ${harness.token}`,
          "Sec-Fetch-Mode": "cors",
        },
      });
      expect(response.status).toBe(401);
    } finally {
      harness.stop();
    }
  });

  test("a request with a foreign Host header is rejected even with a valid token", async () => {
    const harness = startHarness();
    try {
      const response = await fetch(`${harness.baseUrl}/health`, {
        headers: {
          Authorization: `Bearer ${harness.token}`,
          Host: "evil.example:9999",
        },
      });
      expect(response.status).toBe(401);
    } finally {
      harness.stop();
    }
  });

  test("a previous session's (no-longer-valid) token is rejected the same as any wrong token", async () => {
    const harness = startHarness();
    try {
      const response = await fetch(`${harness.baseUrl}/health`, {
        headers: { Authorization: "Bearer a-token-from-an-earlier-launch" },
      });
      expect(response.status).toBe(401);
    } finally {
      harness.stop();
    }
  });
});

function authed(harness: Harness, path: string, init: RequestInit = {}) {
  return fetch(`${harness.baseUrl}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${harness.token}`,
    },
  });
}

describe("applyLiveTick", () => {
  test("fixture proposals drained for a tick that fails to commit are put back, not lost -- the next successful tick processes them", () => {
    const storeDir = tempDir("panthea-sim-server-live-tick-requeue-");
    try {
      const storePath = join(storeDir, "world.sqlite");
      const seeded = loadGreekWorldState();
      const reducers = createWorldProjectionReducers(seeded);
      const store = openStore(storePath, reducers);
      ensureTraceSchema(store.db);

      const externalQueue = createExternalQueue();
      const [fixtureProposal] = buildRoutineQueue(seeded);
      if (!fixtureProposal) {
        throw new Error(
          "expected at least one routine-driven fixture proposal",
        );
      }
      externalQueue.enqueue(fixtureProposal);

      const failingDeps: TickDeps = {
        store,
        reducers,
        traceDb: store.db,
        commitTick: () => {
          throw new Error("disk I/O error: SQLITE_FULL");
        },
      };

      const failedStep = applyLiveTick(
        externalQueue,
        [],
        seeded,
        createPrng(1),
        failingDeps,
        { cursorWallMs: 1_000, paused: false },
      );
      expect(failedStep.kind).toBe("store-error");

      // Lost if requeue-on-failure is missing: drain() already removed it
      // from the queue before the commit was even attempted.
      const workingDeps: TickDeps = { store, reducers, traceDb: store.db };
      const successStep = applyLiveTick(
        externalQueue,
        [],
        seeded,
        createPrng(1),
        workingDeps,
        { cursorWallMs: 2_000, paused: false },
      );
      if (successStep.kind !== "committed") {
        throw new Error(`expected a committed step, got ${successStep.kind}`);
      }
      expect(successStep.events).toBeGreaterThan(0);
      const outcome = getProposalOutcomeByProposalId(
        store.db,
        fixtureProposal.id,
      );
      expect(outcome?.outcome).toBe("committed");

      closeStore(store);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });
});

test("GET /frame returns a running-status SyncFrame carrying the world's committed state", async () => {
  const harness = startHarness();
  try {
    const response = await authed(harness, "/frame");
    expect(response.status).toBe(200);
    const frame = (await response.json()) as {
      status: string;
      sequence: number;
    };
    expect(frame.status).toBe("running");
    expect(frame.sequence).toBeGreaterThan(0);
  } finally {
    harness.stop();
  }
});

test("a reconnecting WebSocket subscriber gets a fresh frame immediately on open", async () => {
  const harness = startHarness();
  try {
    const wsUrl = `${harness.baseUrl.replace("http://", "ws://")}/stream`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ws = new WebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${harness.token}` },
      } as never);
      const frame = await new Promise<{ status: string }>((resolve, reject) => {
        ws.onmessage = (event) => resolve(JSON.parse(event.data as string));
        ws.onerror = (event) => reject(event);
        setTimeout(
          () => reject(new Error("timed out waiting for a frame")),
          5_000,
        );
      });
      expect(frame.status).toBe("running");
      ws.close();
    }
  } finally {
    harness.stop();
  }
});

test("one sessionId per sidecar launch: every broadcast, /frame response, and WS connection carries the same id until restart", async () => {
  const harness = startHarness();
  try {
    const first = (await (await authed(harness, "/frame")).json()) as {
      sessionId: string;
    };
    const second = (await (await authed(harness, "/frame")).json()) as {
      sessionId: string;
    };
    expect(second.sessionId).toBe(first.sessionId);

    const wsUrl = `${harness.baseUrl.replace("http://", "ws://")}/stream`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ws = new WebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${harness.token}` },
      } as never);
      const frame = await new Promise<{ sessionId: string }>(
        (resolve, reject) => {
          ws.onmessage = (event) => resolve(JSON.parse(event.data as string));
          ws.onerror = (event) => reject(event);
          setTimeout(
            () => reject(new Error("timed out waiting for a frame")),
            5_000,
          );
        },
      );
      expect(frame.sessionId).toBe(first.sessionId);
      ws.close();
    }
  } finally {
    harness.stop();
  }
});

test("a restarted server (a fresh createSimulationServer call) mints a new sessionId", async () => {
  const harnessA = startHarness();
  const harnessB = startHarness();
  try {
    const frameA = (await (await authed(harnessA, "/frame")).json()) as {
      sessionId: string;
    };
    const frameB = (await (await authed(harnessB, "/frame")).json()) as {
      sessionId: string;
    };
    expect(frameB.sessionId).not.toBe(frameA.sessionId);
  } finally {
    harnessA.stop();
    harnessB.stop();
  }
});

test("POST /receipts: idempotent per (event, session), duplicates are not persisted, unknown events are rejected, and a flood is capped", async () => {
  const harness = startHarness();
  try {
    const sessionId = createSessionId();

    const unknown = await authed(harness, "/receipts", {
      method: "POST",
      body: JSON.stringify({
        eventId: "evt-never-committed",
        sessionId,
      }),
    });
    expect(unknown.status).toBe(404);

    const first = await authed(harness, "/receipts", {
      method: "POST",
      body: JSON.stringify({ eventId: harness.committedEventId, sessionId }),
    });
    expect(first.status).toBe(200);

    const duplicate = await authed(harness, "/receipts", {
      method: "POST",
      body: JSON.stringify({ eventId: harness.committedEventId, sessionId }),
    });
    expect(duplicate.status).toBe(200);

    const rows = listReceiptsByEvent(harness.db, harness.committedEventId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBe(sessionId);

    let sawRateLimited = false;
    for (let i = 0; i < 60; i += 1) {
      const response = await authed(harness, "/receipts", {
        method: "POST",
        body: JSON.stringify({
          eventId: harness.committedEventId,
          sessionId: createSessionId(),
        }),
      });
      if (response.status === 429) {
        sawRateLimited = true;
        break;
      }
    }
    expect(sawRateLimited).toBe(true);
  } finally {
    harness.stop();
  }
});

test("POST /pause then POST /resume persist the clock's paused flag and record operator events, not character actions", async () => {
  const harness = startHarness();
  try {
    const pause = await authed(harness, "/pause", { method: "POST" });
    expect(pause.status).toBe(200);
    const resume = await authed(harness, "/resume", { method: "POST" });
    expect(resume.status).toBe(200);
  } finally {
    harness.stop();
  }
});

test("a store failure during POST /pause returns 500, sets degraded status with a reason, and leaves the persisted paused flag unchanged", async () => {
  const harness = startHarness({
    commitTick: () => {
      throw new Error("disk I/O error: SQLITE_FULL");
    },
  });
  try {
    const before = readClock(harness.db);
    expect(before.paused).toBe(false);

    const pause = await authed(harness, "/pause", { method: "POST" });
    expect(pause.status).toBe(500);

    expect(readClock(harness.db).paused).toBe(false);

    const frame = (await (await authed(harness, "/frame")).json()) as {
      status: string;
      degradedReason: string;
    };
    expect(frame.status).toBe("degraded");
    expect(frame.degradedReason).toBe("disk-full");
  } finally {
    harness.stop();
  }
});

test("a store failure during POST /resume returns 500, sets degraded status with a reason, and leaves the persisted paused flag unchanged", async () => {
  const harness = startHarness();
  try {
    const pause = await authed(harness, "/pause", { method: "POST" });
    expect(pause.status).toBe(200);
    expect(readClock(harness.db).paused).toBe(true);
  } finally {
    harness.stop();
  }

  const failingHarness = startHarness({
    commitTick: () => {
      throw new Error("disk I/O error: SQLITE_FULL");
    },
  });
  try {
    // Seed a paused clock directly (bypassing the failing commitTick),
    // mirroring an operator having paused before the store started
    // failing.
    failingHarness.db.run("UPDATE clock SET paused = 1 WHERE id = 1");

    const resume = await authed(failingHarness, "/resume", { method: "POST" });
    expect(resume.status).toBe(500);

    expect(readClock(failingHarness.db).paused).toBe(true);

    const frame = (await (await authed(failingHarness, "/frame")).json()) as {
      status: string;
      degradedReason: string;
    };
    expect(frame.status).toBe("degraded");
    expect(frame.degradedReason).toBe("disk-full");
  } finally {
    failingHarness.stop();
  }
});

test("a real POST /pause request during an in-progress catch-up stops it at a chunk boundary, persists paused, and reports skipped time -- without the server blocking on catch-up", async () => {
  const storeDir = tempDir("panthea-sim-server-pause-catchup-");
  const slotsDir = tempDir("panthea-sim-server-pause-catchup-slots-");
  try {
    const storePath = join(storeDir, "world.sqlite");
    const seeded = loadGreekWorldState();
    // Tiny chunks so the run spans many real chunk commits and yields --
    // enough real wall-clock time for a concurrent HTTP request to land
    // mid-run.
    const seededWithTinyChunks = {
      ...seeded,
      rules: { ...seeded.rules, catchUpChunkMs: 1_000 },
    };
    const reducers = createWorldProjectionReducers(seededWithTinyChunks);
    const store = openStore(storePath, reducers);
    ensureTraceSchema(store.db);

    const startCursor = readClock(store.db).cursorWallMs;
    const totalMs = 20 * 60 * 1000; // 20 chunks of 1 minute each
    const nowWallMs = startCursor + totalMs;

    const token = "the-launch-token";
    const statusRef = createServiceStatusRef(seededWithTinyChunks);
    const externalQueue = createExternalQueue();

    let catchUpInProgress = true;
    let pauseRequestedDuringCatchUp = false;
    let chunksCommitted = 0;
    const catchUpControl: CatchUpControl = {
      isRunning: () => catchUpInProgress,
      requestPause: () => {
        pauseRequestedDuringCatchUp = true;
      },
    };

    const handle = createSimulationServer({
      token,
      store,
      reducers,
      traceDb: store.db,
      slotsDir,
      statusRef,
      externalQueue,
      catchUpControl,
      port: 0,
    });

    try {
      const catchUpPromise = runCatchUp(
        seededWithTinyChunks,
        createPrng(1),
        { store, reducers, traceDb: store.db },
        {
          nowWallMs,
          onChunkCommitted: () => {
            chunksCommitted += 1;
            return pauseRequestedDuringCatchUp;
          },
        },
      ).finally(() => {
        catchUpInProgress = false;
      });

      // Wait for a few real chunks to commit before pausing, so the
      // request genuinely lands mid-run rather than before it starts or
      // after it finishes.
      const deadline = Date.now() + 10_000;
      while (chunksCommitted < 3 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(chunksCommitted).toBeGreaterThanOrEqual(3);

      const pauseResponse = await fetch(
        `http://127.0.0.1:${handle.port}/pause`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(pauseResponse.status).toBe(200);

      const result = await catchUpPromise;

      expect(result.degraded).toBeUndefined();
      expect(result.summary.skippedMs).toBeGreaterThan(0);
      expect(result.summary.appliedMs).toBeLessThan(totalMs);

      const clock = readClock(store.db);
      expect(clock.paused).toBe(true);
    } finally {
      handle.stop(true);
      closeStore(store);
    }
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(slotsDir, { recursive: true, force: true });
  }
}, 20_000);

test("a trace failure during POST /pause rolls back the whole transition: 500, degraded status, and the persisted paused flag is unchanged", async () => {
  const storeDir = tempDir("panthea-sim-server-pause-trace-fail-");
  const slotsDir = tempDir("panthea-sim-server-pause-trace-fail-slots-");
  try {
    const storePath = join(storeDir, "world.sqlite");
    const seeded = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(seeded);
    const store = openStore(storePath, reducers);
    // Deliberately not calling ensureTraceSchema: the pause transition's
    // own operator-observation trace write genuinely fails.

    const token = "the-launch-token";
    const statusRef = createServiceStatusRef(seeded);
    const externalQueue = createExternalQueue();

    const handle = createSimulationServer({
      token,
      store,
      reducers,
      traceDb: store.db,
      slotsDir,
      statusRef,
      externalQueue,
      port: 0,
    });

    try {
      const before = readClock(store.db);
      expect(before.paused).toBe(false);

      const response = await fetch(`http://127.0.0.1:${handle.port}/pause`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(500);

      // The clock transition must roll back with the trace write --
      // never left half-applied.
      expect(readClock(store.db).paused).toBe(false);

      const frameResponse = await fetch(
        `http://127.0.0.1:${handle.port}/frame`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const frame = (await frameResponse.json()) as {
        status: string;
        degradedReason?: string;
      };
      expect(frame.status).toBe("degraded");
    } finally {
      handle.stop(true);
      closeStore(store);
    }
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(slotsDir, { recursive: true, force: true });
  }
});

test("a trace failure during POST /resume rolls back the whole transition: 500, degraded status, and the persisted paused flag is unchanged", async () => {
  const storeDir = tempDir("panthea-sim-server-resume-trace-fail-");
  const slotsDir = tempDir("panthea-sim-server-resume-trace-fail-slots-");
  try {
    const storePath = join(storeDir, "world.sqlite");
    const seeded = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(seeded);
    const store = openStore(storePath, reducers);
    ensureTraceSchema(store.db);
    // Pause first (this commit and its trace write both succeed), then
    // drop the trace schema so resume's own trace write fails.
    store.db.run("UPDATE clock SET paused = 1 WHERE id = 1");
    store.db.run("DROP TABLE trace_observations");

    const token = "the-launch-token";
    const statusRef = createServiceStatusRef(seeded);
    const externalQueue = createExternalQueue();

    const handle = createSimulationServer({
      token,
      store,
      reducers,
      traceDb: store.db,
      slotsDir,
      statusRef,
      externalQueue,
      port: 0,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${handle.port}/resume`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(500);

      expect(readClock(store.db).paused).toBe(true);

      const frameResponse = await fetch(
        `http://127.0.0.1:${handle.port}/frame`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const frame = (await frameResponse.json()) as {
        status: string;
        degradedReason?: string;
      };
      expect(frame.status).toBe("degraded");
    } finally {
      handle.stop(true);
      closeStore(store);
    }
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(slotsDir, { recursive: true, force: true });
  }
});

test("POST /proposals with an unknown legend link is rejected at intake, never reaching the queue", async () => {
  const harness = startHarness();
  try {
    const observation = {
      schemaVersion: 1,
      id: createObservationId(),
      observer: "farmer",
      stateRevision: 0,
      factsRead: [],
      source: "fixture",
    };
    const response = await authed(harness, "/proposals", {
      method: "POST",
      body: JSON.stringify({
        observation,
        proposal: {
          schemaVersion: 1,
          actor: "farmer",
          targets: [],
          expectedRevisions: [],
          source: "fixture",
          observationId: observation.id,
          kind: "legend",
          assertion: "a tale never linked to anything real",
          linkedEventId: "evt-nonexistent",
        },
      }),
    });
    expect(response.status).toBe(400);
  } finally {
    harness.stop();
  }
});

test("GET /trace/event follows a committed event back to its observation", async () => {
  const harness = startHarness();
  try {
    const response = await authed(
      harness,
      `/trace/event?id=${harness.committedEventId}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { found: boolean; steps: readonly { step: string }[] };
    };
    expect(body.result.found).toBe(true);
    expect(body.result.steps.map((step) => step.step)).toContain("event");
  } finally {
    harness.stop();
  }
});

test("POST /import surfaces a staging failure as an error response rather than throwing, and creates no slot", async () => {
  const harness = startHarness();
  const exportDir = tempDir("panthea-sim-server-export-");
  try {
    const exportPath = join(exportDir, "archive.sqlite");
    const exportResponse = await authed(harness, "/export", {
      method: "POST",
      body: JSON.stringify({ path: exportPath }),
    });
    expect(exportResponse.status).toBe(200);

    const response = await authed(harness, "/import", {
      method: "POST",
      body: JSON.stringify({ archivePath: "/nonexistent/archive.sqlite" }),
    });
    expect(response.status).toBe(422);
  } finally {
    harness.stop();
    rmSync(exportDir, { recursive: true, force: true });
  }
});
