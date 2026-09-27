// "Follow this event" query: walks from an event or a proposal outcome
// through observation -> proposal -> validation -> event -> projection
// change -> presentation receipts, in order (Key Technical Decisions'
// causal trace, the O04 chain). A pruned hop returns the
// `PAYLOAD_EXPIRED` marker instead of breaking the chain.

import type { Database } from "bun:sqlite";
import type { EventId, RejectionReasonCode } from "@panthea/contracts";
import {
  type EventSource,
  getObservation,
  getProposalOutcomeByEventId,
  getProposalOutcomeByProposalId,
  listReceiptsByEvent,
  type ObservationEntry,
  type PayloadExpired,
  type ProposalId,
  type ProposalOutcomeRow,
  type ReceiptRow,
} from "./trace";

export type TraceStep =
  | {
      readonly step: "observation";
      readonly record: ObservationEntry["record"];
    }
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
      readonly record: unknown | PayloadExpired;
    };

export interface FollowResult {
  readonly found: boolean;
  readonly steps: readonly TraceStep[];
}

/**
 * Builds the ordered step list for one proposal outcome: observation (if
 * still resolvable), the proposal, its validation outcome, and — only for
 * a committed outcome whose event still resolves via `eventSource` — the
 * event, its projection change (the event's own committed sequence,
 * since packages/persistence's `commitTick` writes events and projections
 * in the same transaction), and every receipt recorded against it.
 */
function buildChain(
  db: Database,
  eventSource: EventSource,
  outcome: ProposalOutcomeRow,
): readonly TraceStep[] {
  const steps: TraceStep[] = [];

  const observation = getObservation(db, outcome.observationId);
  if (observation) {
    steps.push({ step: "observation", record: observation.record });
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

  if (outcome.outcome === "committed" && outcome.eventId) {
    steps.push({ step: "event", eventId: outcome.eventId });
    const event = eventSource.getEvent(outcome.eventId);
    if (event) {
      steps.push({ step: "projection-change", revision: event.sequence });
    }
    for (const receipt of listReceiptsByEvent(db, outcome.eventId)) {
      steps.push({
        step: "receipt",
        sessionId: receipt.sessionId,
        record: receipt.payload,
      });
    }
  }

  return steps;
}

/**
 * Walks the causal chain starting from a committed event: observation,
 * proposal, validation, the event itself, its projection change, and every
 * presentation receipt recorded against it, in that order.
 */
export function followEvent(
  db: Database,
  eventSource: EventSource,
  eventId: EventId,
): FollowResult {
  const event = eventSource.getEvent(eventId);
  const outcome = getProposalOutcomeByEventId(db, eventId);
  if (!outcome) {
    return { found: event !== undefined, steps: [] };
  }
  return { found: true, steps: buildChain(db, eventSource, outcome) };
}

/**
 * Walks the causal chain starting from a proposal (covers the rejected
 * path, which never reaches a committed event): observation, proposal,
 * validation, and — only if the proposal was committed — the same
 * event/projection/receipt tail as `followEvent`.
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
  return { found: true, steps: buildChain(db, eventSource, outcome) };
}
