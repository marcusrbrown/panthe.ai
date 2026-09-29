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
  type ModelRouteResult,
  recordModelRequest,
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
    eventIds: [event.id],
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

/** A strike: a divinity spend followed by the ignition it caused, committed together. */
function seedStrike(): {
  observation: ObservationRecord;
  proposalId: ReturnType<typeof createProposalId>;
  spend: WorldEvent;
  ignition: WorldEvent;
} {
  const observation: ObservationRecord = {
    schemaVersion: 1,
    id: createObservationId(),
    observer: createEntityId(),
    stateRevision: 0,
    factsRead: [],
    source: "fixture",
  };
  recordObservation(db, observation);
  const tavern = createEntityId();
  const base = {
    schemaVersion: 2,
    simTime: 1000,
    correlationId: createCorrelationId(),
    causationId: createCausationId(),
    approximate: false,
  };
  const spend: WorldEvent = {
    ...base,
    id: createEventId(),
    sequence: 10,
    kind: "resource-consumed",
    entityId: createEntityId(),
    resource: "divinity",
    amount: 3,
  };
  const ignition: WorldEvent = {
    ...base,
    id: createEventId(),
    sequence: 11,
    kind: "building-ignited",
    entityId: tavern,
  };
  events.set(spend.id, spend);
  events.set(ignition.id, ignition);
  const proposalId = createProposalId();
  recordProposalOutcome(db, {
    proposalId,
    observationId: observation.id,
    correlationId: spend.correlationId,
    causationId: spend.causationId,
    proposal: {
      schemaVersion: 1,
      actor: createEntityId(),
      targets: [tavern],
      expectedRevisions: [],
      source: "fixture",
      observationId: observation.id,
      kind: "strike",
      target: tavern,
      power: 3,
    },
    outcome: "committed",
    eventIds: [spend.id, ignition.id],
  });
  return { observation, proposalId, spend, ignition };
}

describe("a proposal that committed several events", () => {
  test("followEvent on a later event walks observation, proposal, validation, that event, its projection change, and its receipts", () => {
    const { observation, proposalId, spend, ignition } = seedStrike();
    const sessionId = createSessionId();
    recordReceipt(db, eventSource, { eventId: ignition.id, sessionId });

    const result = followEvent(db, eventSource, ignition.id);
    expect(result.found).toBe(true);
    expect(result.steps.map((s) => s.step)).toEqual([
      "observation",
      "proposal",
      "validation",
      "event",
      "projection-change",
      "receipt",
    ]);
    expect(result.steps[0]).toMatchObject({
      step: "observation",
      record: observation,
    });
    expect(result.steps[1]).toMatchObject({ step: "proposal", proposalId });
    expect(result.steps[3]).toMatchObject({
      step: "event",
      eventId: ignition.id,
    });
    expect(result.steps[3]).not.toMatchObject({ eventId: spend.id });
    expect(result.steps[4]).toMatchObject({
      step: "projection-change",
      revision: ignition.sequence,
    });
    expect(result.steps[5]).toMatchObject({ step: "receipt", sessionId });
  });

  test("followEvent lists only the queried event's receipts, not its siblings'", () => {
    const { spend, ignition } = seedStrike();
    const drawnBy = createSessionId();
    recordReceipt(db, eventSource, {
      eventId: ignition.id,
      sessionId: drawnBy,
    });

    const spendChain = followEvent(db, eventSource, spend.id);
    expect(spendChain.steps.map((s) => s.step)).not.toContain("receipt");
    expect(
      followEvent(db, eventSource, ignition.id).steps.filter(
        (s) => s.step === "receipt",
      ),
    ).toHaveLength(1);
  });

  test("followProposal lists every event the proposal committed, each with its projection change and receipts", () => {
    const { proposalId, spend, ignition } = seedStrike();
    const sessionId = createSessionId();
    recordReceipt(db, eventSource, { eventId: ignition.id, sessionId });

    const result = followProposal(db, eventSource, proposalId);
    expect(result.steps.map((s) => s.step)).toEqual([
      "observation",
      "proposal",
      "validation",
      "event",
      "projection-change",
      "event",
      "projection-change",
      "receipt",
    ]);
    expect(
      result.steps.filter((s) => s.step === "event").map((s) => s.eventId),
    ).toEqual([spend.id, ignition.id]);
  });
});

describe("events no proposal committed", () => {
  test("an environment event (a fire's burn or destruction) is caused by the tick's automatic rules, so its chain has no observation or proposal hop", () => {
    seedStrike();
    const burn: WorldEvent = {
      schemaVersion: 2,
      id: createEventId(),
      sequence: 12,
      simTime: 2000,
      correlationId: createCorrelationId(),
      causationId: createCausationId(),
      approximate: false,
      kind: "building-burn-ticked",
      entityId: createEntityId(),
      fireIntensity: 1,
      ticksBurning: 1,
    };
    events.set(burn.id, burn);
    const sessionId = createSessionId();
    recordReceipt(db, eventSource, { eventId: burn.id, sessionId });

    const result = followEvent(db, eventSource, burn.id);
    expect(result.found).toBe(true);
    expect(result.steps.map((s) => s.step)).toEqual([
      "event",
      "projection-change",
      "receipt",
    ]);
    expect(result.steps[1]).toMatchObject({
      step: "projection-change",
      revision: burn.sequence,
    });
  });
});

