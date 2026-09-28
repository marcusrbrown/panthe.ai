// The action queue and tick scheduler: proposal intake (parsing untrusted
// fixture/routine payloads), one tick's sequential revalidate-then-commit
// pass over a queue, and `applyEvent`/`applyEvents`, which project
// committed events back onto `WorldState` -- the same functions a rebuild
// routine (packages/persistence) replays the whole log through, and the
// mechanism a rebuild-equals-live test exercises directly.
//
// Each tick revalidates and commits eligible proposals against the state
// as committed so far *within this tick*, so a later proposal in the same
// queue sees an earlier one's effects; same-tick double-spend is
// impossible by construction.
//
// Determinism: `runTick` never reads the wall clock or `Math.random`.
// Event ids, correlation ids, and causation ids are derived
// deterministically from the tick counter, the proposal's sequence
// position, and its `observationId` -- never from `crypto.randomUUID()` --
// so two runs given the same state, PRNG state, and proposal queue
// produce byte-identical output.

import {
  type CausationId,
  type CorrelationId,
  type EntityId,
  type EventId,
  LATEST_EVENT_SCHEMA_VERSION,
  type Proposal,
  parseProposal,
  type RejectionReasonCode,
  type WorldEvent,
} from "@panthea/contracts";
import {
  applyRecipe,
  creditActorInventory,
  debitActorInventory,
  transferBetweenActors,
} from "./economy";
import type { PrngState, WorldEventDraft, WorldState } from "./state";
import { validateProposal } from "./validate";

/** Moves an actor to `to`, bumping the actor's and both locations' revisions. */
function moveActor(
  state: WorldState,
  entityId: EntityId,
  to: EntityId,
): WorldState {
  const actor = state.actors.get(entityId);
  if (!actor) return state;

  const actors = new Map(state.actors);
  actors.set(entityId, {
    ...actor,
    locationId: to,
    revision: actor.revision + 1,
  });

  const locations = new Map(state.locations);
  const from = state.locations.get(actor.locationId);
  if (from) {
    locations.set(from.id, { ...from, revision: from.revision + 1 });
  }
  const destination = state.locations.get(to);
  if (destination) {
    locations.set(to, { ...destination, revision: destination.revision + 1 });
  }

  return { ...state, actors, locations };
}

/**
 * Applies one committed event to `state`, advancing the world-global
 * sequence cursor to the event's own `sequence` regardless of kind.
 * Replaying an event log from an initial state through repeated calls
 * (`applyEvents`) reproduces exactly what live tick-by-tick commits
 * produced -- the rebuild-equals-live guarantee persistence relies on.
 */
export function applyEvent(state: WorldState, event: WorldEvent): WorldState {
  let next: WorldState;
  switch (event.kind) {
    case "entity-moved":
      next = moveActor(state, event.entityId, event.to);
      break;
    case "realm-transitioned":
      next = moveActor(state, event.entityId, event.to);
      break;
    case "resource-gathered":
      next = creditActorInventory(
        state,
        event.entityId,
        event.resource,
        event.amount,
      );
      break;
    case "resource-produced": {
      const recipe = state.recipes[event.output];
      next = recipe
        ? applyRecipe(state, event.entityId, recipe, event.quantity)
        : state;
      break;
    }
    case "resource-traded":
      next = transferBetweenActors(
        state,
        event.entityId,
        event.counterpartyId,
        event.give,
        event.receive,
      );
      break;
    case "resource-consumed":
      next = debitActorInventory(
        state,
        event.entityId,
        event.resource,
        event.amount,
      );
      break;
    default: {
      const exhaustiveCheck: never = event;
      throw new Error(
        `no reducer for event kind: ${(exhaustiveCheck as WorldEvent).kind}`,
      );
    }
  }
  return { ...next, lastSequence: event.sequence };
}

/** Applies an ordered event stream to `state`, in order. */
export function applyEvents(
  state: WorldState,
  events: readonly WorldEvent[],
): WorldState {
  return events.reduce(applyEvent, state);
}

// --- Proposal intake ---------------------------------------------------------

export interface ProposalRejection {
  readonly reason: RejectionReasonCode;
  readonly message: string;
}

export type SubmitResult =
  | { readonly ok: true; readonly proposal: Proposal }
  | { readonly ok: false; readonly rejection: ProposalRejection };

/**
 * Parses an untrusted raw payload (a fixture file, a routine's output, an
 * operator request) through packages/contracts' proposal parser. A
 * malformed payload never reaches the queue and never touches
 * `WorldState`: it is rejected here, before `runTick` runs at all.
 */
export function submitProposal(raw: unknown): SubmitResult {
  const result = parseProposal(raw);
  if (!result.ok) {
    return {
      ok: false,
      rejection: {
        reason: result.reason,
        message: result.path
          ? `${result.path}: ${result.message}`
          : result.message,
      },
    };
  }
  return { ok: true, proposal: result.value };
}

