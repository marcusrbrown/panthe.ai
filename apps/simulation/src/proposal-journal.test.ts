// The durable journal behind POST /proposals, exercised against a real store
// that is closed and reopened through a freshly built composition root.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createObservationId } from "@panthea/contracts";
import {
  closeStore,
  exportArchive,
  getExternalProposal,
  listEvents,
  listExternalProposals,
  openStore,
  readClock,
  readLiveProjections,
  readPrngState,
  type Store,
} from "@panthea/persistence";
import {
  ensureTraceSchema,
  getProposalOutcomeByProposalId,
  type ProposalId,
} from "@panthea/telemetry";
import { createPrng, type PrngState, type WorldState } from "@panthea/world";
import {
  applyLiveTick,
  createServiceStatusRef,
  createSimulationServer,
  type SimulationServerHandle,
} from "./server";
import { buildRoutineQueue, type TickDeps } from "./tick";
import {
  createWorldProjectionReducers,
  deserializePrngState,
  loadGreekWorldState,
  restoreWorldTime,
} from "./world-store";
import { importWorldArchive } from "./worlds";

let dir: string;
const TOKEN = "journal-test-token";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "panthea-sim-journal-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A world opened the way a restarted service opens it: nothing carried over from an earlier open. */
interface World {
  readonly store: Store;
  readonly deps: TickDeps;
  state: WorldState;
  prng: PrngState;
  server?: SimulationServerHandle;
  url?: string;
}

function openWorld(
  storePath: string,
  options: { readonly maxProposalsPerTick?: number } = {},
): World {
  const authored = loadGreekWorldState();
  const reducers = createWorldProjectionReducers(authored);
  const store = openStore(storePath, reducers);
  ensureTraceSchema(store.db);
  const restored = restoreWorldTime(
    readLiveProjections(store, reducers),
    readClock(store.db),
  );
  const state =
    options.maxProposalsPerTick === undefined
      ? restored
      : {
          ...restored,
          rules: {
            ...restored.rules,
            maxProposalsPerTick: options.maxProposalsPerTick,
          },
        };
  return {
    store,
    deps: { store, reducers, traceDb: store.db },
    state,
    prng: deserializePrngState(readPrngState(store.db)) ?? createPrng(1),
  };
}

function startServer(world: World): void {
  const handle = createSimulationServer({
    token: TOKEN,
    store: world.store,
    reducers: world.deps.reducers,
    traceDb: world.store.db,
    slotsDir: join(dir, "slots"),
    statusRef: createServiceStatusRef(world.state),
    port: 0,
  });
  world.server = handle;
  world.url = `http://127.0.0.1:${handle.port}`;
}

function shutDown(world: World): void {
  world.server?.stop(true);
  closeStore(world.store);
}

/** One live tick, the way the service runs it: routines decided from the committed state, the journal read by the tick itself. */
function tick(
  world: World,
  deps: TickDeps = world.deps,
): "committed" | "failed" {
  const step = applyLiveTick(
    buildRoutineQueue(world.state),
    world.state,
    world.prng,
    deps,
    {
      cursorWallMs: readClock(world.store.db).cursorWallMs + 1000,
      paused: false,
    },
  );
  if (step.kind !== "committed") return "failed";
  world.state = step.state;
  world.prng = step.prng;
  return "committed";
}

let counter = 0;
function nextProposalId(): string {
  counter += 1;
  return `proposal-journal-${counter}`;
}

function envelope(
  actor: string,
  raw: Record<string, unknown>,
  proposalId: string = nextProposalId(),
) {
  const observationId = createObservationId();
  return {
    proposalId,
    observation: {
      schemaVersion: 1,
      id: observationId,
      observer: actor,
      stateRevision: 0,
      factsRead: [],
      source: "fixture",
    },
    proposal: {
      schemaVersion: 1,
      actor,
      targets: [],
      expectedRevisions: [],
      source: "fixture",
      observationId,
      ...raw,
    },
  };
}

const strike = (proposalId?: string) =>
  envelope(
    "zeus",
    { kind: "strike", target: "the-tavern", power: 3 },
    proposalId,
  );