describe("a proposal refused for an observation conflict", () => {
  test("its chain shows the proposal and its rejection but no observation hop: the id resolves to different evidence than the proposal cited", () => {
    const recorded: ObservationRecord = {
      schemaVersion: 1,
      id: createObservationId(),
      observer: createEntityId(),
      stateRevision: 0,
      factsRead: ["what the first proposal saw"],
      source: "fixture",
    };
    recordObservation(db, recorded);
    const proposalId = createProposalId();
    recordProposalOutcome(db, {
      proposalId,
      observationId: recorded.id,
      correlationId: createCorrelationId(),
      causationId: createCausationId(),
      proposal: {
        schemaVersion: 1,
        actor: createEntityId(),
        targets: [],
        expectedRevisions: [],
        source: "fixture",
        observationId: recorded.id,
        kind: "move",
        to: createEntityId(),
      },
      outcome: "rejected",
      reason: "observation-conflict",
    });

    const result = followProposal(db, eventSource, proposalId);

    expect(result.found).toBe(true);
    expect(result.steps.map((step) => step.step)).toEqual([
      "proposal",
      "validation",
    ]);
    expect(result.steps[1]).toMatchObject({
      outcome: "rejected",
      reason: "observation-conflict",
    });
  });
});

describe("a proposal a model produced", () => {
  const route: ModelRouteResult = {
    kind: "intent",
    step: {
      endpoint: "ollama",
      model: "llama3.2-3b-4k",
      attempts: 1,
      elapsedMs: 800,
      mode: "native",
    },
    failed: [],
    elapsedMs: 800,
  };

  test("followProposal walks observation, model request, proposal, validation, then each event with its projection change", () => {
    const { proposalId, spend, ignition, observation } = seedStrike();
    recordModelRequest(db, {
      proposalId,
      role: "zeus",
      route,
      prompt: "What does Zeus do?",
      output: '{"kind":"strike"}',
    });

    const result = followProposal(db, eventSource, proposalId);

    expect(result.steps.map((step) => step.step)).toEqual([
      "observation",
      "model-request",
      "proposal",
      "validation",
      "event",
      "projection-change",
      "event",
      "projection-change",
    ]);
    expect(result.steps[0]).toMatchObject({ record: observation });
    expect(result.steps[1]).toMatchObject({
      step: "model-request",
      request: {
        role: "zeus",
        outcome: "intent",
        proposalId,
        promptPayload: "What does Zeus do?",
        steps: [{ endpoint: "ollama", mode: "native" }],
      },
    });
    expect(
      result.steps
        .filter((step) => step.step === "event")
        .map((s) => s.eventId),
    ).toEqual([spend.id, ignition.id]);
  });

  test("followEvent on any event the proposal committed shows the same model-request hop", () => {
    const { proposalId, ignition } = seedStrike();
    recordModelRequest(db, {
      proposalId,
      role: "zeus",
      route,
      prompt: "p",
      output: "o",
    });

    const result = followEvent(db, eventSource, ignition.id);

    expect(result.steps.map((step) => step.step)).toEqual([
      "observation",
      "model-request",
      "proposal",
      "validation",
      "event",
      "projection-change",
    ]);
  });

  test("a chain that failed over shows every step with its reason in the hop", () => {
    const { proposalId } = seedStrike();
    recordModelRequest(db, {
      proposalId,
      role: "hera",
      route: {
        kind: "intent",
        step: {
          endpoint: "go",
          model: "some-go-model",
          attempts: 1,
          elapsedMs: 3_000,
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
        elapsedMs: 18_000,
      },
      prompt: "p",
      output: "o",
    });

    const hop = followProposal(db, eventSource, proposalId).steps.find(
      (step) => step.step === "model-request",
    );

    expect(hop).toMatchObject({
      request: {
        steps: [
          { endpoint: "ollama", reason: "timeout" },
          { endpoint: "go", mode: "repaired" },
        ],
      },
    });
  });

  test("a rejected proposal still shows the request that produced it, between its observation and the proposal", () => {
    const observation: ObservationRecord = {
      schemaVersion: 1,
      id: createObservationId(),
      observer: createEntityId(),
      stateRevision: 0,
      factsRead: [],
      source: "model",
    };
    recordObservation(db, observation);
    const proposalId = createProposalId();
    recordProposalOutcome(db, {
      proposalId,
      observationId: observation.id,
      correlationId: createCorrelationId(),
      causationId: createCausationId(),
      proposal: {
        schemaVersion: 1,
        actor: createEntityId(),
        targets: [],
        expectedRevisions: [],
        source: "model",
        observationId: observation.id,
        kind: "move",
        to: createEntityId(),
      },
      outcome: "rejected",
      reason: "stale-target",
    });
    recordModelRequest(db, {
      proposalId,
      role: "zeus",
      route,
      prompt: "p",
      output: "o",
    });

    const result = followProposal(db, eventSource, proposalId);

    expect(result.steps.map((step) => step.step)).toEqual([
      "observation",
      "model-request",
      "proposal",
      "validation",
    ]);
  });

  test("a proposal that no model produced has no model-request hop", () => {
    const { proposalId } = seedStrike();

    expect(
      followProposal(db, eventSource, proposalId).steps.some(
        (step) => step.step === "model-request",
      ),
    ).toBe(false);
  });
});
