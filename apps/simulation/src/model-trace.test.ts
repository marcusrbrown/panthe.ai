// A model's request joins the causal trace through the same tick that commits
// (or rejects) the proposal it produced. These tests enter a model-sourced
// proposal in-process, the way the agent layer will, and run it through the
// real tick path over a real store.

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createObservationId,
  type ObservationRecord,
} from "@panthea/contracts";
import {
  closeStore,
  listEvents,
  openStore,
  commitTick as persistCommit,
  type commitTick as persistCommitTick,
  readClock,
} from "@panthea/persistence";
import {
  createProposalId,
  ensureTraceSchema,
  followEvent,
  followProposal,
  getModelRequest,
  getModelRequestByProposalId,
  getProposalOutcomeByProposalId,
  type ModelRequestInput,
  type ModelRouteResult,
  recordModelRequest,
} from "@panthea/telemetry";
import { createPrng, submitProposal, toEntityId } from "@panthea/world";
import {
  applyOneTick,
  buildRoutineQueue,
  type QueuedProposal,
  type TickDeps,
} from "./tick";
import {
  createEventSource,
  createWorldProjectionReducers,
  loadGreekWorldState,
} from "./world-store";

const answered: ModelRouteResult = {
  kind: "intent",
  step: {
    endpoint: "ollama",
    model: "llama3.2-3b-4k",
    attempts: 1,
    elapsedMs: 812,
    mode: "native",
  },
  failed: [],
  elapsedMs: 815,
};

/** A proposal the agent layer would build: model source on both the proposal and its observation, plus the request that produced it. */
function modelProposal(
  actor: string,
  raw: Record<string, unknown>,
  route: ModelRouteResult = answered,
): { queued: QueuedProposal; request: Omit<ModelRequestInput, "proposalId"> } {
  const observation: ObservationRecord = {
    schemaVersion: 1,
    id: createObservationId(),
    observer: toEntityId(actor),
    stateRevision: 0,
    factsRead: [`actor:${actor}.inventory`],
    source: "model",
  };
  const submitted = submitProposal({
    schemaVersion: 1,
    actor,
    targets: [],
    expectedRevisions: [],
    source: "model",
    observationId: observation.id,
    ...raw,
  });
  if (!submitted.ok) throw new Error(submitted.rejection.message);
  const request = {
    role: actor,
    route,
    prompt: `You are ${actor}. What do you do?`,
    output: JSON.stringify(raw),
  };
  return {
    queued: {
      id: createProposalId(),
      proposal: submitted.proposal,
      observation,
      modelRequest: request,
    },
    request,
  };
}

