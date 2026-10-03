// The chunk loop of `runCatchUp` (apps/simulation/src/catchup.ts) for the one
// shape the benchmark runs, a fresh backlog of a whole number of chunks with
// no excess and no pause, written out here with a clock around each of its
// steps. It calls the same exported functions in the same order, so it does the
// same work; `mirror.test.ts` holds it to that by requiring the same event
// stream as the real function. The real function stays the source of the
// headline numbers (`runEndToEnd`), and this is only for the split.

import {
  getCurrentSequence,
  readClock,
  writeCatchUpProgress,
} from "@panthea/persistence";
import { DEFAULT_TICK_ELAPSED_MS, type PrngState } from "@panthea/world";
import { closeCatchUpBacklog } from "../../../../apps/simulation/src/catchup-summary";
import {
  buildRoutineQueue,
  commitWorldTick,
  mergeTickQueue,
  type QueuedProposal,
  readPendingExternalQueue,
  screenObservations,
  stepWorldTick,
  type TickDeps,
  type WorldTickOutcome,
} from "../../../../apps/simulation/src/tick";
import { serializePrngState } from "../../../../apps/simulation/src/world-store";
import type { Phases } from "./phases";

export interface MirrorResult {
  /** Wall time of each chunk's compute plus commit, the time the event loop is held, in order. */
  readonly chunkMs: readonly number[];
  readonly ticks: number;
  readonly events: number;
}

/** Runs `ticks` ticks of catch-up from `deps`'s store in `chunkTicks`-sized chunks, timing each step into `phases`. */
export async function runMirror(
  state: import("@panthea/world").WorldState,
  prng: PrngState,
  deps: TickDeps,
  ticks: number,
  chunkTicks: number,
  phases: Phases,
): Promise<MirrorResult> {
  const clock = readClock(deps.store.db);
  const startSequence = getCurrentSequence(deps.store.db);
  const tickMs = DEFAULT_TICK_ELAPSED_MS;
  let cursorWallMs = clock.cursorWallMs;
  let committedState = state;
  let committedPrng = prng;
  let ticksDone = 0;
  let eventCount = 0;
  const chunkMs: number[] = [];

  while (ticksDone < ticks) {
    const chunkStart = performance.now();
    const ticksThisChunk = Math.min(chunkTicks, ticks - ticksDone);

    const pending: QueuedProposal[] = phases.time("sim:read-pending", () =>
      readPendingExternalQueue(deps.store.db, committedState.tick + 1),
    );
    let workingState = committedState;
    let workingPrng = committedPrng;
    const first = phases.time("sim:routine-planning", () =>
      buildRoutineQueue(workingState),
    );
    const screened = phases.time("sim:screen-observations", () =>
      screenObservations(deps.traceDb, mergeTickQueue(first, pending)),
    );
    let workingQueue: readonly QueuedProposal[] = screened.runnable;
    const chunkOutcomes: WorldTickOutcome[] = [];
    let chunkEvents: import("@panthea/contracts").WorldEvent[] = [];

    for (let i = 0; i < ticksThisChunk; i += 1) {
      const stepped = phases.time("sim:step-world-tick", () =>
        stepWorldTick(workingState, workingPrng, workingQueue, {
          approximate: true,
        }),
      );
      const outcome: WorldTickOutcome =
        i === 0 ? { ...stepped, refused: screened.refused } : stepped;
      chunkOutcomes.push(outcome);
      chunkEvents = phases.time("sim:event-list-copy", () => [
        ...chunkEvents,
        ...outcome.result.events,
      ]);
      workingState = outcome.result.state;
      workingPrng = outcome.result.prng;
      workingQueue = phases.time("sim:routine-planning", () =>
        buildRoutineQueue(workingState),
      );
    }

    const newCursorWallMs = cursorWallMs + ticksThisChunk * tickMs;
    const commitStart = performance.now();
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
          appliedMs: (ticksDone + ticksThisChunk) * tickMs,
          discardedMs: 0,
          startSequence,
        }),
    );
    phases.add("commit:total", performance.now() - commitStart);
    if (!commit.ok) {
      throw new Error(`chunk commit failed: ${commit.message}`);
    }
    chunkMs.push(performance.now() - chunkStart);

    committedState = workingState;
    committedPrng = workingPrng;
    cursorWallMs = newCursorWallMs;
    ticksDone += ticksThisChunk;
    eventCount += chunkEvents.length;

    if (ticksDone < ticks) {
      const yieldStart = performance.now();
      await new Promise<void>((resolve) => setImmediate(resolve));
      phases.add("yield", performance.now() - yieldStart);
    }
  }

  // The ending commit: the cursor jump and the backlog's summary.
  const endStart = performance.now();
  const adjust = commitWorldTick(
    deps,
    [],
    {
      tick: committedState.tick,
      simTimeMs: committedState.simTime,
      prngState: serializePrngState(committedPrng),
      cursorWallMs,
      paused: false,
    },
    [],
    (db) => {
      phases.time("summary", () => closeCatchUpBacklog(db));
    },
  );
  phases.add("commit:ending-total", performance.now() - endStart);
  if (!adjust.ok) {
    throw new Error(`ending commit failed: ${adjust.message}`);
  }
  return { chunkMs, ticks: committedState.tick, events: eventCount };
}
