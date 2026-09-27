import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createCausationId,
  createCorrelationId,
  createEntityId,
  createEventId,
  createObservationId,
  createSessionId,
  type EventId,
  type ObservationRecord,
  type Proposal,
  type WorldEvent,
} from "@panthea/contracts";
import {
  createProposalId,
  createReceiptId,
  type EventSource,
  ensureTraceSchema,
  getObservation,
  getProposalOutcomeByEventId,
  getProposalOutcomeByProposalId,
  listReceiptsByEvent,
  PAYLOAD_EXPIRED,
  parseProposalId,
  pruneRetention,
  recordObservation,
  recordProposalOutcome,
  recordReceipt,
} from "./trace";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  ensureTraceSchema(db);
});

afterEach(() => {
  db.close();
});

function makeObservation(): ObservationRecord {
  return {
    schemaVersion: 1,
    id: createObservationId(),
    observer: createEntityId(),
    stateRevision: 0,
    factsRead: ["fact-1"],
    source: "fixture",
  };
}

function makeProposal(observationId: ObservationRecord["id"]): Proposal {
  return {
    schemaVersion: 1,
    actor: createEntityId(),
    targets: [],
    preconditions: [],
    requiredCapabilities: [],
    costs: [],
    expectedRevisions: [],
    source: "fixture",
    observationId,
    kind: "move",
    to: createEntityId(),
  };
}

function fakeEvent(id: EventId): WorldEvent {
  return {
    schemaVersion: 2,
    id,
    sequence: 1,
    simTime: 1,
    correlationId: createCorrelationId(),
    causationId: createCausationId(),
    approximate: false,
    kind: "entity-moved",
    entityId: createEntityId(),
    to: createEntityId(),
  };
}

describe("ProposalId", () => {
  test("created IDs round-trip through the parser", () => {
    const id = createProposalId();
    const parsed = parseProposalId(id, "proposalId");
    expect(parsed).toEqual({ ok: true, value: id });
  });
});

describe("ensureTraceSchema", () => {
  test("the event_id lookup on trace_proposal_outcomes uses the event_id index, not a full table scan", () => {
    const plan = db
      .query(
        "EXPLAIN QUERY PLAN SELECT * FROM trace_proposal_outcomes WHERE event_id = ?",
      )
      .all("some-event-id") as { detail: string }[];
    const usesIndex = plan.some((row) =>
      /USING (COVERING )?INDEX idx_trace_proposal_outcomes_event_id/.test(
        row.detail,
      ),
    );
    expect(usesIndex).toBe(true);
  });
});

describe("recordObservation / getObservation", () => {
  test("happy path: round-trips through JSON", () => {
    const record = makeObservation();
    recordObservation(db, record);
    const fetched = getObservation(db, record.id);
    expect(fetched?.record).toEqual(record);
  });

  test("idempotent: recording the same observation ID twice keeps the first row", () => {
    const record = makeObservation();
    recordObservation(db, record);
    recordObservation(db, { ...record, factsRead: ["different"] });
    const fetched = getObservation(db, record.id);
    expect((fetched as { record: ObservationRecord }).record.factsRead).toEqual(
      ["fact-1"],
    );
  });

  test("returns undefined for an unknown ID", () => {
    expect(getObservation(db, createObservationId())).toBeUndefined();
  });
});

describe("recordProposalOutcome", () => {
  test("happy path: a committed outcome is retrievable by proposal ID and by event ID", () => {
    const observation = makeObservation();
    recordObservation(db, observation);
    const proposal = makeProposal(observation.id);
    const proposalId = createProposalId();
    const eventId = createEventId();

    recordProposalOutcome(db, {
      proposalId,
      observationId: observation.id,
      correlationId: createCorrelationId(),
      causationId: createCausationId(),
      proposal,
      outcome: "committed",
      eventId,
    });

    const byProposal = getProposalOutcomeByProposalId(db, proposalId);
    const byEvent = getProposalOutcomeByEventId(db, eventId);
    expect(byProposal?.outcome).toBe("committed");
    expect(byEvent?.proposalId).toBe(proposalId);
    expect(byProposal?.proposal).toEqual(proposal);
  });

  test("error path: a rejected proposal keeps its reason and no event ID", () => {
    const observation = makeObservation();
    recordObservation(db, observation);
    const proposal = makeProposal(observation.id);
    const proposalId = createProposalId();

    recordProposalOutcome(db, {
      proposalId,
      observationId: observation.id,
      correlationId: createCorrelationId(),
      causationId: createCausationId(),
      proposal,
      outcome: "rejected",
      reason: "stale-target",
    });

    const outcome = getProposalOutcomeByProposalId(db, proposalId);
    expect(outcome?.outcome).toBe("rejected");
    expect(outcome?.reason).toBe("stale-target");
    expect(outcome?.eventId).toBeUndefined();
  });
});

