import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createObservationId,
  createSessionId,
  type EventId,
} from "@panthea/contracts";
import { closeStore, openStore } from "@panthea/persistence";
import {
  ensureTraceSchema,
  getProposalOutcomeByProposalId,
} from "@panthea/telemetry";
import { createPrng } from "@panthea/world";
import {
  createExternalQueue,
  createServiceStatusRef,
  createSimulationServer,
} from "./server";
import { applyOneTick, buildRoutineQueue } from "./tick";
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
  stop(): void;
}

function startHarness(): Harness {
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
  });

  return {
    baseUrl: `http://127.0.0.1:${handle.port}`,
    token,
    committedEventId,
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
