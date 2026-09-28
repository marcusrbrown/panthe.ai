// Chunked, cancellable catch-up: applied on start and on resume-from-sleep
// to advance a world whose persisted wall-clock cursor is behind now,
// capped at one hour of missed wall time (Key Technical Decisions,
// "Time"). Every simulated second still runs a full tick through the same
// routines as live play -- no aggregation into a coarse step -- but many
// ticks are computed in memory and committed together as one chunk
// transaction, so the cursor only ever advances at a chunk boundary. Every
// event a catch-up tick produces is marked approximate.

import type {
  CatchUpSummary,
  DegradedReason,
  WorldEvent,
} from "@panthea/contracts";
import { type ClockConfig, computeTick, readClock } from "@panthea/persistence";
import {
  DEFAULT_TICK_ELAPSED_MS,
  type PrngState,
  type WorldState,
} from "@panthea/world";
import {
  buildRoutineQueue,
  commitWorldTick,
  stepWorldTick,
  type TickDeps,
  traceWorldTick,
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
   * Called after each chunk commits, before the next one starts; returning
   * `true` stops catch-up at this boundary (an operator pause request
   * arriving mid-catch-up) and persists `paused: true`. Defaults to never
   * stopping early.
   */
  readonly onChunkCommitted?: (progress: {
    readonly appliedMs: number;
    readonly ticksRemaining: number;
  }) => boolean;
}

export interface CatchUpResult {
  readonly summary: CatchUpSummary;
  readonly state: WorldState;
  readonly prng: PrngState;
  /** Present only when a chunk's own store commit failed; `state`/`prng` reflect the last chunk that *did* commit. */
  readonly degraded?: {
    readonly reason: DegradedReason;
    readonly message: string;
  };
}

/**
 * Runs catch-up against `deps.store`'s persisted clock: does nothing if
 * the world is currently paused (paused wall time never becomes
 * catch-up), otherwise applies up to `initialState.rules.catchUpCapMs` of
 * missed wall time in `initialState.rules.catchUpChunkMs`-sized chunks,
 * each committed as one transaction with the cursor advanced inside it. A
 * chunk whose own commit fails (a store write failure) stops catch-up and
 * reports degraded, leaving every prior chunk's commit intact.
 */
export function runCatchUp(
  initialState: WorldState,
  initialPrng: PrngState,
  deps: CatchUpDeps,
  options: CatchUpOptions,
): CatchUpResult {
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
  const { appliedMs: totalAppliedMs, skippedMs: capSkippedMs } = computeTick(
    clock,
    options.nowWallMs,
    clockConfig,
  );

  const tickMs = DEFAULT_TICK_ELAPSED_MS;
  const totalTicks = Math.floor(totalAppliedMs / tickMs);
  const leftoverMs = totalAppliedMs - totalTicks * tickMs;

  if (totalTicks === 0) {
    return {
      summary: {
        appliedMs: 0,
        skippedMs: capSkippedMs + leftoverMs,
        majorOutcomes: [],
      },
      state: initialState,
      prng: initialPrng,
    };
  }

  const chunkTicks = Math.max(1, Math.floor(rules.catchUpChunkMs / tickMs));

  let committedState = initialState;
  let committedPrng = initialPrng;
  let cursorWallMs = clock.cursorWallMs;
  let ticksDone = 0;
  const majorOutcomes: string[] = [];

  const remainingSkippedMs = (): number =>
    (totalTicks - ticksDone) * tickMs + capSkippedMs + leftoverMs;

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
    const commit = commitWorldTick(deps, chunkEvents, {
      tick: workingState.tick,
      simTimeMs: workingState.simTime,
      prngState: serializePrngState(workingPrng),
      cursorWallMs: newCursorWallMs,
      paused: false,
    });

    if (!commit.ok) {
      return {
        summary: {
          appliedMs: ticksDone * tickMs,
          skippedMs: remainingSkippedMs(),
          majorOutcomes,
        },
        state: committedState,
        prng: committedPrng,
        degraded: { reason: commit.reason, message: commit.message },
      };
    }

    for (const outcome of chunkOutcomes) {
      traceWorldTick(deps.traceDb, outcome);
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

    if (
      ticksDone < totalTicks &&
      options.onChunkCommitted?.({
        appliedMs: ticksDone * tickMs,
        ticksRemaining: totalTicks - ticksDone,
      })
    ) {
      // Best-effort: persists the pause alongside the cursor already
      // advanced through the last committed chunk. A failure here doesn't
      // change the outcome already committed above -- catch-up still
      // stops, just without this bookkeeping commit.
      commitWorldTick(deps, [], {
        tick: committedState.tick,
        simTimeMs: committedState.simTime,
        prngState: serializePrngState(committedPrng),
        cursorWallMs,
        paused: true,
      });
      break;
    }
  }

  return {
    summary: {
      appliedMs: ticksDone * tickMs,
      skippedMs: remainingSkippedMs(),
      majorOutcomes,
    },
    state: committedState,
    prng: committedPrng,
  };
}