describe("recordReceipt", () => {
  test("happy path: a receipt for a known event is not orphaned", () => {
    const event = fakeEvent(createEventId());
    const eventSource: EventSource = {
      getEvent: (id) => (id === event.id ? event : undefined),
    };

    const result = recordReceipt(db, eventSource, {
      id: createReceiptId(),
      eventId: event.id,
      sessionId: createSessionId(),
    });
    expect(result.orphan).toBe(false);
  });

  test("error path: a receipt referencing an unknown event is stored as an orphan trace record only, never mutating world tables", () => {
    const eventSource: EventSource = { getEvent: () => undefined };
    const unknownEventId = createEventId();
    const result = recordReceipt(db, eventSource, {
      id: createReceiptId(),
      eventId: unknownEventId,
      sessionId: createSessionId(),
    });
    expect(result.orphan).toBe(true);

    const rows = listReceiptsByEvent(db, unknownEventId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.orphan).toBe(true);

    // No world tables exist in this trace-only database at all — the only
    // tables present are the three trace tables this module created.
    const tables = (
      db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(tables.sort()).toEqual(
      [
        "trace_observations",
        "trace_proposal_outcomes",
        "trace_receipts",
      ].sort(),
    );
  });

  test("idempotent per event+session: duplicate receipts are dropped, not persisted twice", () => {
    const event = fakeEvent(createEventId());
    const eventSource: EventSource = { getEvent: () => event };
    const sessionId = createSessionId();

    recordReceipt(db, eventSource, {
      id: createReceiptId(),
      eventId: event.id,
      sessionId,
    });
    recordReceipt(db, eventSource, {
      id: createReceiptId(),
      eventId: event.id,
      sessionId,
    });

    expect(listReceiptsByEvent(db, event.id)).toHaveLength(1);
  });
});

describe("pruneRetention", () => {
  test("edge case: after pruning, causal edges and tombstones remain and payload reads return the expired marker", () => {
    const observation = makeObservation();
    const now = 1_000_000;
    recordObservation(db, observation, now - 1000);

    pruneRetention(db, 500, now);

    const fetched = getObservation(db, observation.id);
    expect(fetched?.record).toBe(PAYLOAD_EXPIRED);

    // The row (the causal edge — the ID itself) is still present.
    const raw = db
      .query("SELECT payload_expired FROM trace_observations WHERE id = ?")
      .get(observation.id) as { payload_expired: number };
    expect(raw.payload_expired).toBe(1);
  });

  test("rows newer than the cutoff are untouched", () => {
    const observation = makeObservation();
    const now = 1_000_000;
    recordObservation(db, observation, now);
    pruneRetention(db, 500, now);
    expect(getObservation(db, observation.id)?.record).toEqual(observation);
  });

  test("integration: a failure in a later update rolls back the earlier updates in the same call", () => {
    const observation = makeObservation();
    const proposal = makeProposal(observation.id);
    const proposalId = createProposalId();
    const now = 1_000_000;

    recordObservation(db, observation, now - 1000);
    recordProposalOutcome(
      db,
      {
        proposalId,
        observationId: observation.id,
        correlationId: createCorrelationId(),
        causationId: createCausationId(),
        proposal,
        outcome: "committed",
        eventId: createEventId(),
      },
      now - 1000,
    );

    // Force the third UPDATE (trace_receipts) to fail so the whole call
    // rejects; the point of this test is that the first two UPDATEs, run
    // earlier in the same call, must not have taken effect either.
    db.exec("DROP TABLE trace_receipts");

    expect(() => pruneRetention(db, 500, now)).toThrow();

    const observationRow = db
      .query("SELECT payload_expired FROM trace_observations WHERE id = ?")
      .get(observation.id) as { payload_expired: number };
    expect(observationRow.payload_expired).toBe(0);

    const outcomeRow = db
      .query(
        "SELECT payload_expired FROM trace_proposal_outcomes WHERE proposal_id = ?",
      )
      .get(proposalId) as { payload_expired: number };
    expect(outcomeRow.payload_expired).toBe(0);
  });
});
