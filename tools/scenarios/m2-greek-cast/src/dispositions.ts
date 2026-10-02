// What the world did with every god proposal. The sidecar already records it:
// the proposal journal keeps each consumed proposal's outcome and, for a
// rejection, the validation reason code, and the events a committed proposal
// caused carry its observation id as their correlation id. The run reads both
// before it deletes the store; nothing here asks the world for anything new.

import { primaryTarget } from "./episode-analysis";
import type { RealInput } from "./real-analysis";

export interface Disposition {
  readonly proposalId: string;
  readonly actor: string;
  /** The action kind the god proposed. */
  readonly kind: string;
  readonly target: string;
  /**
   * What became of it: `committed`, `committed, no event` (the journal says
   * committed but no event carries its observation), the validation reason code
   * of a rejection (`stale-target`, `not-adjacent`, ...), `rejected` when the
   * journal gave no code, or `pending` when the world had not consumed it.
   */
  readonly outcome: string;
  /** The kinds of the events a committed proposal caused, in commit order. */
  readonly events: readonly string[];
}

/** Every god proposal in journal order, each with its disposition. */
export function buildDispositions(
  input: Pick<RealInput, "proposals" | "events">,
): Disposition[] {
  return input.proposals.map((proposal) => {
    const events =
      proposal.outcome === "committed"
        ? [
            ...new Set(
              input.events
                .filter((e) => e.correlationId === proposal.observationId)
                .map((e) => String(e.kind)),
            ),
          ]
        : [];
    const outcome =
      proposal.outcome === "committed"
        ? events.length === 0
          ? "committed, no event"
          : "committed"
        : proposal.outcome === "rejected"
          ? (proposal.reason ?? "rejected")
          : "pending";
    return {
      proposalId: proposal.proposalId,
      actor: proposal.actor,
      kind: proposal.kind,
      target: primaryTarget(proposal.proposal),
      outcome,
      events,
    };
  });
}

export interface DispositionCount {
  readonly kind: string;
  readonly outcome: string;
  readonly count: number;
}

/** Counts by action kind and outcome, the biggest first; ties keep the order first seen. */
export function dispositionCounts(
  dispositions: readonly Disposition[],
): DispositionCount[] {
  const counts = new Map<string, DispositionCount>();
  for (const { kind, outcome } of dispositions) {
    const key = `${kind}\n${outcome}`;
    const held = counts.get(key);
    counts.set(key, { kind, outcome, count: (held?.count ?? 0) + 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

/** `bless 14 × stale-target, move 9 × committed`, or `none`. */
export function renderDispositionCounts(
  dispositions: readonly Disposition[],
): string {
  const counts = dispositionCounts(dispositions);
  return counts.length === 0
    ? "none"
    : counts.map((c) => `${c.kind} ${c.count} × ${c.outcome}`).join(", ");
}