async function post(world: World, body: unknown): Promise<Response> {
  return fetch(`${world.url}/proposals`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
}

const outcomeOf = (world: World, proposalId: string) =>
  getProposalOutcomeByProposalId(world.store.db, proposalId as ProposalId);

const eventsCausedBy = (world: World, observationId: string) =>
  listEvents(world.store.db).filter(
    (event) => String(event.correlationId) === observationId,
  );

describe("accepting a proposal", () => {
  test("answers 202 with the proposal id only after the entry is journaled", async () => {
    const world = openWorld(join(dir, "world.sqlite"));
    startServer(world);
    try {
      const body = strike();
      const response = await post(world, body);

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        ok: true,
        queued: true,
        proposalId: body.proposalId,
        status: "pending",
      });
      expect(
        getExternalProposal(world.store.db, body.proposalId),
      ).toMatchObject({
        inputOrder: 1,
        targetTick: 1,
        consumedTick: undefined,
      });
    } finally {
      shutDown(world);
    }
  });

  test("a proposal without a proposalId is refused at intake and journals nothing", async () => {
    const world = openWorld(join(dir, "world.sqlite"));
    startServer(world);
    try {
      const { proposalId: _omitted, ...withoutId } = strike();
      const response = await post(world, withoutId);

      expect(response.status).toBe(400);
      expect(listExternalProposals(world.store.db)).toEqual([]);
    } finally {
      shutDown(world);
    }
  });

  test("a store failure at intake is an error, never a queued success", async () => {
    const world = openWorld(join(dir, "world.sqlite"));
    startServer(world);
    try {
      world.store.db.exec("DROP TABLE external_proposals");
      const response = await post(world, strike());

      expect(response.status).toBe(500);
      expect(((await response.json()) as { ok: boolean }).ok).toBe(false);
    } finally {
      shutDown(world);
    }
  });

  test("an id already used by a routine's proposal is refused, so its outcome can never be dropped", async () => {
    const world = openWorld(join(dir, "world.sqlite"));
    startServer(world);
    try {
      expect(tick(world)).toBe("committed");
      const routineId = world.store.db
        .query("SELECT proposal_id FROM trace_proposal_outcomes LIMIT 1")
        .get() as { proposal_id: string };

      const response = await post(world, strike(routineId.proposal_id));

      expect(response.status).toBe(409);
      expect(listExternalProposals(world.store.db)).toEqual([]);
    } finally {
      shutDown(world);
    }
  });
});

describe("a journaled proposal across a restart", () => {
  test("accept, close, reopen: it runs exactly once and its outcome resolves by the returned proposal id", async () => {
    const storePath = join(dir, "world.sqlite");
    const first = openWorld(storePath);
    startServer(first);
    const body = strike();
    expect((await post(first, body)).status).toBe(202);
    shutDown(first);

    const second = openWorld(storePath);
    startServer(second);
    try {
      expect(tick(second)).toBe("committed");
      expect(outcomeOf(second, body.proposalId)).toMatchObject({
        outcome: "committed",
      });
      expect(
        eventsCausedBy(second, body.observation.id).map((e) => e.kind),
      ).toEqual(["resource-consumed", "building-ignited"]);
      expect(
        getExternalProposal(second.store.db, body.proposalId)?.consumedTick,
      ).toBe(1);

      const trace = await fetch(
        `${second.url}/trace/proposal?id=${body.proposalId}`,
        { headers: { Authorization: `Bearer ${TOKEN}` } },
      );
      const traced = (await trace.json()) as {
        result: { found: boolean; steps: { step: string }[] };
      };
      expect(traced.result.found).toBe(true);
      expect(traced.result.steps.map((s) => s.step)).toContain("validation");
    } finally {
      shutDown(second);
    }
  });

  test("after a committed consumption, a further restart does not apply the proposal again", async () => {
    const storePath = join(dir, "world.sqlite");
    const first = openWorld(storePath);
    startServer(first);
    const body = strike();
    await post(first, body);
    tick(first);
    shutDown(first);

    const second = openWorld(storePath);
    tick(second);
    tick(second);
    try {
      expect(eventsCausedBy(second, body.observation.id)).toHaveLength(2);
      expect(
        getExternalProposal(second.store.db, body.proposalId)?.consumedTick,
      ).toBe(1);
    } finally {
      shutDown(second);
    }
  });

  test("several inputs, a reopen, then more inputs: order and target ticks are preserved and they run in that order", async () => {
    const storePath = join(dir, "world.sqlite");
    const first = openWorld(storePath);
    startServer(first);
    const a = envelope("zeus", {
      kind: "strike",
      target: "the-tavern",
      power: 3,
    });
    const b = envelope("farmer", {
      kind: "worship",
      deity: "zeus",
      offering: { resource: "currency", amount: 1 },
    });
    await post(first, a);
    await post(first, b);
    tick(first);
    const c = envelope("woodcutter", {
      kind: "worship",
      deity: "zeus",
      offering: { resource: "currency", amount: 1 },
    });
    await post(first, c);
    shutDown(first);

    const second = openWorld(storePath);
    startServer(second);
    const d = envelope("zeus", { kind: "strike", target: "old-oak", power: 1 });
    await post(second, d);
    try {
      expect(
        listExternalProposals(second.store.db).map((entry) => [
          entry.proposalId,
          entry.inputOrder,
          entry.targetTick,
        ]),
      ).toEqual([
        [a.proposalId, 1, 1],
        [b.proposalId, 2, 1],
        [c.proposalId, 3, 2],
        [d.proposalId, 4, 2],
      ]);

      tick(second);

      const sequenceOf = (observationId: string) =>
        eventsCausedBy(second, observationId)[0]?.sequence ?? Number.NaN;
      expect(sequenceOf(c.observation.id)).toBeLessThan(
        sequenceOf(d.observation.id),
      );
    } finally {
      shutDown(second);
    }
  });
});

