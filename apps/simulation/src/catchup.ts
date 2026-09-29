// Chunked, cancellable catch-up: applied on start and on resume-from-sleep
// to advance a world whose persisted wall-clock cursor is behind now,
// capped at one hour of missed wall time. Every simulated second still
// runs a full tick through the same routines as live play -- no
// aggregation into a coarse step -- but many ticks are computed in memory
// and committed together as one chunk transaction, so the cursor only
// ever advances at a chunk boundary. Every event a catch-up tick produces
// is marked approximate.
//
// Between chunks, control yields back to the event loop so a concurrent
// HTTP request (e.g. `/pause`) is actually served while a long catch-up
// run is in progress, rather than only after it finishes.

import type {
  CatchUpSummary,
  DegradedReason,
  WorldEvent,
} from "@panthea/contracts";
import {
  type ClockConfig,
  clearCatchUpProgress,
  computeTick,
  readCatchUpProgress,
  readClock,
  writeCatchUpProgress,
} from "@panthea/persistence";
import {
  DEFAULT_TICK_ELAPSED_MS,
  type PrngState,
  type WorldState,
} from "@panthea/world";
import {
  buildRoutineQueue,
  commitWorldTick,
  recordOperatorEvent,
  stepWorldTick,
  type TickDeps,
  type WorldTickOutcome,
} from "./tick";
import { serializePrngState } from "./world-store";

/** Event kinds worth naming in the catch-up summary's `majorOutcomes`. */
const MAJOR_EVENT_KINDS = new Set<string>([
  "building-ignited",
  "building-destroyed",
  "building-repaired",
  "legend-recorded",
]);

export type CatchUpDeps = TickDeps;

export interface CatchUpOptions {
  readonly nowWallMs: number;
  /**
   * Called after each chunk commits and after yielding to the event loop,
   * before the next chunk starts; returning `true` stops catch-up at this
   * boundary (an operator pause request arriving mid-catch-up, checked
   * via a live flag `/pause`'s HTTP handler sets) and persists
   * `paused: true`. Defaults to never stopping early.
   */
  readonly onChunkCommitted?: (progress: {
    readonly appliedMs: number;
    readonly ticksRemaining: number;
  }) => boolean;
}

/** What a catch-up run applied, skipped, and found notable; the service stamps it with the sequence it finished at when it publishes it. */
export type CatchUpOutcome = Omit<CatchUpSummary, "atSequence">;

export interface CatchUpResult {
  readonly summary: CatchUpOutcome;
  readonly state: WorldState;
  readonly prng: PrngState;
  /** Present only when a chunk's own store commit failed; `state`/`prng` reflect the last chunk that *did* commit. */
  readonly degraded?: {
    readonly reason: DegradedReason;
    readonly message: string;
  };
}

/** Yields control to the event loop, giving any pending I/O (an incoming HTTP request in particular) a chance to run before the next chunk starts. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Runs catch-up against `deps.store`'s persisted clock: does nothing if
 * the world is currently paused (paused wall time never becomes
 * catch-up), otherwise applies up to `initialState.rules.catchUpCapMs` of
 * missed wall time in `initialState.rules.catchUpChunkMs`-sized chunks,
 * each committed as one transaction with the cursor advanced inside it. A
 * chunk whose own commit fails (a store write failure) stops catch-up and
 * reports degraded, leaving every prior chunk's commit intact.
 *
 * The cap bounds the remaining backlog, not the total. With cap C, `a`
 * already applied, and `d` of new downtime since, the next run applies
 * min(C, C - a + d): the excess over C is discarded in one commit before
 * any chunk, so a run that dies partway never hands its restart a fresh
 * cap over the same sleep.
 *
 * The backlog's progress (time applied and time discarded so far) is
 * committed in the same transaction as each discard and chunk and cleared
 * when the backlog ends, so a restart continues it and the summary it
 * returns covers the whole backlog, not only this run.
 */
