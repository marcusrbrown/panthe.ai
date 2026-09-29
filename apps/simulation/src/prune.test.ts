import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createProposalId,
  ensureTraceSchema,
  getModelRequestByProposalId,
  MODEL_PAYLOAD_RETENTION_MS,
  type ModelRouteResult,
  recordModelRequest,
} from "@panthea/telemetry";
import { startModelPayloadPruner } from "./prune";

const DAY = 24 * 60 * 60 * 1000;
const route = {
  kind: "intent",
  step: {
    endpoint: "ollama",
    model: "m",
    attempts: 1,
    elapsedMs: 1,
    mode: "native",
  },
  failed: [],
  elapsedMs: 1,
} satisfies ModelRouteResult;

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  ensureTraceSchema(db);
});

afterEach(() => {
  db.close();
});

function recordAt(recordedAt: number) {
  const proposalId = createProposalId();
  recordModelRequest(
    db,
    { proposalId, role: "zeus", route, prompt: "p", output: "o" },
    recordedAt,
  );
  return proposalId;
}

const payloadOf = (proposalId: ReturnType<typeof createProposalId>) =>
  getModelRequestByProposalId(db, proposalId)?.promptPayload;

async function until(condition: () => boolean, ms = 1_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

describe("startModelPayloadPruner", () => {
  test("prunes at start, before it returns, with the seven day retention", () => {
    const now = 100 * DAY;
    const old = recordAt(now - 8 * DAY);
    const recent = recordAt(now - 1 * DAY);

    const pruner = startModelPayloadPruner(db, {
      intervalMs: 60_000,
      now: () => now,
    });
    pruner.stop();

    expect(payloadOf(old)).toBeUndefined();
    expect(payloadOf(recent)).toBe("p");
    expect(MODEL_PAYLOAD_RETENTION_MS).toBe(7 * DAY);
  });

  test("prunes again on every interval, so a row that ages past the retention while the service runs is pruned", async () => {
    let now = 100 * DAY;
    const aging = recordAt(now - 6 * DAY);
    const pruner = startModelPayloadPruner(db, {
      intervalMs: 10,
      now: () => now,
    });
    try {
      expect(payloadOf(aging)).toBe("p");

      now += 2 * DAY;
      await until(() => payloadOf(aging) === undefined);
    } finally {
      pruner.stop();
    }
  });

  test("stop ends the schedule", async () => {
    let now = 100 * DAY;
    const pruner = startModelPayloadPruner(db, {
      intervalMs: 10,
      now: () => now,
    });
    pruner.stop();
    const late = recordAt(now - 8 * DAY);

    now += 1;
    await Bun.sleep(60);

    expect(payloadOf(late)).toBe("p");
  });

  test("a failing prune is reported, never thrown, and the schedule keeps going", async () => {
    const errors: unknown[] = [];
    const broken = new Database(":memory:");
    const pruner = startModelPayloadPruner(broken, {
      intervalMs: 10,
      onError: (error) => errors.push(error),
    });
    try {
      // No trace table on this handle: every prune fails.
      await until(() => errors.length >= 2);
    } finally {
      pruner.stop();
      broken.close();
    }

    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});
