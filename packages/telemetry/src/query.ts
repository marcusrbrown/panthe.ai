// "Follow this event" query: walks from an event or a proposal outcome
// through observation -> model request (when a model produced the proposal)
// -> proposal -> validation -> event -> projection change -> presentation
// receipts, in order.

import type { Database } from "bun:sqlite";
import type { EventId, RejectionReasonCode } from "@panthea/contracts";
import {
  type EventSource,
  getModelRequestByProposalId,
  getObservation,
  getProposalOutcomeByEventId,
  getProposalOutcomeByProposalId,
  listReceiptsByEvent,
  type ModelRequestRow,
  type ObservationEntry,
  type ProposalId,
  type ProposalOutcomeRow,
  type ReceiptRow,
} from "./trace";

export type TraceStep =
  | {
      readonly step: "observation";
      readonly record: ObservationEntry["record"];
    }
  | { readonly step: "model-request"; readonly request: ModelRequestRow }
  | {
      readonly step: "proposal";
      readonly proposalId: ProposalId;
      readonly record: ProposalOutcomeRow["proposal"];
    }
  | {
      readonly step: "validation";
      readonly outcome: "committed" | "rejected";
      readonly reason?: RejectionReasonCode;
    }
  | { readonly step: "event"; readonly eventId: EventId }
  | { readonly step: "projection-change"; readonly revision: number }
  | {
      readonly step: "receipt";
      readonly sessionId: ReceiptRow["sessionId"];
      readonly presentedAtMs: ReceiptRow["presentedAtMs"];
    };

export interface FollowResult {
  readonly found: boolean;
  readonly steps: readonly TraceStep[];
}

/** The event hop, its projection change (the event's own committed sequence, since `commitTick` writes events and projections in one transaction), and every receipt recorded against it. */
function eventSteps(
  db: Database,
  eventSource: EventSource,
  eventId: EventId,
): readonly TraceStep[] {
  const steps: TraceStep[] = [{ step: "event", eventId }];
  const event = eventSource.getEvent(eventId);
  if (event) {
    steps.push({ step: "projection-change", revision: event.sequence });
  }
  for (const receipt of listReceiptsByEvent(db, eventId)) {
    steps.push({
      step: "receipt",
      sessionId: receipt.sessionId,
      presentedAtMs: receipt.presentedAtMs,
    });
  }
  return steps;
}

/**
 * The steps up to and including validation for one proposal outcome:
 * observation (if still resolvable), the model request that produced the
 * proposal (if a model did), the proposal, and its validation outcome.
 */
function causeSteps(db: Database, outcome: ProposalOutcomeRow): TraceStep[] {
  const steps: TraceStep[] = [];
  // A proposal refused for an observation conflict cited an id that is bound
  // to different evidence; showing that record would misattribute it.
  const observation =
    outcome.reason === "observation-conflict"
      ? undefined
      : getObservation(db, outcome.observationId);
  if (observation) {
    steps.push({ step: "observation", record: observation.record });
  }
  const request = getModelRequestByProposalId(db, outcome.proposalId);
  if (request) {
    steps.push({ step: "model-request", request });
  }
  steps.push({
    step: "proposal",
    proposalId: outcome.proposalId,
    record: outcome.proposal,
  });
  steps.push({
    step: "validation",
    outcome: outcome.outcome,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
  });
  return steps;
}

/**
 * Walks the causal chain of one committed event: the observation,
 * proposal, and validation that produced it, the event itself, its
 * projection change, and every presentation receipt recorded against that
 * event, in that order. Works for any event a proposal committed, not only
 * its first.
 *
 * An event no proposal committed (income, and a fire's burn ticks and
 * destruction) was caused by its tick's automatic rules. It has no
 * observation or proposal to walk, so its chain is the event, its
 * projection change, and its receipts. The fire is not chained back to the
 * strike that ignited it: the log records the tick as the cause, not the
 * ignition.
 */
export function followEvent(
  db: Database,
  eventSource: EventSource,
  eventId: EventId,
): FollowResult {
  const event = eventSource.getEvent(eventId);
  if (event === undefined) {
    return { found: false, steps: [] };
  }
  const outcome = getProposalOutcomeByEventId(db, eventId);
  return {
    found: true,
    steps: [
      ...(outcome ? causeSteps(db, outcome) : []),
      ...eventSteps(db, eventSource, eventId),
    ],
  };
}

/**
 * Walks the causal chain starting from a proposal (covers the rejected
 * path, which never reaches a committed event): observation, proposal,
 * validation, and, for a committed outcome, each event it committed in
 * order with that event's projection change and receipts.
 */
export function followProposal(
  db: Database,
  eventSource: EventSource,
  proposalId: ProposalId,
): FollowResult {
  const outcome = getProposalOutcomeByProposalId(db, proposalId);
  if (!outcome) {
    return { found: false, steps: [] };
  }
  return {
    found: true,
    steps: [
      ...causeSteps(db, outcome),
      ...outcome.eventIds.flatMap((eventId) =>
        eventSteps(db, eventSource, eventId),
      ),
    ],
  };
}