// --- Tick scheduling ----------------------------------------------------------

export interface RejectedRecord {
  readonly proposal: Proposal;
  readonly reason: RejectionReasonCode;
  readonly message: string;
}

export interface CommittedRecord {
  readonly proposal: Proposal;
  readonly events: readonly WorldEvent[];
}

export interface TickResult {
  readonly state: WorldState;
  /**
   * The PRNG state to persist and pass into the next tick. The built-in
   * handlers (move, realm-transition, claim) draw no randomness, so this
   * is currently always identical to the `prng` passed in; the pipeline
   * threads it through so a handler that does draw randomness can consume
   * and advance it without a signature change here.
   */
  readonly prng: PrngState;
  readonly committed: readonly CommittedRecord[];
  readonly rejected: readonly RejectedRecord[];
}

export interface TickOptions {
  /** Simulated milliseconds this tick advances by. Default 1000 (1 Hz, 1 wall second = 1 sim second). */
  readonly elapsedMs?: number;
  /** Marks every event this tick commits as approximate (catch-up coarse steps). Default false. */
  readonly approximate?: boolean;
}

export const DEFAULT_TICK_ELAPSED_MS = 1000;

/** Brands a deterministically-built id string; the caller already knows it is well-formed. */
function toEventId(raw: string): EventId {
  return raw as EventId;
}

function toCorrelationId(raw: string): CorrelationId {
  return raw as CorrelationId;
}

function toCausationId(raw: string): CausationId {
  return raw as CausationId;
}

function completeEvent(
  draft: WorldEventDraft,
  meta: {
    readonly tick: number;
    readonly sequence: number;
    readonly simTime: number;
    readonly observationId: string;
    readonly approximate: boolean;
  },
): WorldEvent {
  // Correlation and causation both trace back to the observation that
  // caused the proposal: every event this proposal produces shares one
  // correlation id rooted at its cause.
  return {
    ...draft,
    schemaVersion: LATEST_EVENT_SCHEMA_VERSION,
    id: toEventId(`evt-${meta.tick}-${meta.sequence}`),
    sequence: meta.sequence,
    simTime: meta.simTime,
    correlationId: toCorrelationId(meta.observationId),
    causationId: toCausationId(meta.observationId),
    approximate: meta.approximate,
  } as WorldEvent;
}

/**
 * Runs one tick: advances the clock, then revalidates and commits `queue`
 * sequentially against the state as committed so far within this tick, so
 * a later proposal observes an earlier one's effects. A rejection never
 * touches `state`; only a successful commit's events are applied.
 *
 * An actor that already committed a non-claim proposal earlier in this
 * same tick is rejected as `busy-actor` for any further non-claim proposal
 * in the same tick -- claims never commit and are exempt, since they never
 * hold a resource.
 */
export function runTick(
  state: WorldState,
  prng: PrngState,
  queue: readonly Proposal[],
  options: TickOptions = {},
): TickResult {
  const elapsedMs = options.elapsedMs ?? DEFAULT_TICK_ELAPSED_MS;
  const approximate = options.approximate ?? false;

  let working: WorldState = {
    ...state,
    tick: state.tick + 1,
    simTime: state.simTime + elapsedMs,
  };

  const committed: CommittedRecord[] = [];
  const rejected: RejectedRecord[] = [];
  const committedActorsThisTick = new Set<EntityId>();
  // Sequence numbers are global and contiguous across the whole world's
  // history, not per tick (packages/persistence's `commitTick` requires
  // this). Seed from `working.lastSequence`, which starts this tick equal
  // to whatever the last committed tick (or a restored state) left it at.
  let sequence = working.lastSequence;

  for (const proposal of queue) {
    if (
      proposal.kind !== "claim" &&
      committedActorsThisTick.has(proposal.actor)
    ) {
      rejected.push({
        proposal,
        reason: "busy-actor",
        message: `${proposal.actor} already committed an action this tick`,
      });
      continue;
    }

    const outcome = validateProposal(working, proposal);
    if (!outcome.ok) {
      rejected.push({
        proposal,
        reason: outcome.reason,
        message: outcome.message,
      });
      continue;
    }

    const events = outcome.events.map((draft) => {
      sequence += 1;
      return completeEvent(draft, {
        tick: working.tick,
        sequence,
        simTime: working.simTime,
        observationId: String(proposal.observationId),
        approximate,
      });
    });

    working = applyEvents(working, events);
    committed.push({ proposal, events });
    if (proposal.kind !== "claim") {
      committedActorsThisTick.add(proposal.actor);
    }
  }

  return { state: working, prng, committed, rejected };
}
