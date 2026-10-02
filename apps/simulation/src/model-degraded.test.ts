// `model-degraded`: the status a total model outage shows. Unlike a store
// failure it never halts the world -- routines keep committing -- and any
// halting failure outranks it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSyncFrame, type SyncFrame } from "@panthea/contracts";
import { closeStore, openStore, readClock } from "@panthea/persistence";
import {
  ensureTraceSchema,
  getModelRequest,
  type ModelRouteResult,
  recordModelRequest,
} from "@panthea/telemetry";
import { createPrng } from "@panthea/world";
import {
  applyLiveTick,
  createServiceStatusRef,
  createSimulationServer,
  isHalted,
  reportModelOutcome,
  type ServiceStatusRef,
  type SimulationServerHandle,
  updateServiceStatus,
} from "./server";
import { buildRoutineQueue, type TickDeps } from "./tick";
import {
  createWorldProjectionReducers,
  loadGreekWorldState,
} from "./world-store";

const TOKEN = "model-degraded-token";

let dir: string;
let store: ReturnType<typeof openStore>;
let deps: TickDeps;
let state: ReturnType<typeof loadGreekWorldState>;
let prng: ReturnType<typeof createPrng>;
let statusRef: ServiceStatusRef;
let server: SimulationServerHandle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "panthea-sim-model-degraded-"));
  state = loadGreekWorldState();
  prng = createPrng(1);
  const reducers = createWorldProjectionReducers(state);
  store = openStore(join(dir, "world.sqlite"), reducers);
  ensureTraceSchema(store.db);
  deps = { store, reducers, traceDb: store.db };
  statusRef = createServiceStatusRef(state);
  server = createSimulationServer({
    token: TOKEN,
    store,
    reducers,
    traceDb: store.db,
    slotsDir: join(dir, "slots"),
    statusRef,
    port: 0,
  });
});

afterEach(() => {
  server.stop(true);
  closeStore(store);
  rmSync(dir, { recursive: true, force: true });
});

const exhausted: ModelRouteResult = {
  kind: "exhausted",
  steps: [
    {
      endpoint: "ollama",
      model: "llama3.2-3b-4k",
      attempts: 2,
      elapsedMs: 40,
      reason: "network",
    },
  ],
  elapsedMs: 45,
};

