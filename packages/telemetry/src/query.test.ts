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
import { followEvent, followProposal } from "./query";
import {
  createProposalId,
  type EventSource,
  ensureTraceSchema,
  recordObservation,
  recordProposalOutcome,
  recordReceipt,
} from "./trace";

let db: Database;
let events: Map<EventId, WorldEvent>;
let eventSource: EventSource;

beforeEach(() => {
  db = new Database(":memory:");
  ensureTraceSchema(db);
  events = new Map();
  eventSource = { getEvent: (id) => events.get(id) };
});

afterEach(() => {
  db.close();
});

function seedCommittedChain(): {
  observation: ObservationRecord;
  proposal: Proposal;
  proposalId: ReturnType<typeof createProposalId>;
  event: WorldEvent;
} {
  const observation: ObservationRecord = {
    schemaVersion: 1,
    id: createObservationId(),
    observer: createEntityId(),
    stateRevision: 0,
    factsRead: ["strike observed"],
    source: "fixture",
  };
  recordObservation(db, observation);

  const proposalId = createProposalId();
  const proposal: Proposal = {
    schemaVersion: 1,
    actor: createEntityId(),
    targets: [],
    expectedRevisions: [],
    source: "fixture",
    observationId: observation.id,
    kind: "strike",
    target: createEntityId(),
    power: 10,
  };

  const event: WorldEvent = {
    schemaVersion: 2,
    id: createEventId(),
    sequence: 42,
    simTime: 42,
    correlationId: createCorrelationId(),
    causationId: createCausationId(),
    approximate: false,
    kind: "entity-moved",
    entityId: createEntityId(),
    to: createEntityId(),
  };
  events.set(event.id, event);

  recordProposalOutcome(db, {
    proposalId,
    observationId: observation.id,
    correlationId: event.correlationId,
    causationId: event.causationId,
    proposal,
    outcome: "committed",
    eventId: event.id,
  });

  return { observation, proposal, proposalId, event };
}

describe("followEvent", () => {
  test("happy path: returns observation -> proposal -> validation -> event -> projection change -> receipt in order", () => {
    const { observation, proposal, event } = seedCommittedChain();
    const sessionId = createSessionId();
    recordReceipt(db, eventSource, { eventId: event.id, sessionId });

    const result = followEvent(db, eventSource, event.id);
    expect(result.found).toBe(true);
    expect(result.steps.map((s) => s.step)).toEqual([
      "observation",
      "proposal",
      "validation",
      "event",
      "projection-change",
      "receipt",
    ]);

    const [obsStep, propStep, validStep, eventStep, projStep, receiptStep] =
      result.steps;
    expect(obsStep).toMatchObject({ step: "observation", record: observation });
    expect(propStep).toMatchObject({ step: "proposal", record: proposal });
    expect(validStep).toMatchObject({
      step: "validation",
      outcome: "committed",
    });
    expect(eventStep).toMatchObject({ step: "event", eventId: event.id });
    expect(projStep).toMatchObject({
      step: "projection-change",
      revision: event.sequence,
    });
    expect(receiptStep).toMatchObject({ step: "receipt", sessionId });
  });

  test("error path: a rejected proposal's follow-event-by-proposal returns its reason and no event/receipt steps", () => {
    const observation: ObservationRecord = {
      schemaVersion: 1,
      id: createObservationId(),
      observer: createEntityId(),
      stateRevision: 0,
      factsRead: [],
      source: "fixture",
    };
    recordObservation(db, observation);
    const proposalId = createProposalId();
    const proposal: Proposal = {
      schemaVersion: 1,
      actor: createEntityId(),
      targets: [],
      expectedRevisions: [],
      source: "fixture",
      observationId: observation.id,
      kind: "claim",
      assertion: "I own the tavern",
    };
    recordProposalOutcome(db, {
      proposalId,
      observationId: observation.id,
      correlationId: createCorrelationId(),
      causationId: createCausationId(),
      proposal,
      outcome: "rejected",
      reason: "unauthorized-claim",
    });

    const result = followProposal(db, eventSource, proposalId);
    expect(result.found).toBe(true);
    expect(result.steps.map((s) => s.step)).toEqual([
      "observation",
      "proposal",
      "validation",
    ]);
    expect(result.steps[2]).toMatchObject({
      step: "validation",
      outcome: "rejected",
      reason: "unauthorized-claim",
    });
  });

  test("returns found: false for a completely unknown event with no proposal outcome and no event", () => {
    const result = followEvent(db, eventSource, createEventId());
    expect(result.found).toBe(false);
    expect(result.steps).toHaveLength(0);
  });
});
