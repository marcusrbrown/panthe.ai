// A god's turn through the production router and a scripted OpenAI-compatible
// endpoint on loopback (the provider boundary): snapshot -> memory -> context
// -> route -> trusted proposal. The world is real: memories come from real
// ticks, and a built proposal is committed by the real validator.

import { afterEach, expect, test } from "bun:test";
import {
  createPrng,
  runTick,
  submitProposal,
  toEntityId,
  type WorldState,
} from "@panthea/world";
import { parseRoutingConfig } from "./config";
import { createRouter } from "./router";
import { actorAt, godProfile, greekState } from "./test-fixtures";
import { runGodTurn } from "./turn";

interface Stub {
  readonly baseUrl: string;
  readonly seen: Record<string, unknown>[];
  stop(): void;
}

const stubs: Stub[] = [];
afterEach(() => {
  for (const stub of stubs.splice(0)) stub.stop();
});

/** Replies with `replies[n]` to the nth request, repeating the last; a reply of `500` answers with a server error. */
function startStub(...replies: (string | 500)[]): Stub {
  const seen: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const n = seen.length;
      seen.push((await request.json()) as Record<string, unknown>);
      const reply = replies[Math.min(n, replies.length - 1)] as string | 500;
      if (reply === 500) return new Response("down", { status: 500 });
      return Response.json({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1,
        model: "scripted",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: reply },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
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
    roles: { zeus: { endpoint: "ollama" }, hera: { endpoint: "ollama" } },
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

const id = toEntityId;
const profiles = new Map([
  [id("zeus"), godProfile("zeus")],
  [id("hera"), godProfile("hera")],
]);

const zeusAtTavern = () => actorAt(greekState(), "zeus", "tavern");

function deps(stub: Stub) {
  return { router: routerFor(stub), profiles };
}

const STRIKE_TAVERN = '{"action":"strike","target":"the-tavern","power":2}';

test("a scripted reply becomes a service-built proposal the world commits, with the request that produced it", async () => {
  const stub = startStub(STRIKE_TAVERN);
  const state = zeusAtTavern();

  const turn = await runGodTurn(deps(stub), { state, actorId: id("zeus") });
  expect(turn?.kind).toBe("proposal");
  if (turn?.kind !== "proposal") return;

  expect(turn.proposal).toMatchObject({
    kind: "strike",
    actor: "zeus",
    target: "the-tavern",
    source: "model",
  });
  expect(turn.observation.source).toBe("model");
  expect(turn.request).toMatchObject({
    role: "zeus",
    route: { kind: "intent", step: { endpoint: "ollama", mode: "native" } },
    output: '{"action":"strike","target":"the-tavern","power":2}',
  });
  // The trace's prompt is what the model was actually shown.
  expect(turn.request.prompt).toContain("The Tavern");
  expect(JSON.stringify(stub.seen[0])).toContain("The Tavern");

  const tick = runTick(state, createPrng(1), [turn.proposal]);
  expect(tick.rejected).toEqual([]);
});

test("a scripted wait is a wait: no proposal, but the request is still reported", async () => {
  const stub = startStub('{"action":"wait"}');
  const turn = await runGodTurn(deps(stub), {
    state: zeusAtTavern(),
    actorId: id("zeus"),
  });
  expect(turn?.kind).toBe("wait");
  if (turn?.kind !== "wait") return;
  expect(turn.request.route.kind).toBe("intent");
});

test("every endpoint failing is exhausted: no proposal, and the steps say why", async () => {
  const stub = startStub(500);
  const turn = await runGodTurn(deps(stub), {
    state: zeusAtTavern(),
    actorId: id("zeus"),
  });
  expect(turn?.kind).toBe("exhausted");
  if (turn?.kind !== "exhausted") return;
  expect(turn.request.route.steps[0]).toMatchObject({ endpoint: "ollama" });
  // Control: the same world with a working endpoint gives a proposal.
  const working = await runGodTurn(deps(startStub(STRIKE_TAVERN)), {
    state: zeusAtTavern(),
    actorId: id("zeus"),
  });
  expect(working?.kind).toBe("proposal");
});

test("a dead or unknown actor has no turn and asks no model; a god with no profile has none either", async () => {
  const stub = startStub(STRIKE_TAVERN);
  const state = zeusAtTavern();
  const zeus = state.actors.get(id("zeus"));
  if (!zeus) throw new Error("no zeus");
  const dead: WorldState = {
    ...state,
    actors: new Map(state.actors).set(id("zeus"), { ...zeus, alive: false }),
  };
  expect(
    await runGodTurn(deps(stub), { state: dead, actorId: id("zeus") }),
  ).toBeUndefined();
  expect(
    await runGodTurn(deps(stub), { state, actorId: id("nobody") }),
  ).toBeUndefined();
  // Ares stands in no profile map.
  expect(
    await runGodTurn(deps(stub), { state, actorId: id("farmer") }),
  ).toBeUndefined();
  expect(stub.seen).toHaveLength(0);

  // Control: the living god with a profile asks once.
  await runGodTurn(deps(stub), { state, actorId: id("zeus") });
  expect(stub.seen).toHaveLength(1);
});

function struck(): WorldState {
  const state = actorAt(
    actorAt(zeusAtTavern(), "farmer", "tavern"),
    "hera",
    "town-square",
  );
  const submitted = submitProposal({
    schemaVersion: 1,
    actor: "zeus",
    targets: [],
    expectedRevisions: [],
    source: "fixture",
    observationId: "obs-strike",
    kind: "strike",
    target: "the-tavern",
    power: 3,
  });
  if (!submitted.ok) throw new Error(submitted.rejection.message);
  return runTick(state, createPrng(1), [submitted.proposal]).state;
}

test("the prompt carries the god's own memory of a real strike, and a god who did not see it is shown none", async () => {
  const state = struck();
  const zeusStub = startStub('{"action":"wait"}');
  await runGodTurn(deps(zeusStub), { state, actorId: id("zeus") });
  const zeusPrompt = JSON.stringify(zeusStub.seen[0]);
  expect(zeusPrompt).toContain("You remember");
  expect(zeusPrompt).toContain("building-ignited");

  const heraStub = startStub('{"action":"wait"}');
  await runGodTurn(deps(heraStub), { state, actorId: id("hera") });
  expect(JSON.stringify(heraStub.seen[0])).not.toContain("You remember");
});

test("a report built from a turn commits: the listener forms a belief from the claim, and a hallucinated listener never becomes a proposal", async () => {
  const state = struck();
  const reply = JSON.stringify({
    action: "report",
    listener: "farmer",
    content: "Fire took your tavern.",
    claim: { effect: "harm", agent: "zeus", target: "the-tavern" },
  });
  const turn = await runGodTurn(deps(startStub(reply)), {
    state,
    actorId: id("zeus"),
  });
  expect(turn?.kind).toBe("proposal");
  if (turn?.kind !== "proposal") return;
  const tick = runTick(state, createPrng(1), [turn.proposal]);
  expect(tick.rejected).toEqual([]);
  expect(
    tick.state.memories.get(id("farmer"))?.some((m) => m.kind === "told"),
  ).toBe(true);

  // Hera is in the square, out of Zeus's snapshot.
  const hallucinated = JSON.stringify({
    action: "report",
    listener: "hera",
    content: "Fire took the tavern.",
  });
  const refused = await runGodTurn(deps(startStub(hallucinated)), {
    state,
    actorId: id("zeus"),
  });
  expect(refused?.kind).toBe("exhausted");
});
