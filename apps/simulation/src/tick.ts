// The per-tick scheduling step: revalidate and commit a queue of
// proposals in one store transaction (writing every observation and
// outcome to the causal trace inside that same transaction), then decide
// the routine proposals for the next tick from the newly committed state.
// `stepWorldTick`/`commitWorldTick`/`traceWorldTick` are exported
// separately so catchup.ts can run several ticks purely in memory and
// commit them together as one chunk transaction, while the live 1 Hz
// loop (wired in the service entrypoint) commits one tick at a time
// through `applyOneTick`.

import type { Database } from "bun:sqlite";
import type {
  CausationId,
  CorrelationId,
  DegradedReason,
  EntityId,
  ObservationRecord,
  Proposal,
  WorldEvent,
} from "@panthea/contracts";
import {
  createObservationId,
  parseObservationRecord,
  parseProposal,
} from "@panthea/contracts";
import {
  getEventRow,
  markExternalProposalConsumed,
  type ProjectionReducers,
  commitTick as persistCommitTick,
  readPendingExternalProposals,
  type Store,
} from "@panthea/persistence";
import {
  createProposalId,
  type ProposalId,
  parseProposalId,
  recordObservation,
  recordProposalOutcome,
} from "@panthea/telemetry";
import {
  decideRoutineProposal,
  type PrngState,
  type RuleRejection,
  reject,
  runTick,
  type SubmitResult,
  submitProposal,
  toEntityId,
  type WorldState,
} from "@panthea/world";
import { serializePrngState } from "./world-store";

export interface QueuedProposal {
  readonly id: ProposalId;
  readonly proposal: Proposal;
  readonly observation: ObservationRecord;
  /** Set on a proposal read from the durable journal: the tick that runs it also marks it consumed, in its own transaction. */
  readonly external?: true;
}

export interface TickDeps {
  readonly store: Store;
  readonly reducers: ProjectionReducers<WorldState>;
  readonly traceDb: Database;
  /** Injectable for tests that simulate a store write failure (e.g. `SQLITE_FULL`); defaults to persistence's real `commitTick`. */
  readonly commitTick?: typeof persistCommitTick;
}

function toCorrelationId(raw: string): CorrelationId {
  return raw as CorrelationId;
}
function toCausationId(raw: string): CausationId {
  return raw as CausationId;
}

function classifyStoreError(error: unknown): DegradedReason {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("SQLITE_FULL") ? "disk-full" : "store-error";
}

/** Every drive-bearing, living actor's routine decision against `state`, as the queue for the *next* tick. */
export function buildRoutineQueue(
  state: WorldState,
  actorIds: Iterable<EntityId> = state.actors.keys(),
): readonly QueuedProposal[] {
  const queue: QueuedProposal[] = [];
  for (const actorId of actorIds) {
    const decision = decideRoutineProposal(state, actorId);
    if (!decision) {
      continue;
    }
    queue.push({
      id: createProposalId(),
      proposal: decision.proposal,
      observation: decision.observation,
    });
  }
  return queue;
}

/**
 * The journaled external proposals a tick numbered `tick` runs: pending
 * entries targeted at or before it, in input order. Entries are parsed again
 * as the versioned proposal and observation they were stored as; one that no
 * longer parses is a corrupt store and throws rather than being skipped.
 */
export function readPendingExternalQueue(
  db: Database,
  tick: number,
): QueuedProposal[] {
  return readPendingExternalProposals(db, tick).map((entry) => {
    const id = parseProposalId(entry.proposalId, "proposalId");
    const proposal = parseProposal(entry.proposal);
    const observation = parseObservationRecord(entry.observation);
    if (!id.ok || !proposal.ok || !observation.ok) {
      throw new Error(
        `journal entry ${entry.proposalId} no longer parses as a proposal and observation`,
      );
    }
    return {
      id: id.value,
      proposal: proposal.value,
      observation: observation.value,
      external: true,
    };
  });
}

