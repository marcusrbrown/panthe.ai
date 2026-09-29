import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCausationId,
  createCorrelationId,
  createEntityId,
  createEventId,
} from "@panthea/contracts";
import {
  getExternalProposal,
  insertExternalProposal,
  markExternalProposalConsumed,
  readPendingExternalProposals,
} from "./journal";
import {
  closeStore,
  commitTick,
  openStore,
  type ProjectionReducers,
  rebuildProjections,
  type Store,
} from "./store";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "panthea-journal-"));
  dbPath = join(dir, "world.sqlite");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const reducer: ProjectionReducers<{ total: number }> = {
  initial: { total: 0 },
  applyEvent: (projections) => ({ total: projections.total + 1 }),
  codec: { encode: (value) => value, decode: (value) => value as never },
};

function advance(store: Store, tick: number, onCommitted?: () => void): void {
  commitTick(store, reducer, {
    events: [
      {
        schemaVersion: 1,
        id: createEventId(),
        sequence: tick,
        simTime: tick,
        correlationId: createCorrelationId(),
        causationId: createCausationId(),
        approximate: false,
        kind: "entity-moved",
        entityId: createEntityId(),
        to: createEntityId(),
      },
    ],
    cursorWallMs: 1000 * tick,
    paused: false,
    tick,
    simTimeMs: 1000 * tick,
    prngState: `seed-${tick}`,
    ...(onCommitted ? { onCommitted } : {}),
  });
}

const COMMITTED = { status: "committed" } as const;

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  proposalId: id,
  proposal: { kind: "strike", target: "the-tavern", power: 3, ...extra },
  observation: { id: `obs-${id}`, factsRead: [] },
});

describe("insertExternalProposal", () => {
  test("allocates input order from 1 and targets the tick after the persisted clock", () => {
    const store = openStore(dbPath, reducer);
    const first = insertExternalProposal(store.db, entry("proposal-a"));
    advance(store, 1);
    advance(store, 2);
    const second = insertExternalProposal(store.db, entry("proposal-b"));

    expect(first.kind).toBe("accepted");
    expect(first.entry).toMatchObject({ inputOrder: 1, targetTick: 1 });
    expect(second.entry).toMatchObject({ inputOrder: 2, targetTick: 3 });
    closeStore(store);
  });

  test("entries survive a reopen with their order and target ticks intact, and allocation continues above the maximum", () => {
    const store = openStore(dbPath, reducer);
    insertExternalProposal(store.db, entry("proposal-a"));
    advance(store, 1);
    insertExternalProposal(store.db, entry("proposal-b"));
    closeStore(store);

    const reopened = openStore(dbPath, reducer);
    const third = insertExternalProposal(reopened.db, entry("proposal-c"));
    expect(third.entry.inputOrder).toBe(3);
    expect(
      readPendingExternalProposals(reopened.db, 10).map((row) => [
        row.proposalId,
        row.inputOrder,
        row.targetTick,
      ]),
    ).toEqual([
      ["proposal-a", 1, 1],
      ["proposal-b", 2, 2],
      ["proposal-c", 3, 2],
    ]);
    closeStore(reopened);
  });

  test("the same id with identical content, in any key order, is the existing entry and inserts nothing", () => {
    const store = openStore(dbPath, reducer);
    insertExternalProposal(store.db, entry("proposal-a"));

    const retry = insertExternalProposal(store.db, {
      proposalId: "proposal-a",
      proposal: { power: 3, target: "the-tavern", kind: "strike" },
      observation: { factsRead: [], id: "obs-proposal-a" },
    });

    expect(retry.kind).toBe("existing");
    expect(retry.entry.inputOrder).toBe(1);
    expect(readPendingExternalProposals(store.db, 10)).toHaveLength(1);
    closeStore(store);
  });

  test("the same id with different content is a conflict and changes nothing", () => {
    const store = openStore(dbPath, reducer);
    insertExternalProposal(store.db, entry("proposal-a"));

    const changed = insertExternalProposal(
      store.db,
      entry("proposal-a", { power: 9 }),
    );

    expect(changed.kind).toBe("conflict");
    expect(getExternalProposal(store.db, "proposal-a")?.proposal).toMatchObject(
      { power: 3 },
    );
    expect(readPendingExternalProposals(store.db, 10)).toHaveLength(1);
    closeStore(store);
  });

  test("a retry of a consumed entry is still the existing entry, not a new one", () => {
    const store = openStore(dbPath, reducer);
    insertExternalProposal(store.db, entry("proposal-a"));
    markExternalProposalConsumed(store.db, "proposal-a", 1, COMMITTED);

    const retry = insertExternalProposal(store.db, entry("proposal-a"));

    expect(retry.kind).toBe("existing");
    expect(retry.entry.consumedTick).toBe(1);
    closeStore(store);
  });
});