/** GET /frame, parsed through the contract the client and shell use. */
async function frame(): Promise<SyncFrame> {
  const response = await fetch(`http://127.0.0.1:${server.port}/frame`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const parsed = parseSyncFrame(await response.json());
  if (!parsed.ok) throw new Error(`${parsed.path}: ${parsed.message}`);
  return parsed.value;
}

/** One live tick the way the service's loop runs it: skipped when halted, otherwise applied and the status refreshed. */
function liveTick(): "ticked" | "halted" {
  if (isHalted(statusRef)) return "halted";
  const step = applyLiveTick(buildRoutineQueue(state), state, prng, deps, {
    cursorWallMs: readClock(store.db).cursorWallMs + 1_000,
    paused: false,
  });
  if (step.kind !== "committed") {
    statusRef.status = "degraded";
    statusRef.degradedReason = step.reason;
    return "halted";
  }
  state = step.state;
  prng = step.prng;
  updateServiceStatus(statusRef, state);
  return "ticked";
}

describe("endpoint status on the frame", () => {
  test("a ref with no status (no models configured) serves a frame without the field", async () => {
    expect((await frame()).modelEndpoints).toBeUndefined();
  });

  test("a model outcome updates each endpoint's status, and the frame carries it through the contract", async () => {
    statusRef.modelEndpoints = [
      { endpoint: "ollama", state: "untried" },
      { endpoint: "go", state: "untried" },
    ];
    reportModelOutcome(statusRef, {
      kind: "exhausted",
      steps: [
        {
          endpoint: "ollama",
          model: "m",
          attempts: 2,
          elapsedMs: 40,
          reason: "network",
          detail: "connection refused",
        },
      ],
      elapsedMs: 45,
    });

    const failed = await frame();
    expect(failed.degradedReason).toBe("model-degraded");
    expect(failed.modelEndpoints).toEqual([
      {
        endpoint: "ollama",
        state: "failed",
        reason: "network",
        detail: "connection refused",
      },
      { endpoint: "go", state: "untried" },
    ]);

    reportModelOutcome(statusRef, {
      kind: "intent",
      step: {
        endpoint: "ollama",
        model: "m",
        attempts: 1,
        elapsedMs: 5,
        mode: "native",
      },
      failed: [],
      elapsedMs: 5,
    });
    const recovered = await frame();
    expect(recovered.status).toBe("running");
    expect(recovered.modelEndpoints?.[0]).toEqual({
      endpoint: "ollama",
      state: "ok",
    });
  });
});

describe("reporting a model outcome", () => {
  test("an exhausted chain makes the frame degraded with the model-degraded reason, and it parses through the contract", async () => {
    reportModelOutcome(statusRef, { kind: "exhausted" });

    expect(await frame()).toMatchObject({
      status: "degraded",
      degradedReason: "model-degraded",
    });
  });

  test("the next intent clears it", async () => {
    reportModelOutcome(statusRef, { kind: "exhausted" });

    reportModelOutcome(statusRef, { kind: "intent" });

    const cleared = await frame();
    expect(cleared.status).toBe("running");
    expect(cleared.degradedReason).toBeUndefined();
  });

  test("an intent when nothing is degraded changes nothing", async () => {
    reportModelOutcome(statusRef, { kind: "intent" });

    expect((await frame()).status).toBe("running");
  });

  test("an exhausted chain is recorded with no proposal, and reporting it sets model-degraded", async () => {
    const id = recordModelRequest(store.db, {
      role: "zeus",
      route: exhausted,
      prompt: "What does Zeus do?",
    });
    reportModelOutcome(statusRef, exhausted);

    expect(getModelRequest(store.db, id)).toMatchObject({
      outcome: "exhausted",
      proposalId: undefined,
    });
    expect((await frame()).degradedReason).toBe("model-degraded");
  });
});

describe("an outage never stops the world", () => {
  test("routine ticks keep committing over several ticks while the frame shows model-degraded, and recovery clears it", async () => {
    reportModelOutcome(statusRef, { kind: "exhausted" });
    const startTick = readClock(store.db).tick;
    const startSequence = (await frame()).sequence;

    const results: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      results.push(liveTick());
      expect(await frame()).toMatchObject({
        status: "degraded",
        degradedReason: "model-degraded",
      });
    }

    expect(results).toEqual(Array(5).fill("ticked"));
    expect(readClock(store.db).tick).toBe(startTick + 5);
    expect((await frame()).sequence).toBeGreaterThan(startSequence);

    reportModelOutcome(statusRef, { kind: "intent" });
    expect(await frame()).toMatchObject({ status: "running" });
    expect(liveTick()).toBe("ticked");
  });

  test("the outage is not a halting state", () => {
    reportModelOutcome(statusRef, { kind: "exhausted" });

    expect(isHalted(statusRef)).toBe(false);
  });
});

describe("priority among degraded reasons", () => {
  test.each([["store-error"], ["disk-full"]] as const)(
    "%s outranks model-degraded, halts the world, and model-degraded shows again once it clears if the outage persists",
    async (reason) => {
      reportModelOutcome(statusRef, { kind: "exhausted" });
      statusRef.status = "degraded";
      statusRef.degradedReason = reason;

      expect(await frame()).toMatchObject({
        status: "degraded",
        degradedReason: reason,
      });
      expect(isHalted(statusRef)).toBe(true);
      expect(liveTick()).toBe("halted");

      // The store failure clears (a later successful update resets it).
      updateServiceStatus(statusRef, state);
      expect(isHalted(statusRef)).toBe(false);
      expect(await frame()).toMatchObject({
        status: "degraded",
        degradedReason: "model-degraded",
      });
    },
  );

  test("a store failure that begins during an outage is not hidden by it, and recovery from the outage does not hide the store failure", async () => {
    reportModelOutcome(statusRef, { kind: "exhausted" });
    statusRef.status = "degraded";
    statusRef.degradedReason = "store-error";

    reportModelOutcome(statusRef, { kind: "intent" });

    expect(await frame()).toMatchObject({
      status: "degraded",
      degradedReason: "store-error",
    });
  });

  test("a paused world shows paused: new model dispatch is frozen, so the outage cannot be re-judged", async () => {
    reportModelOutcome(statusRef, { kind: "exhausted" });
    statusRef.status = "paused";

    expect((await frame()).status).toBe("paused");
  });
});