/**
 * The proposals one live tick runs, in admission order: every external
 * (fixture or operator) proposal first, in the order they arrived, then the
 * routines' proposals in their own order.
 *
 * External proposals go first because `stepWorldTick` admits only the first
 * `maxProposalsPerTick` entries: behind the routines, an external proposal
 * would be the one rejected as over-limit whenever the cap is tight. Claims
 * are external proposals too and go first with the rest. They are counted
 * against the cap separately (`stepWorldTick`), so a claim gets its recorded
 * rejection, never an over-limit one, and never costs a routine its slot.
 *
 * An actor commits one action per tick, so an external proposal for an
 * actor takes that actor's slot and the actor's routine proposal yields:
 * it is dropped before the tick, never submitted, so nothing about it is
 * recorded (no observation, no rejection). This holds whether or not the
 * external proposal then commits. A claim never commits, so it does not
 * displace a routine.
 *
 * The result is a pure function of the two queues, and nothing here reads a
 * clock. Which tick an external proposal lands in is not persisted input:
 * `/proposals` answers 202 after an in-memory append, so the tick it joins
 * depends on when it arrived, and a crash before that tick commits loses it
 * with no outcome recorded. What is durable is the committed event log; replay
 * and rebuild come from that, never from re-merging queues.
 */
export function mergeTickQueue(
  routine: readonly QueuedProposal[],
  external: readonly QueuedProposal[],
): QueuedProposal[] {
  const claimed = new Set<EntityId>(
    external
      .filter((queued) => queued.proposal.kind !== "claim")
      .map((queued) => queued.proposal.actor),
  );
  return [
    ...external,
    ...routine.filter((queued) => !claimed.has(queued.proposal.actor)),
  ];
}

export interface StepOptions {
  readonly elapsedMs?: number;
  readonly approximate?: boolean;
}

export interface WorldTickOutcome {
  readonly result: ReturnType<typeof runTick>;
  readonly admitted: readonly QueuedProposal[];
  readonly overflow: readonly QueuedProposal[];
}

/**
 * Splits `queue`, in order, into what one tick admits and what is over the
 * limit. Actions and claims are counted separately, each up to `cap`: a
 * claim never commits and never takes an actor's slot, so it must not use up
 * capacity a routine or another action needs, yet it still has to be bounded
 * so a flood of claims cannot make the tick do unbounded validation and
 * trace writes.
 */
function admitWithinCap(
  queue: readonly QueuedProposal[],
  cap: number,
): { admitted: QueuedProposal[]; overflow: QueuedProposal[] } {
  const admitted: QueuedProposal[] = [];
  const overflow: QueuedProposal[] = [];
  let actions = 0;
  let claims = 0;
  for (const queued of queue) {
    const isClaim = queued.proposal.kind === "claim";
    if ((isClaim ? claims : actions) < cap) {
      admitted.push(queued);
      if (isClaim) claims += 1;
      else actions += 1;
    } else {
      overflow.push(queued);
    }
  }
  return { admitted, overflow };
}

/**
 * Runs one world tick purely in memory: proposals beyond
 * `state.rules.maxProposalsPerTick` (counted as `admitWithinCap` does) never
 * reach the world engine (over-limit), everything else is revalidated and
 * committed sequentially by `runTick`. No store or trace I/O --
 * `commitWorldTick`/`traceWorldTick` do that, separately, so a caller can
 * run several ticks before committing any of them (catchup.ts's
 * chunking).
 */
export function stepWorldTick(
  state: WorldState,
  prng: PrngState,
  queue: readonly QueuedProposal[],
  options: StepOptions = {},
): WorldTickOutcome {
  const { admitted, overflow } = admitWithinCap(
    queue,
    state.rules.maxProposalsPerTick,
  );
  const result = runTick(
    state,
    prng,
    admitted.map((queued) => queued.proposal),
    { elapsedMs: options.elapsedMs, approximate: options.approximate },
  );
  return { result, admitted, overflow };
}