describe("a tick that fails to commit", () => {
  test("leaves the entry pending with no outcome and no effects; the next tick runs it once", async () => {
    const storePath = join(dir, "world.sqlite");
    const world = openWorld(storePath);
    startServer(world);
    const body = strike();
    await post(world, body);
    try {
      const failing: TickDeps = {
        ...world.deps,
        commitTick: () => {
          throw new Error("disk I/O error: SQLITE_FULL");
        },
      };
      expect(tick(world, failing)).toBe("failed");

      expect(
        getExternalProposal(world.store.db, body.proposalId)?.consumedTick,
      ).toBeUndefined();
      expect(outcomeOf(world, body.proposalId)).toBeUndefined();
      expect(listEvents(world.store.db)).toEqual([]);

      expect(tick(world)).toBe("committed");
      expect(outcomeOf(world, body.proposalId)?.outcome).toBe("committed");
      expect(eventsCausedBy(world, body.observation.id)).toHaveLength(2);
    } finally {
      shutDown(world);
    }
  });
});

describe("retrying a proposal", () => {
  test("the same id with the same content journals nothing new and reports its status, pending and then committed", async () => {
    const world = openWorld(join(dir, "world.sqlite"));
    startServer(world);
    try {
      const body = strike();
      await post(world, body);

      const whilePending = await post(world, {
        proposal: body.proposal,
        observation: body.observation,
        proposalId: body.proposalId,
      });
      expect(whilePending.status).toBe(202);
      expect(await whilePending.json()).toMatchObject({
        proposalId: body.proposalId,
        status: "pending",
      });
      expect(listExternalProposals(world.store.db)).toHaveLength(1);

      tick(world);
      const afterCommit = await post(world, body);
      expect(afterCommit.status).toBe(200);
      expect(await afterCommit.json()).toMatchObject({
        ok: true,
        queued: false,
        proposalId: body.proposalId,
        status: "committed",
      });
      expect(listExternalProposals(world.store.db)).toHaveLength(1);
      expect(eventsCausedBy(world, body.observation.id)).toHaveLength(2);
    } finally {
      shutDown(world);
    }
  });

  test("a retry of a rejected proposal reports the recorded rejection", async () => {
    const world = openWorld(join(dir, "world.sqlite"));
    startServer(world);
    try {
      const stale = envelope("zeus", {
        kind: "strike",
        target: "agora-shop",
        power: 1,
        expectedRevisions: [{ entityId: "agora-shop", revision: 999_999 }],
      });
      await post(world, stale);
      tick(world);

      const retry = await post(world, stale);

      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({
        status: "rejected",
        reason: "stale-target",
      });
    } finally {
      shutDown(world);
    }
  });

  test("the same id with changed content is a 409 and changes nothing", async () => {
    const world = openWorld(join(dir, "world.sqlite"));
    startServer(world);
    try {
      const body = strike();
      await post(world, body);

      const changed = await post(world, {
        ...body,
        proposal: { ...body.proposal, power: 9 },
      });

      expect(changed.status).toBe(409);
      expect(
        getExternalProposal(world.store.db, body.proposalId)?.proposal,
      ).toMatchObject({ power: 3 });
      expect(listExternalProposals(world.store.db)).toHaveLength(1);
    } finally {
      shutDown(world);
    }
  });

  test("changed content for an id whose proposal was already consumed is a 409, and the journal row is unchanged", async () => {
    const world = openWorld(join(dir, "world.sqlite"));
    startServer(world);
    try {
      const body = strike();
      await post(world, body);
      tick(world);
      const before = getExternalProposal(world.store.db, body.proposalId);
      expect(before?.consumedTick).toBe(1);

      const changed = await post(world, {
        ...body,
        proposal: { ...body.proposal, power: 9 },
      });

      expect(changed.status).toBe(409);
      expect(getExternalProposal(world.store.db, body.proposalId)).toEqual(
        before,
      );
      expect(listExternalProposals(world.store.db)).toHaveLength(1);
    } finally {
      shutDown(world);
    }
  });

  test("a consumed entry with no recorded outcome is corruption: the retry is an error and nothing runs again", async () => {
    const world = openWorld(join(dir, "world.sqlite"));
    startServer(world);
    try {
      const body = strike();
      await post(world, body);
      world.store.db.run(
        "UPDATE external_proposals SET consumed_tick = 1 WHERE proposal_id = ?",
        [body.proposalId],
      );

      const retry = await post(world, body);

      expect(retry.status).toBe(500);
      tick(world);
      expect(eventsCausedBy(world, body.observation.id)).toEqual([]);
    } finally {
      shutDown(world);
    }
  });
});

