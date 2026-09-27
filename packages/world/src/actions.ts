// The action queue and tick scheduler: proposal intake (parsing untrusted
// fixture/routine payloads), one tick's sequential revalidate-then-commit
// pass over a queue (Key Technical Decisions' scheduling model), and the
// event-reducer registry that projects committed events back onto
// `WorldState` -- the same registry a rebuild routine (packages/persistence,
// Unit 2) replays the whole log through, and the mechanism a
// rebuild-equals-live test exercises directly.
//
// "Each tick drains the previous tick's queue, revalidates and commits
// eligible proposals, then routines enqueue proposals for the next tick.
// Nothing observes uncommitted same-tick effects" -- `runTick` revalidates
// each proposal against the state as committed so far *within this tick*,
// so a later proposal in the same queue sees an earlier one's effects.
//
// Determinism: `runTick` never reads the wall clock or `Math.random`. Event
// ids, correlation ids, and causation ids are derived deterministically from
// the tick counter, the proposal's sequence position, and its
// `observationId` -- never from `crypto.randomUUID()` -- so two runs given
// the same state, PRNG state, and proposal queue produce byte-identical
// output.

import {
  type CausationId,
  type CorrelationId,
  type EntityId,
  type EventId,
  LATEST_EVENT_SCHEMA_VERSION,
  type ParseResult,
  type Proposal,
  parseCausationId,
  parseCorrelationId,
  parseEventId,
  parseProposal,
  type RejectionReasonCode,
  type WorldEvent,
} from "@panthea/contracts";
import type { PrngState, WorldEventDraft, WorldState } from "./state";
import type { RuleRegistry } from "./validate";

// --- Event reducers ----------------------------------------------------------

export type Reducer<E extends WorldEvent = WorldEvent> = (
  state: WorldState,
  event: E,
) => WorldState;

export interface ReducerRegistry {
  register<K extends WorldEvent["kind"]>(
    kind: K,
    reducer: Reducer<Extract<WorldEvent, { kind: K }>>,
  ): void;
  get(kind: WorldEvent["kind"]): Reducer | undefined;
  /** Applies one committed event, via its registered reducer, to `state`. */
  apply(state: WorldState, event: WorldEvent): WorldState;
  /**
   * Applies an ordered event stream to `state`, in order. Given the same
   * initial state this reproduces exactly what live tick-by-tick commits
   * produced -- the rebuild-equals-live guarantee persistence relies on.
   */
  applyAll(state: WorldState, events: readonly WorldEvent[]): WorldState;
}

export function createReducerRegistry(): ReducerRegistry {
  const reducers = new Map<WorldEvent["kind"], Reducer>();

  const registry: ReducerRegistry = {
    register(kind, reducer) {
      reducers.set(kind, reducer as Reducer);
    },
    get(kind) {
      return reducers.get(kind);
    },
    apply(state, event) {
      const reducer = reducers.get(event.kind);
      if (!reducer) {
        throw new Error(`no reducer registered for event kind: ${event.kind}`);
      }
      return reducer(state, event);
    },
    applyAll(state, events) {
      return events.reduce((acc, event) => registry.apply(acc, event), state);
    },
  };
  return registry;
}

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
 * Builds a registry with Unit 3's reducers (entity-moved,
 * realm-transitioned) already registered. Later units register reducers
 * for their own event kinds on the same registry instance.
 */
export function createDefaultReducerRegistry(): ReducerRegistry {
  const registry = createReducerRegistry();
  registry.register("entity-moved", (state, event) =>
    moveActor(state, event.entityId, event.to),
  );
  registry.register("realm-transitioned", (state, event) =>
    moveActor(state, event.entityId, event.to),
  );
  return registry;
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
 * operator or model request) through packages/contracts' proposal parser.
 * A malformed payload never reaches the queue and never touches
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
   * The PRNG state to persist and pass into the next tick. Unit 3's own
   * rule handlers (move, realm-transition, claim) draw no randomness, so
   * this is currently always identical to the `prng` passed in; the pipeline
   * threads it through now so a later unit's handler (fire spread, routine
   * choice) can consume and advance it without a signature change here.
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

function mustParse<T>(
  parser: (value: unknown, path: string) => ParseResult<T>,
  raw: string,
  path: string,
): T {
  const result = parser(raw, path);
  if (!result.ok) {
    throw new Error(
      `internal: failed to construct ${path} from "${raw}": ${result.message}`,
    );
  }
  return result.value;
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
  const id: EventId = mustParse(
    parseEventId,
    `evt-${meta.tick}-${meta.sequence}`,
    "id",
  );
  // Correlation and causation both trace back to the observation that
  // caused the proposal: Unit 3 does not yet have a richer causal-chain
  // model (that is Unit 2/6's trace store), so every event this proposal
  // produces shares one correlation id rooted at its cause.
  const correlationId: CorrelationId = mustParse(
    parseCorrelationId,
    String(meta.observationId),
    "correlationId",
  );
  const causationId: CausationId = mustParse(
    parseCausationId,
    String(meta.observationId),
    "causationId",
  );
  return {
    ...draft,
    schemaVersion: LATEST_EVENT_SCHEMA_VERSION,
    id,
    sequence: meta.sequence,
    simTime: meta.simTime,
    correlationId,
    causationId,
    approximate: meta.approximate,
  } as WorldEvent;
}

/**
 * Runs one tick: advances the clock, then revalidates and commits `queue`
 * sequentially against the state as committed so far within this tick, so
 * a later proposal observes an earlier one's effects (same-tick
 * double-spend is therefore impossible by construction). A rejection never
 * touches `state`; only a successful commit's events are applied, through
 * `reducers`.
 *
 * An actor that already committed a non-claim proposal earlier in this
 * same tick is rejected as `busy-actor` for any further non-claim proposal
 * in the same tick -- claims never commit and are exempt, since they never
 * hold a resource.
 */
export function runTick(
  state: WorldState,
  prng: PrngState,
  rules: RuleRegistry,
  reducers: ReducerRegistry,
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
  let sequence = 0;

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

    const outcome = rules.validateProposal(working, proposal);
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

    working = reducers.applyAll(working, events);
    committed.push({ proposal, events });
    if (proposal.kind !== "claim") {
      committedActorsThisTick.add(proposal.actor);
    }
  }

  return { state: working, prng, committed, rejected };
}