export type CommitOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: DegradedReason;
      readonly message: string;
    };

const OPERATOR_ENTITY_ID = toEntityId("operator");

/**
 * Records a pause/resume as an operator event, distinct from any
 * character action: it never goes through `runTick`/`validateProposal`
 * and produces no `WorldEvent`. Returned as a callback rather than called
 * directly, so both `server.ts`'s `/pause`/`/resume` handlers and
 * catchup.ts's mid-catch-up pause can pass it to `commitWorldTick`'s
 * `onCommitted` hook and have it write inside the same transaction as
 * the clock transition -- a trace failure then rolls the transition back
 * exactly like a world-state write failure would, instead of leaving the
 * clock changed under an outcome that reports failure.
 */
export function recordOperatorEvent(kind: string): (db: Database) => void {
  return (db) => {
    recordObservation(db, {
      schemaVersion: 1,
      id: createObservationId(),
      observer: OPERATOR_ENTITY_ID,
      stateRevision: 0,
      factsRead: [`operator:${kind}`],
      source: "operator",
    });
  };
}

/**
 * Commits `events` in one store transaction; every proposal outcome in
 * `traceOutcomes` is written inside that same transaction (via
 * `commitTick`'s `onCommitted` hook), so a trace write failure rolls the
 * whole tick back exactly like a world-state write failure would. A
 * thrown error (a store write failure, including `SQLITE_FULL`, or a
 * trace write failure) is reported, never thrown -- nothing partially
 * commits either way.
 */