describe("observation identity in the journal", () => {
  /** A second proposal (its own id) citing the same observation id, with the observation's content possibly changed. */
  const citing = (
    id: string,
    observation: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => ({
    proposalId: id,
    proposal: { kind: "strike", target: "the-tavern", power: 3, ...extra },
    observation,
  });

  test("two pending proposals may cite one unchanged observation", () => {
    const store = openStore(dbPath, reducer);
    const observation = { id: "obs-shared", factsRead: ["a"] };

    const first = insertExternalProposal(
      store.db,
      citing("proposal-a", observation),
    );
    const second = insertExternalProposal(
      store.db,
      citing(
        "proposal-b",
        { factsRead: ["a"], id: "obs-shared" },
        { power: 2 },
      ),
    );

    expect(first.kind).toBe("accepted");
    expect(second.kind).toBe("accepted");
    expect(readPendingExternalProposals(store.db, 5)).toHaveLength(2);
    closeStore(store);
  });

  test("a second pending proposal reusing an observation id with different content is refused, and the first entry is untouched", () => {
    const store = openStore(dbPath, reducer);
    insertExternalProposal(
      store.db,
      citing("proposal-a", { id: "obs-shared", factsRead: ["a"] }),
    );

    const result = insertExternalProposal(
      store.db,
      citing("proposal-b", { id: "obs-shared", factsRead: ["b"] }),
    );

    expect(result.kind).toBe("observation-conflict");
    expect(result.entry.proposalId).toBe("proposal-a");
    expect(getExternalProposal(store.db, "proposal-b")).toBeUndefined();
    expect(readPendingExternalProposals(store.db, 5)).toHaveLength(1);
    closeStore(store);
  });

  test("the observation id stays bound after the first proposal is consumed, and across a reopen", () => {
    const store = openStore(dbPath, reducer);
    insertExternalProposal(
      store.db,
      citing("proposal-a", { id: "obs-shared", factsRead: ["a"] }),
    );
    markExternalProposalConsumed(store.db, "proposal-a", 1, COMMITTED);
    closeStore(store);

    const reopened = openStore(dbPath, reducer);
    const conflicting = insertExternalProposal(
      reopened.db,
      citing("proposal-b", { id: "obs-shared", factsRead: ["b"] }),
    );
    const same = insertExternalProposal(
      reopened.db,
      citing("proposal-c", { id: "obs-shared", factsRead: ["a"] }),
    );

    expect(conflicting.kind).toBe("observation-conflict");
    expect(same.kind).toBe("accepted");
    closeStore(reopened);
  });

  test("a retry of one proposal id with changed content is still a proposal conflict, not an observation one", () => {
    const store = openStore(dbPath, reducer);
    insertExternalProposal(
      store.db,
      citing("proposal-a", { id: "obs-shared", factsRead: ["a"] }),
    );

    const result = insertExternalProposal(
      store.db,
      citing(
        "proposal-a",
        { id: "obs-shared", factsRead: ["a"] },
        { power: 9 },
      ),
    );

    expect(result.kind).toBe("conflict");
    closeStore(store);
  });
});

describe("readPendingExternalProposals", () => {
  test("the per-tick pending read is served by an index, not a scan of the whole journal", () => {
    const store = openStore(dbPath, reducer);
    const plan = (
      store.db
        .query(
          `EXPLAIN QUERY PLAN SELECT * FROM external_proposals
           WHERE consumed_tick IS NULL AND target_tick <= ?
           ORDER BY input_order ASC`,
        )
        .all(1) as { detail: string }[]
    ).map((row) => row.detail);

    expect(plan.some((detail) => /USING (COVERING )?INDEX/.test(detail))).toBe(
      true,
    );
    expect(
      plan.some((detail) => /^SCAN external_proposals$/.test(detail)),
    ).toBe(false);
    closeStore(store);
  });

  test("returns pending entries targeted at or before the tick, in input order", () => {
    const store = openStore(dbPath, reducer);
    insertExternalProposal(store.db, entry("proposal-a"));
    advance(store, 1);
    advance(store, 2);
    insertExternalProposal(store.db, entry("proposal-b"));
    insertExternalProposal(store.db, entry("proposal-c"));

    expect(
      readPendingExternalProposals(store.db, 1).map((row) => row.proposalId),
    ).toEqual(["proposal-a"]);
    expect(
      readPendingExternalProposals(store.db, 3).map((row) => row.proposalId),
    ).toEqual(["proposal-a", "proposal-b", "proposal-c"]);
    closeStore(store);
  });

  test("consumed entries are retained but no longer pending", () => {
    const store = openStore(dbPath, reducer);
    insertExternalProposal(store.db, entry("proposal-a"));
    insertExternalProposal(store.db, entry("proposal-b"));
    markExternalProposalConsumed(store.db, "proposal-a", 1, COMMITTED);

    expect(
      readPendingExternalProposals(store.db, 5).map((row) => row.proposalId),
    ).toEqual(["proposal-b"]);
    expect(getExternalProposal(store.db, "proposal-a")?.consumedTick).toBe(1);
    closeStore(store);
  });
});

describe("a consumed entry's terminal outcome", () => {
  test("is stored on the row with the consuming tick and read back, committed or rejected with its reason", () => {
    const store = openStore(dbPath, reducer);
    insertExternalProposal(store.db, entry("proposal-a"));
    insertExternalProposal(store.db, entry("proposal-b"));
    insertExternalProposal(store.db, entry("proposal-c"));
    markExternalProposalConsumed(store.db, "proposal-a", 1, COMMITTED);
    markExternalProposalConsumed(store.db, "proposal-b", 1, {
      status: "rejected",
      reason: "stale-target",
    });
    closeStore(store);

    const reopened = openStore(dbPath, reducer);
    expect(getExternalProposal(reopened.db, "proposal-a")).toMatchObject({
      consumedTick: 1,
      outcome: { status: "committed" },
    });
    expect(getExternalProposal(reopened.db, "proposal-b")).toMatchObject({
      consumedTick: 1,
      outcome: { status: "rejected", reason: "stale-target" },
    });
    const pending = getExternalProposal(reopened.db, "proposal-c");
    expect(pending?.consumedTick).toBeUndefined();
    expect(pending?.outcome).toBeUndefined();
    closeStore(reopened);
  });

  test("a tick that rolls back leaves the row pending with no outcome", () => {
    const store = openStore(dbPath, reducer);
    insertExternalProposal(store.db, entry("proposal-a"));

    expect(() =>
      advance(store, 1, () => {
        markExternalProposalConsumed(store.db, "proposal-a", 1, COMMITTED);
        throw new Error("fail after consuming");
      }),
    ).toThrow();

    const row = getExternalProposal(store.db, "proposal-a");
    expect(row?.consumedTick).toBeUndefined();
    expect(row?.outcome).toBeUndefined();
    closeStore(store);
  });

  test("the schema forbids a consumed row without an outcome, an outcome on a pending row, and a reason unless rejected", () => {
    const store = openStore(dbPath, reducer);
    insertExternalProposal(store.db, entry("proposal-a"));
    const run = (sql: string) => () => store.db.run(sql);

    expect(
      run(
        "UPDATE external_proposals SET consumed_tick = 1 WHERE proposal_id = 'proposal-a'",
      ),
    ).toThrow();
    expect(
      run(
        "UPDATE external_proposals SET outcome = 'committed' WHERE proposal_id = 'proposal-a'",
      ),
    ).toThrow();
    expect(
      run(
        "UPDATE external_proposals SET consumed_tick = 1, outcome = 'committed', reason = 'stale-target' WHERE proposal_id = 'proposal-a'",
      ),
    ).toThrow();
    expect(
      run(
        "UPDATE external_proposals SET consumed_tick = 1, outcome = 'rejected' WHERE proposal_id = 'proposal-a'",
      ),
    ).toThrow();
    expect(
      getExternalProposal(store.db, "proposal-a")?.outcome,
    ).toBeUndefined();
    closeStore(store);
  });
});

describe("markExternalProposalConsumed", () => {
  test("consuming an entry twice, or an unknown one, throws rather than letting it run again", () => {
    const store = openStore(dbPath, reducer);
    insertExternalProposal(store.db, entry("proposal-a"));
    markExternalProposalConsumed(store.db, "proposal-a", 1, COMMITTED);

    expect(() =>
      markExternalProposalConsumed(store.db, "proposal-a", 2, COMMITTED),
    ).toThrow(/already consumed|not pending/);
    expect(() =>
      markExternalProposalConsumed(store.db, "proposal-missing", 2, COMMITTED),
    ).toThrow(/not pending|unknown/);
    expect(getExternalProposal(store.db, "proposal-a")?.consumedTick).toBe(1);
    closeStore(store);
  });

  test("consumption written in a tick's transaction rolls back with that tick, leaving the entry pending", () => {
    const store = openStore(dbPath, reducer);
    insertExternalProposal(store.db, entry("proposal-a"));

    expect(() =>
      advance(store, 1, () => {
        markExternalProposalConsumed(store.db, "proposal-a", 1, COMMITTED);
        throw new Error("fail after consuming");
      }),
    ).toThrow();

    expect(
      readPendingExternalProposals(store.db, 5).map((row) => row.proposalId),
    ).toEqual(["proposal-a"]);
    closeStore(store);
  });

  test("consumption committed with a tick survives a reopen: the entry is not pending again", () => {
    const store = openStore(dbPath, reducer);
    insertExternalProposal(store.db, entry("proposal-a"));
    advance(store, 1, () =>
      markExternalProposalConsumed(store.db, "proposal-a", 1, COMMITTED),
    );
    closeStore(store);

    const reopened = openStore(dbPath, reducer);
    expect(readPendingExternalProposals(reopened.db, 5)).toEqual([]);
    expect(getExternalProposal(reopened.db, "proposal-a")?.consumedTick).toBe(
      1,
    );
    closeStore(reopened);
  });
});

test("rebuilding projections from the event log leaves the journal untouched", () => {
  const store = openStore(dbPath, reducer);
  insertExternalProposal(store.db, entry("proposal-a"));
  insertExternalProposal(store.db, entry("proposal-b"));
  markExternalProposalConsumed(store.db, "proposal-a", 1, COMMITTED);
  advance(store, 1);
  const before = JSON.stringify(
    store.db
      .query("SELECT * FROM external_proposals ORDER BY input_order")
      .all(),
  );

  expect(rebuildProjections(store, reducer)).toEqual({ total: 1 });

  expect(
    JSON.stringify(
      store.db
        .query("SELECT * FROM external_proposals ORDER BY input_order")
        .all(),
    ),
  ).toBe(before);
  closeStore(store);
});
