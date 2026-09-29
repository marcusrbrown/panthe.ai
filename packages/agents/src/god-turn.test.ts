// A god's whole turn through the production router and a scripted
// OpenAI-compatible endpoint on loopback: perceive -> context -> route ->
// build the proposal -> the real world validator. No service, no journal.

import { afterEach, expect, test } from "bun:test";
import {
  createPrng,
  type PerceptionSnapshot,
  perceive,
  runTick,
  toEntityId,
} from "@panthea/world";
import { parseRoutingConfig } from "./config";
import { buildGodContext, godIntentSchema } from "./context";
import { buildModelProposal } from "./observation";
import { createRouter } from "./router";
import { actorAt, godProfile, greekState } from "./test-fixtures";

interface Stub {
  readonly baseUrl: string;
  readonly seen: Record<string, unknown>[];
  stop(): void;
}

const stubs: Stub[] = [];

afterEach(() => {
  for (const stub of stubs.splice(0)) stub.stop();
});

function completion(content: string): Response {
  return Response.json({
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "scripted",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

/** Replies with `replies[n]` to the nth request, repeating the last. */
function startStub(...replies: string[]): Stub {
  const seen: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const n = seen.length;
      seen.push((await request.json()) as Record<string, unknown>);
      return completion(replies[Math.min(n, replies.length - 1)] as string);
    },
  });
  const stub: Stub = {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    seen,
    stop: () => server.stop(true),
  };
  stubs.push(stub);
  return stub;
}

function routerFor(stub: Stub) {
  const config = parseRoutingConfig({
    endpoints: [{ id: "ollama", baseUrl: stub.baseUrl, model: "scripted" }],
    roles: { zeus: { endpoint: "ollama" } },
  });
  if (!config.ok) throw new Error(`${config.path}: ${config.message}`);
  return createRouter({
    config: config.value,
    offline: false,
    limits: {
      attemptTimeoutMs: 2_000,
      totalTimeoutMs: 10_000,
      maxAttempts: 2,
      backoffBaseMs: 1,
      backoffMaxMs: 4,
    },
  });
}

const zeus = godProfile("zeus");
const id = toEntityId;

/** Zeus in the tavern; the old oak stands in the square. */
function zeusAtTavern(): {
  state: ReturnType<typeof greekState>;
  snapshot: PerceptionSnapshot;
} {
  const state = actorAt(greekState(), "zeus", "tavern");
  const snapshot = perceive(state, id("zeus"));
  if (!snapshot) throw new Error("zeus perceives nothing");
  return { state, snapshot };
}

const STRIKE_TAVERN = '{"action":"strike","target":"the-tavern","power":2}';
const STRIKE_OAK = '{"action":"strike","target":"old-oak","power":2}';

test("a scripted reply becomes a valid proposal the world commits, and the request carried only what Zeus perceives", async () => {
  const stub = startStub(STRIKE_TAVERN);
  const { state, snapshot } = zeusAtTavern();

  const result = await routerFor(stub).route(
    "zeus",
    buildGodContext(zeus, snapshot),
    godIntentSchema(zeus, snapshot),
  );
  expect(result.kind).toBe("intent");
  if (result.kind !== "intent") return;

  const built = buildModelProposal(
    id("zeus"),
    snapshot,
    result.intent,
    "fixture",
  );
  expect(built.ok).toBe(true);
  if (!built.ok) return;
  expect(built.proposal).toMatchObject({
    kind: "strike",
    target: "the-tavern",
    power: 2,
  });
  expect(built.observation.factsRead).toContain("building:the-tavern.status");

  const tick = runTick(state, createPrng(1), [built.proposal]);
  expect(tick.rejected).toEqual([]);
  expect(tick.committed).toHaveLength(1);

  const request = JSON.stringify(stub.seen[0]);
  expect(request).toContain("The Tavern");
  expect(request).toContain("the-tavern");
  for (const unseen of ["old-oak", "The Old Oak", "woodcutter", "farmer"]) {
    expect(request).not.toContain(unseen);
  }
});

test("a hallucinated target is refused as invalid-output and no proposal is built", async () => {
  const stub = startStub(STRIKE_OAK);
  const { snapshot } = zeusAtTavern();

  const result = await routerFor(stub).route(
    "zeus",
    buildGodContext(zeus, snapshot),
    godIntentSchema(zeus, snapshot),
  );

  expect(result.kind).toBe("exhausted");
  if (result.kind !== "exhausted") return;
  expect(result.steps).toHaveLength(1);
  expect(result.steps[0]).toMatchObject({
    endpoint: "ollama",
    reason: "invalid-output",
    attempts: 2,
  });
  expect(result.steps[0]?.detail).toContain("target");
});

test("a hallucinated target on the first reply is retried, and the corrected reply parses", async () => {
  const stub = startStub(STRIKE_OAK, STRIKE_TAVERN);
  const { snapshot } = zeusAtTavern();

  const result = await routerFor(stub).route(
    "zeus",
    buildGodContext(zeus, snapshot),
    godIntentSchema(zeus, snapshot),
  );

  expect(result.kind).toBe("intent");
  if (result.kind !== "intent") return;
  expect(result.step.attempts).toBe(2);
  expect(result.intent as unknown).toEqual({
    action: "strike",
    target: "the-tavern",
    power: 2,
  });
});