export function commitWorldTick(
  deps: TickDeps,
  events: readonly WorldEvent[],
  commitOptions: {
    readonly tick: number;
    readonly simTimeMs: number;
    readonly prngState: string;
    readonly cursorWallMs: number;
    readonly paused: boolean;
  },
  traceOutcomes: readonly WorldTickOutcome[] = [],
  /** An additional write to run inside the same transaction, after `traceOutcomes` -- e.g. a pause/resume operator observation, so a failure there rolls back the clock transition exactly like any other trace write failure would. */
  onCommitted?: (db: Database) => void,
): CommitOutcome {
  const commit = deps.commitTick ?? persistCommitTick;
  try {
    commit(deps.store, deps.reducers, {
      events,
      ...commitOptions,
      onCommitted: (db) => {
        for (const outcome of traceOutcomes) {
          traceWorldTick(db, outcome);
        }
        onCommitted?.(db);
      },
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: classifyStoreError(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Records every queued proposal's observation and outcome (committed, rejected, or over-limit) to the trace, and consumes the external ones from the journal -- called inside the tick's own transaction, so neither trace rows nor consumption outlive a rolled-back tick. */
export function traceWorldTick(
  traceDb: Database,
  outcome: WorldTickOutcome,
): void {
  const byProposal = new Map(
    outcome.admitted.map((queued) => [queued.proposal, queued] as const),
  );

  for (const queued of outcome.admitted) {
    recordObservation(traceDb, queued.observation);
  }
  for (const queued of outcome.overflow) {
    recordObservation(traceDb, queued.observation);
    recordProposalOutcome(traceDb, {
      proposalId: queued.id,
      observationId: queued.observation.id,
      correlationId: toCorrelationId(String(queued.observation.id)),
      causationId: toCausationId(String(queued.observation.id)),
      proposal: queued.proposal,
      outcome: "rejected",
      reason: "over-limit",
    });
  }
  for (const record of outcome.result.committed) {
    const queued = byProposal.get(record.proposal);
    if (!queued) {
      continue;
    }
    recordProposalOutcome(traceDb, {
      proposalId: queued.id,
      observationId: queued.observation.id,
      correlationId: toCorrelationId(String(queued.observation.id)),
      causationId: toCausationId(String(queued.observation.id)),
      proposal: record.proposal,
      outcome: "committed",
      eventIds: record.events.map((event) => event.id),
    });
  }
  for (const record of outcome.result.rejected) {
    const queued = byProposal.get(record.proposal);
    if (!queued) {
      continue;
    }
    recordProposalOutcome(traceDb, {
      proposalId: queued.id,
      observationId: queued.observation.id,
      correlationId: toCorrelationId(String(queued.observation.id)),
      causationId: toCausationId(String(queued.observation.id)),
      proposal: record.proposal,
      outcome: "rejected",
      reason: record.reason,
    });
  }
  // Every external proposal this tick took, committed, rejected, or over the
  // limit, now has its terminal outcome above; consume it in the same
  // transaction so it can never run again.
  for (const queued of [...outcome.admitted, ...outcome.overflow]) {
    if (queued.external) {
      markExternalProposalConsumed(
        traceDb,
        queued.id,
        outcome.result.state.tick,
      );
    }
  }
}

export type TickStepResult =
  | {
      readonly kind: "committed";
      readonly state: WorldState;
      readonly prng: PrngState;
      readonly nextQueue: readonly QueuedProposal[];
      readonly events: number;
    }
  | {
      readonly kind: "store-error";
      readonly reason: DegradedReason;
      readonly message: string;
    };

/** One live tick: `stepWorldTick` then `commitWorldTick`, which writes the tick's trace rows inside the same transaction as its world-state commit. */
export function applyOneTick(
  state: WorldState,
  prng: PrngState,
  queue: readonly QueuedProposal[],
  deps: TickDeps,
  commit: {
    readonly cursorWallMs: number;
    readonly paused: boolean;
    readonly elapsedMs?: number;
    readonly approximate?: boolean;
  },
): TickStepResult {
  const outcome = stepWorldTick(state, prng, queue, {
    elapsedMs: commit.elapsedMs,
    approximate: commit.approximate,
  });
  const committed = commitWorldTick(
    deps,
    outcome.result.events,
    {
      tick: outcome.result.state.tick,
      simTimeMs: outcome.result.state.simTime,
      prngState: serializePrngState(outcome.result.prng),
      cursorWallMs: commit.cursorWallMs,
      paused: commit.paused,
    },
    [outcome],
  );
  if (!committed.ok) {
    return {
      kind: "store-error",
      reason: committed.reason,
      message: committed.message,
    };
  }
  return {
    kind: "committed",
    state: outcome.result.state,
    prng: outcome.result.prng,
    nextQueue: buildRoutineQueue(outcome.result.state),
    events: outcome.result.events.length,
  };
}

// --- Proposal intake ---------------------------------------------------------

/**
 * Checks a legend proposal's `linkedEventId` against the store's committed
 * events before it is ever queued: an unknown id is rejected here, so a
 * legend can only ever commit as verified when its link is real (the world
 * engine itself stays storage-free and never re-checks this).
 */
export function checkLegendIntake(
  db: Database,
  proposal: Proposal,
): RuleRejection | undefined {
  if (proposal.kind !== "legend" || proposal.linkedEventId === undefined) {
    return undefined;
  }
  if (getEventRow(db, proposal.linkedEventId) === undefined) {
    return reject(
      "malformed",
      `legend linkedEventId ${proposal.linkedEventId} does not reference a committed event`,
    );
  }
  return undefined;
}

/** Parses an untrusted proposal payload, then runs the service's own intake checks (currently: legend link validity) that the storage-free world engine cannot run itself. */
export function intakeProposal(db: Database, raw: unknown): SubmitResult {
  const parsed = submitProposal(raw);
  if (!parsed.ok) {
    return parsed;
  }
  const legendRejection = checkLegendIntake(db, parsed.proposal);
  if (legendRejection) {
    return {
      ok: false,
      rejection: {
        reason: legendRejection.reason,
        message: legendRejection.message,
      },
    };
  }
  return parsed;
}
