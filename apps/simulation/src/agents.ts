// The god turn runner: gives each god an occasional turn without touching the
// tick. A turn snapshots the last committed state, awaits the model outside
// any transaction (`runGodTurn`), then journals the resulting proposal through
// the same durable intake as `/proposals`, in-process with source `model`. The
// tick admits and consumes it like any other external proposal, revalidating
// it against the world as it is by then.
//
// The journal is the only durable record of a turn. A god with a pending
// journal entry gets no new turn, so a restart needs no turn identity: a turn
// killed before it journaled is simply asked again, and one killed after runs
// once from the journal.

import {
  type GodTurnDeps,
  type GodTurnResult,
  runGodTurn,
} from "@panthea/agents";
import { type EntityId, UNPLACED_EVENT_KINDS } from "@panthea/contracts";
import {
  insertExternalProposal,
  listEvents,
  readPendingExternalProposals,
  type Store,
} from "@panthea/persistence";
import { createProposalId, recordModelRequest } from "@panthea/telemetry";
import type { WorldState } from "@panthea/world";
import {
  RECENT_EVENT_CAP,
  reportModelOutcome,
  type ServiceStatusRef,
} from "./server";
import { intakeProposal } from "./tick";

/**
 * The lifecycle seam: what the service says about itself that decides whether
 * a turn may start. Dispatch asks; it never infers from frames or from where
 * it was called.
 */
export interface Lifecycle {
  /** The catch-up run at startup has finished. */
  startupCatchUpComplete(): boolean;
  /** Any catch-up run, startup or after sleep, is in progress. */
  catchUpRunning(): boolean;
  /** The world is paused: no new turn starts. A turn already in flight still journals. */
  paused(): boolean;
}

export interface GodTurnRunnerDeps extends GodTurnDeps {
  readonly store: Store;
  /** The last committed state; read when a turn starts. */
  readonly getState: () => WorldState;
  readonly lifecycle: Lifecycle;
  readonly statusRef: ServiceStatusRef;
  readonly onLog?: (message: string) => void;
}

export interface GodTurnRunner {
  /** Starts a turn when the lifecycle allows one, none is in flight, and a god is eligible. Returns at once whether or not it did; it never awaits inference. */
  dispatch(): boolean;
  inFlight(): boolean;
  /** Resolves when no turn is in flight. */
  idle(): Promise<void>;
  /** Abandons the turn in flight: nothing more is journaled. */
  stop(): void;
}

/** The actors with a pending journal entry: they have a proposal waiting and get no new turn. */
function actorsWithPendingProposals(store: Store): ReadonlySet<string> {
  const actors = new Set<string>();
  for (const entry of readPendingExternalProposals(
    store.db,
    Number.MAX_SAFE_INTEGER,
  )) {
    const actor = (entry.proposal as { actor?: unknown } | null)?.actor;
    if (typeof actor === "string") actors.add(actor);
  }
  return actors;
}

export function createGodTurnRunner(deps: GodTurnRunnerDeps): GodTurnRunner {
  const log = deps.onLog ?? (() => {});
  let running: Promise<void> | undefined;
  let abort: AbortController | undefined;
  /** The god served last: the next turn goes to the next eligible god after it. */
  let lastServed: string | undefined;

  function nextGod(state: WorldState): EntityId | undefined {
    const pending = actorsWithPendingProposals(deps.store);
    const eligible = [...state.actors.values()]
      .filter(
        (actor) =>
          actor.isDeity === true &&
          actor.alive &&
          deps.profiles.has(actor.id) &&
          !pending.has(actor.id),
      )
      .map((actor) => actor.id)
      .sort();
    return (
      eligible.find((god) => lastServed === undefined || god > lastServed) ??
      eligible[0]
    );
  }

  /** Records the request, then journals the proposal: a committed proposal always has its request, and a crash between the two leaves at worst a request with no proposal. */
  function conclude(result: GodTurnResult): void {
    reportModelOutcome(deps.statusRef, result.request.route);
    const db = deps.store.db;
    if (result.kind !== "proposal") {
      recordModelRequest(db, result.request);
      return;
    }
    const intake = intakeProposal(db, result.proposal);
    if (!intake.ok) {
      recordModelRequest(db, result.request);
      log(`god turn refused at intake: ${intake.rejection.message}`);
      return;
    }
    const proposalId = createProposalId();
    recordModelRequest(db, { ...result.request, proposalId });
    insertExternalProposal(db, {
      proposalId,
      proposal: intake.proposal,
      observation: result.observation,
    });
  }

  async function turn(god: EntityId, state: WorldState, signal: AbortSignal) {
    const recentEvents = listEvents(deps.store.db, {
      toSequence: state.lastSequence,
      excludeKinds: UNPLACED_EVENT_KINDS,
      newest: RECENT_EVENT_CAP,
    });
    try {
      const result = await runGodTurn(deps, {
        state,
        actorId: god,
        recentEvents,
        signal,
      });
      if (result && !signal.aborted) conclude(result);
    } catch (error) {
      log(
        `god turn for ${god} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    dispatch() {
      const { lifecycle } = deps;
      if (
        running !== undefined ||
        !lifecycle.startupCatchUpComplete() ||
        lifecycle.catchUpRunning() ||
        lifecycle.paused()
      ) {
        return false;
      }
      const state = deps.getState();
      const god = nextGod(state);
      if (god === undefined) return false;
      lastServed = god;
      abort = new AbortController();
      running = turn(god, state, abort.signal).finally(() => {
        running = undefined;
        abort = undefined;
      });
      return true;
    },
    inFlight: () => running !== undefined,
    idle: async () => {
      await running;
    },
    stop() {
      abort?.abort();
    },
  };
}