describe("terminal outcomes", () => {
  test("stale, busy, and over-limit proposals are consumed with durable rejections, and none runs again after a reopen", async () => {
    const storePath = join(dir, "world.sqlite");
    const first = openWorld(storePath);
    startServer(first);
    const committed = strike();
    const busy = envelope("zeus", {
      kind: "strike",
      target: "old-oak",
      power: 1,
    });
    const stale = envelope("farmer", {
      kind: "strike",
      target: "agora-shop",
      power: 1,
      expectedRevisions: [{ entityId: "agora-shop", revision: 999_999 }],
    });
    for (const body of [committed, busy, stale]) await post(first, body);
    tick(first);

    expect(outcomeOf(first, committed.proposalId)?.outcome).toBe("committed");
    expect(outcomeOf(first, busy.proposalId)).toMatchObject({
      outcome: "rejected",
      reason: "busy-actor",
    });
    expect(outcomeOf(first, stale.proposalId)).toMatchObject({
      outcome: "rejected",
      reason: "stale-target",
    });
    shutDown(first);

    // A tight cap in a later tick: two actions fit, the third is over the limit.
    const second = openWorld(storePath, { maxProposalsPerTick: 2 });
    startServer(second);
    const fits1 = envelope("farmer", {
      kind: "worship",
      deity: "zeus",
      offering: { resource: "currency", amount: 1 },
    });
    const fits2 = envelope("woodcutter", {
      kind: "worship",
      deity: "zeus",
      offering: { resource: "currency", amount: 1 },
    });
    const over = envelope("zeus", {
      kind: "strike",
      target: "old-oak",
      power: 1,
    });
    for (const body of [fits1, fits2, over]) await post(second, body);
    tick(second);
    expect(outcomeOf(second, over.proposalId)).toMatchObject({
      outcome: "rejected",
      reason: "over-limit",
    });
    shutDown(second);

    const third = openWorld(storePath);
    const eventsBefore = listEvents(third.store.db).length;
    try {
      const all = [committed, busy, stale, fits1, fits2, over];
      for (const body of all) {
        expect(
          getExternalProposal(third.store.db, body.proposalId)?.consumedTick,
        ).toBeDefined();
        expect(outcomeOf(third, body.proposalId)).toBeDefined();
      }
      tick(third);
      const causedByJournal = listEvents(third.store.db)
        .slice(eventsBefore)
        .filter((event) =>
          all.some(
            (body) => String(event.correlationId) === body.observation.id,
          ),
        );
      expect(causedByJournal).toEqual([]);
    } finally {
      shutDown(third);
    }
  });
});

describe("a restored branch", () => {
  test("executes the pending entries the snapshot held, once, and leaves consumed ones alone", async () => {
    const storePath = join(dir, "world.sqlite");
    const source = openWorld(storePath);
    startServer(source);
    const consumed = strike();
    await post(source, consumed);
    tick(source);
    const pending = envelope("zeus", {
      kind: "strike",
      target: "old-oak",
      power: 1,
    });
    await post(source, pending);
    const archivePath = join(dir, "snapshot.sqlite");
    exportArchive(source.store, archivePath);
    shutDown(source);

    const slot = importWorldArchive(
      archivePath,
      join(dir, "slots"),
      createWorldProjectionReducers(loadGreekWorldState()).codec,
    );
    const branch = openWorld(join(slot.slotPath, "world.sqlite"));
    try {
      const before = listEvents(branch.store.db).length;
      tick(branch);
      tick(branch);

      expect(outcomeOf(branch, pending.proposalId)?.outcome).toBe("committed");
      expect(eventsCausedBy(branch, pending.observation.id)).toHaveLength(2);
      expect(
        listEvents(branch.store.db)
          .slice(before)
          .some(
            (event) => String(event.correlationId) === consumed.observation.id,
          ),
      ).toBe(false);
      expect(
        getExternalProposal(branch.store.db, consumed.proposalId)?.consumedTick,
      ).toBe(1);
    } finally {
      shutDown(branch);
    }
  });
});
