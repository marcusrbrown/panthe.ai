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
  type EventSource,
  ensureTraceSchema,
  getObservation,
  getProposalOutcomeByEventId,
  getProposalOutcomeByProposalId,
  listReceiptsByEvent,
  parseProposalId,
  recordObservation,
  recordProposalOutcome,
  recordReceipt,
  UnknownEventError,
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

  test("only the three trace tables exist", () => {
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
    expect(fetched?.record.factsRead).toEqual(["fact-1"]);
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
  test("happy path: a receipt for a known event is recorded", () => {
    const event = fakeEvent(createEventId());
    const eventSource: EventSource = {
      getEvent: (id) => (id === event.id ? event : undefined),
    };
    const sessionId = createSessionId();

    recordReceipt(db, eventSource, { eventId: event.id, sessionId });

    const rows = listReceiptsByEvent(db, event.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventId: event.id, sessionId });
  });

  test("error path: a receipt referencing an unknown event is rejected and never persisted", () => {
    const eventSource: EventSource = { getEvent: () => undefined };
    const unknownEventId = createEventId();

    expect(() =>
      recordReceipt(db, eventSource, {
        eventId: unknownEventId,
        sessionId: createSessionId(),
      }),
    ).toThrow(UnknownEventError);

    expect(listReceiptsByEvent(db, unknownEventId)).toHaveLength(0);
  });

  test("idempotent per event+session: duplicate receipts are dropped, not persisted twice", () => {
    const event = fakeEvent(createEventId());
    const eventSource: EventSource = { getEvent: () => event };
    const sessionId = createSessionId();

    recordReceipt(db, eventSource, { eventId: event.id, sessionId });
    recordReceipt(db, eventSource, { eventId: event.id, sessionId });

    expect(listReceiptsByEvent(db, event.id)).toHaveLength(1);
  });
});
