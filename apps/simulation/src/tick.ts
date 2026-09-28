// The per-tick scheduling step: revalidate and commit a queue of
// proposals in one store transaction, record every observation and
// outcome to the causal trace, then decide the routine proposals for the
// next tick from the newly committed state (Key Technical Decisions'
// "Scheduling"). `stepWorldTick`/`commitWorldTick`/`traceWorldTick` are
// exported separately so catchup.ts can run several ticks purely in
// memory and commit them together as one chunk transaction, while the
// live 1 Hz loop (wired in the service entrypoint) commits one tick at a
// time through `applyOneTick`.

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
  getEventRow,
  type ProjectionReducers,
  commitTick as persistCommitTick,
  type Store,
} from "@panthea/persistence";
import {
  createProposalId,
  type ProposalId,
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
  type WorldState,
} from "@panthea/world";
import { serializePrngState } from "./world-store";

/**
 * Convenience default for the per-tick proposal cap ("Proposal intake:
 * ... per-tick counts above a configured cap are rejected", Key Technical
 * Decisions). Not read implicitly -- callers pass it (or their own value)
 * explicitly via `TickDeps.maxProposalsPerTick`.
 */
export const DEFAULT_MAX_PROPOSALS_PER_TICK = 100;

export interface QueuedProposal {
  readonly id: ProposalId;
  readonly proposal: Proposal;
  readonly observation: ObservationRecord;
}

export interface TickDeps {
  readonly store: Store;
  readonly reducers: ProjectionReducers<WorldState>;
  readonly traceDb: Database;
  readonly maxProposalsPerTick?: number;
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

export interface StepOptions {
  readonly maxProposalsPerTick?: number;
  readonly elapsedMs?: number;
  readonly approximate?: boolean;
}

export interface WorldTickOutcome {
  readonly result: ReturnType<typeof runTick>;
  readonly admitted: readonly QueuedProposal[];
  readonly overflow: readonly QueuedProposal[];
}

/**
 * Runs one world tick purely in memory: proposals beyond
 * `maxProposalsPerTick` never reach the world engine (over-limit),
 * everything else is revalidated and committed sequentially by
 * `runTick`. No store or trace I/O -- `commitWorldTick`/`traceWorldTick`
 * do that, separately, so a caller can run several ticks before
 * committing any of them (catchup.ts's chunking).
 */
export function stepWorldTick(
  state: WorldState,
  prng: PrngState,
  queue: readonly QueuedProposal[],
  options: StepOptions = {},
): WorldTickOutcome {
  const cap = options.maxProposalsPerTick ?? DEFAULT_MAX_PROPOSALS_PER_TICK;
  const admitted = queue.slice(0, cap);
  const overflow = queue.slice(cap);
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

/** Commits `events` in one store transaction. A thrown error (a store write failure, including `SQLITE_FULL`) is reported, never thrown -- nothing partially commits either way, since `commitTick` itself is one transaction. */
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
): CommitOutcome {
  const commit = deps.commitTick ?? persistCommitTick;
  try {
    commit(deps.store, deps.reducers, { events, ...commitOptions });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: classifyStoreError(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Records every queued proposal's observation and outcome (committed, rejected, or over-limit) to the trace -- called only after the tick's events are actually committed, so trace rows never outlive a rolled-back transaction. */
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
    const firstEvent = record.events[0];
    recordProposalOutcome(traceDb, {
      proposalId: queued.id,
      observationId: queued.observation.id,
      correlationId: toCorrelationId(String(queued.observation.id)),
      causationId: toCausationId(String(queued.observation.id)),
      proposal: record.proposal,
      outcome: "committed",
      ...(firstEvent ? { eventId: firstEvent.id } : {}),
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

/** One live tick: `stepWorldTick` + `commitWorldTick` + `traceWorldTick`, in that order -- trace is only ever written for a tick that actually committed. */
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
    maxProposalsPerTick: deps.maxProposalsPerTick,
    elapsedMs: commit.elapsedMs,
    approximate: commit.approximate,
  });
  const committed = commitWorldTick(deps, outcome.result.events, {
    tick: outcome.result.state.tick,
    simTimeMs: outcome.result.state.simTime,
    prngState: serializePrngState(outcome.result.prng),
    cursorWallMs: commit.cursorWallMs,
    paused: commit.paused,
  });
  if (!committed.ok) {
    return {
      kind: "store-error",
      reason: committed.reason,
      message: committed.message,
    };
  }
  traceWorldTick(deps.traceDb, outcome);
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