export async function runCatchUp(
  initialState: WorldState,
  initialPrng: PrngState,
  deps: CatchUpDeps,
  options: CatchUpOptions,
): Promise<CatchUpResult> {
  const clock = readClock(deps.store.db);
  if (clock.paused) {
    return {
      summary: { appliedMs: 0, skippedMs: 0, majorOutcomes: [] },
      state: initialState,
      prng: initialPrng,
    };
  }

  const rules = initialState.rules;
  const clockConfig: ClockConfig = { catchUpCapMs: rules.catchUpCapMs };
  const {
    appliedMs: totalAppliedMs,
    skippedMs: excessMs,
    newCursor: sampledNowCursor,
  } = computeTick(clock, options.nowWallMs, clockConfig);

  // Progress a previous run committed for this same backlog, if it did not
  // finish. Zero otherwise.
  const prior = readCatchUpProgress(deps.store.db);
  const priorAppliedMs = prior?.appliedMs ?? 0;
  let discardedMs = prior?.discardedMs ?? 0;

  // A remainder shorter than one tick is below the simulation's resolution:
  // it is neither applied nor reported as skipped, so a gap of a few
  // milliseconds (every restart has one) is "nothing happened".
  const tickMs = DEFAULT_TICK_ELAPSED_MS;
  const totalTicks = Math.floor(totalAppliedMs / tickMs);

  if (totalTicks === 0) {
    if (!prior) {
      return {
        summary: { appliedMs: 0, skippedMs: 0, majorOutcomes: [] },
        state: initialState,
        prng: initialPrng,
      };
    }
    // The previous run applied everything but died before ending the
    // backlog. End it now and report what it committed.
    const finish = commitWorldTick(
      deps,
      [],
      {
        tick: initialState.tick,
        simTimeMs: initialState.simTime,
        prngState: serializePrngState(initialPrng),
        cursorWallMs: clock.cursorWallMs,
        paused: false,
      },
      [],
      clearCatchUpProgress,
    );
    return {
      summary: {
        appliedMs: priorAppliedMs,
        skippedMs: discardedMs,
        majorOutcomes: [],
      },
      state: initialState,
      prng: initialPrng,
      ...(finish.ok
        ? {}
        : { degraded: { reason: finish.reason, message: finish.message } }),
    };
  }

  let cursorWallMs = clock.cursorWallMs;
  if (excessMs > 0) {
    // The gap is longer than the cap. Discard the excess in its own commit,
    // before any chunk.
    const discardedCursor = cursorWallMs + excessMs;
    const discard = commitWorldTick(
      deps,
      [],
      {
        tick: initialState.tick,
        simTimeMs: initialState.simTime,
        prngState: serializePrngState(initialPrng),
        cursorWallMs: discardedCursor,
        paused: false,
      },
      [],
      (db) => {
        recordOperatorEvent(`catch-up-discard:${excessMs}`)(db);
        writeCatchUpProgress(db, {
          appliedMs: priorAppliedMs,
          discardedMs: discardedMs + excessMs,
        });
      },
    );
    if (!discard.ok) {
      return {
        summary: {
          appliedMs: priorAppliedMs,
          skippedMs: discardedMs,
          majorOutcomes: [],
        },
        state: initialState,
        prng: initialPrng,
        degraded: { reason: discard.reason, message: discard.message },
      };
    }
    cursorWallMs = discardedCursor;
    discardedMs += excessMs;
  }

  const chunkTicks = Math.max(1, Math.floor(rules.catchUpChunkMs / tickMs));

  let committedState = initialState;
  let committedPrng = initialPrng;
  let ticksDone = 0;
  let pausedMidCatchUp = false;
  const majorOutcomes: string[] = [];

  // What the backlog has committed so far. A run that stops because a
  // commit failed reports exactly this: a restart still applies the rest,
  // so nothing more is skipped. Once paused, the chunks it will not apply
  // are discarded for good and count as skipped.
  const committedSummary = (): CatchUpOutcome => ({
    appliedMs: priorAppliedMs + ticksDone * tickMs,
    skippedMs: discardedMs,
    majorOutcomes,
  });

  while (ticksDone < totalTicks) {
    const ticksThisChunk = Math.min(chunkTicks, totalTicks - ticksDone);

    let workingState = committedState;
    let workingPrng = committedPrng;
    let workingQueue = buildRoutineQueue(workingState);
    const chunkOutcomes: WorldTickOutcome[] = [];
    let chunkEvents: WorldEvent[] = [];

    for (let i = 0; i < ticksThisChunk; i += 1) {
      const outcome = stepWorldTick(workingState, workingPrng, workingQueue, {
        approximate: true,
      });
      chunkOutcomes.push(outcome);
      chunkEvents = [...chunkEvents, ...outcome.result.events];
      workingState = outcome.result.state;
      workingPrng = outcome.result.prng;
      workingQueue = buildRoutineQueue(workingState);
    }

    const newCursorWallMs = cursorWallMs + ticksThisChunk * tickMs;
    const commit = commitWorldTick(
      deps,
      chunkEvents,
      {
        tick: workingState.tick,
        simTimeMs: workingState.simTime,
        prngState: serializePrngState(workingPrng),
        cursorWallMs: newCursorWallMs,
        paused: false,
      },
      chunkOutcomes,
      (db) =>
        writeCatchUpProgress(db, {
          appliedMs: priorAppliedMs + (ticksDone + ticksThisChunk) * tickMs,
          discardedMs,
        }),
    );

    if (!commit.ok) {
      return {
        summary: committedSummary(),
        state: committedState,
        prng: committedPrng,
        degraded: { reason: commit.reason, message: commit.message },
      };
    }

    for (const outcome of chunkOutcomes) {
      for (const record of outcome.result.committed) {
        for (const event of record.events) {
          if (MAJOR_EVENT_KINDS.has(event.kind)) {
            majorOutcomes.push(`${event.kind}:${String(event.entityId)}`);
          }
        }
      }
    }

    committedState = workingState;
    committedPrng = workingPrng;
    cursorWallMs = newCursorWallMs;
    ticksDone += ticksThisChunk;

    if (ticksDone < totalTicks) {
      await yieldToEventLoop();
    }

    if (
      ticksDone < totalTicks &&
      options.onChunkCommitted?.({
        appliedMs: priorAppliedMs + ticksDone * tickMs,
        ticksRemaining: totalTicks - ticksDone,
      })
    ) {
      // Persists the pause, alongside the cursor already advanced
      // through the last committed chunk, and its operator observation
      // in the same transaction -- through the same `commitWorldTick`
      // `onCommitted` path `/pause` itself uses (`recordOperatorEvent`),
      // so a trace failure here rolls the pause transition back exactly
      // like it would for a live `/pause` request, rather than being
      // swallowed. The backlog ends here: the remainder is discarded.
      const pauseCommit = commitWorldTick(
        deps,
        [],
        {
          tick: committedState.tick,
          simTimeMs: committedState.simTime,
          prngState: serializePrngState(committedPrng),
          cursorWallMs,
          paused: true,
        },
        [],
        (db) => {
          recordOperatorEvent("pause")(db);
          clearCatchUpProgress(db);
        },
      );
      if (!pauseCommit.ok) {
        return {
          summary: committedSummary(),
          state: committedState,
          prng: committedPrng,
          degraded: {
            reason: pauseCommit.reason,
            message: pauseCommit.message,
          },
        };
      }
      pausedMidCatchUp = true;
      break;
    }
  }

  if (!pausedMidCatchUp) {
    // Every tick this call could apply is now committed. Jump the
    // persisted cursor the rest of the way to the sampled wall time
    // (matching what `computeTick` itself would have persisted for an
    // ordinary, uncapped tick), dropping the sub-tick remainder so it does
    // not look like still-missed time to whatever calls catch-up next, and
    // end the backlog.
    const adjust = commitWorldTick(
      deps,
      [],
      {
        tick: committedState.tick,
        simTimeMs: committedState.simTime,
        prngState: serializePrngState(committedPrng),
        cursorWallMs: sampledNowCursor,
        paused: false,
      },
      [],
      clearCatchUpProgress,
    );
    if (!adjust.ok) {
      return {
        summary: committedSummary(),
        state: committedState,
        prng: committedPrng,
        degraded: { reason: adjust.reason, message: adjust.message },
      };
    }
  }

  return {
    summary: {
      ...committedSummary(),
      skippedMs: pausedMidCatchUp
        ? discardedMs + (totalTicks - ticksDone) * tickMs
        : discardedMs,
    },
    state: committedState,
    prng: committedPrng,
  };
}