function withWorld<T>(
  fn: (world: {
    store: ReturnType<typeof openStore>;
    deps: TickDeps;
    state: ReturnType<typeof loadGreekWorldState>;
    prng: ReturnType<typeof createPrng>;
  }) => T,
  extraDeps: Partial<TickDeps> = {},
): T {
  const dir = mkdtempSync(join(tmpdir(), "panthea-sim-model-trace-"));
  try {
    const state = loadGreekWorldState();
    const reducers = createWorldProjectionReducers(state);
    const store = openStore(join(dir, "world.sqlite"), reducers);
    ensureTraceSchema(store.db);
    try {
      return fn({
        store,
        deps: { store, reducers, traceDb: store.db, ...extraDeps },
        state,
        prng: createPrng(1),
      });
    } finally {
      closeStore(store);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const commit = { cursorWallMs: 1_000, paused: false };

const strike = { kind: "strike", target: "the-tavern", power: 3 };

test("a committed model proposal's chain runs observation, model request, proposal, validation, events, and the request row is found by the proposal", () => {
  withWorld(({ store, deps, state, prng }) => {
    const { queued } = modelProposal("zeus", strike);

    const step = applyOneTick(state, prng, [queued], deps, commit);

    expect(step.kind).toBe("committed");
    const chain = followProposal(store.db, createEventSource(store), queued.id);
    expect(chain.steps.map((entry) => entry.step)).toEqual([
      "observation",
      "model-request",
      "proposal",
      "validation",
      "event",
      "projection-change",
      "event",
      "projection-change",
    ]);
    expect(chain.steps[0]).toMatchObject({
      record: { id: queued.observation.id, source: "model" },
    });
    expect(chain.steps[2]).toMatchObject({
      record: { source: "model", kind: "strike" },
    });
    expect(getModelRequestByProposalId(store.db, queued.id)).toMatchObject({
      role: "zeus",
      outcome: "intent",
      proposalId: queued.id,
      promptPayload: "You are zeus. What do you do?",
    });
  });
});

test("followEvent on the ignition the model's strike caused shows the request too", () => {
  withWorld(({ store, deps, state, prng }) => {
    const { queued } = modelProposal("zeus", strike);
    applyOneTick(state, prng, [queued], deps, commit);
    const ignition = listEvents(store.db).find(
      (event) => event.kind === "building-ignited",
    );
    if (!ignition) throw new Error("expected an ignition");

    const chain = followEvent(store.db, createEventSource(store), ignition.id);

    expect(chain.steps.map((entry) => entry.step).slice(0, 4)).toEqual([
      "observation",
      "model-request",
      "proposal",
      "validation",
    ]);
  });
});

test("a chain where the first endpoint failed and the second answered records both steps with their reasons", () => {
  withWorld(({ store, deps, state, prng }) => {
    const { queued } = modelProposal("zeus", strike, {
      kind: "intent",
      step: {
        endpoint: "go",
        model: "some-go-model",
        attempts: 2,
        elapsedMs: 4_100,
        mode: "repaired",
      },
      failed: [
        {
          endpoint: "ollama",
          model: "llama3.2-3b-4k",
          attempts: 1,
          elapsedMs: 15_000,
          reason: "timeout",
        },
      ],
      elapsedMs: 19_200,
    });

    applyOneTick(state, prng, [queued], deps, commit);

    expect(getModelRequestByProposalId(store.db, queued.id)?.steps).toEqual([
      {
        endpoint: "ollama",
        model: "llama3.2-3b-4k",
        attempts: 1,
        elapsedMs: 15_000,
        reason: "timeout",
      },
      {
        endpoint: "go",
        model: "some-go-model",
        attempts: 2,
        elapsedMs: 4_100,
        mode: "repaired",
      },
    ]);
  });
});

test("a model proposal the world rejects still has its request in the trace, between its observation and the proposal", () => {
  withWorld(({ store, deps, state, prng }) => {
    const { queued } = modelProposal("zeus", {
      kind: "strike",
      target: "agora-shop",
      power: 1,
      expectedRevisions: [{ entityId: "agora-shop", revision: 999_999 }],
    });

    applyOneTick(state, prng, [queued], deps, commit);

    expect(getProposalOutcomeByProposalId(store.db, queued.id)).toMatchObject({
      outcome: "rejected",
      reason: "stale-target",
    });
    expect(
      followProposal(store.db, createEventSource(store), queued.id).steps.map(
        (entry) => entry.step,
      ),
    ).toEqual(["observation", "model-request", "proposal", "validation"]);
  });
});

test("a routine proposal has no request, and a tick full of routines writes no model-request rows", () => {
  withWorld(({ store, deps, state, prng }) => {
    applyOneTick(state, prng, buildRoutineQueue(state), deps, commit);

    expect(
      (
        store.db
          .query("SELECT COUNT(*) AS n FROM trace_model_requests")
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });
});

test("when the tick's transaction fails, no model-request row remains, and the world did not advance", () => {
  // Fails after the trace writes, inside the transaction, as a full disk would.
  const failingAfterTrace: typeof persistCommitTick = (
    store,
    reducers,
    input,
  ) =>
    persistCommit(store, reducers, {
      ...input,
      onCommitted: (db) => {
        input.onCommitted?.(db);
        throw new Error("SQLITE_FULL: database or disk is full");
      },
    });
  withWorld(
    ({ store, deps, state, prng }) => {
      const { queued } = modelProposal("zeus", strike);

      const step = applyOneTick(state, prng, [queued], deps, commit);

      expect(step.kind).toBe("store-error");
      expect(getModelRequestByProposalId(store.db, queued.id)).toBeUndefined();
      expect(
        getProposalOutcomeByProposalId(store.db, queued.id),
      ).toBeUndefined();
      expect(readClock(store.db).tick).toBe(0);
      expect(listEvents(store.db)).toEqual([]);
    },
    { commitTick: failingAfterTrace },
  );
});

test("a store created at schema version 5 without the model-request table opens and gets the table from ensureTraceSchema, so adding it needed no version bump", () => {
  const dir = mkdtempSync(join(tmpdir(), "panthea-sim-model-table-"));
  try {
    const path = join(dir, "world.sqlite");
    const reducers = createWorldProjectionReducers(loadGreekWorldState());
    const first = openStore(path, reducers);
    ensureTraceSchema(first.db);
    // A store from before the table existed: same version, no such table.
    first.db.exec("DROP TABLE trace_model_requests");
    closeStore(first);

    const reopened = openStore(path, reducers);
    try {
      expect(
        (
          reopened.db.query("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version,
      ).toBe(5);
      const hasTable = () =>
        reopened.db
          .query(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trace_model_requests'",
          )
          .get() !== null;
      expect(hasTable()).toBe(false);

      ensureTraceSchema(reopened.db);

      expect(hasTable()).toBe(true);
      const id = recordModelRequest(reopened.db, {
        role: "zeus",
        route: { kind: "exhausted", steps: [], elapsedMs: 1 },
        prompt: "p",
      });
      expect(getModelRequest(reopened.db, id)?.outcome).toBe("exhausted");
    } finally {
      closeStore(reopened);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
