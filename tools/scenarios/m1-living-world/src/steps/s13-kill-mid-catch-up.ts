// S13: after a three hour sleep, catch-up discards the excess over the cap
// before any chunk; a SIGKILL partway through and a restart apply the rest of
// the capped backlog once.

import { Database } from "bun:sqlite";
import { catchUpIdentity, check, waitFor } from "../helpers";
import { activeStorePath, backdateCursor, readClockRow } from "../world-db";
import { fmt, readFrame, stopClean, waitForLog } from "./api";
import type { Recorder, Story } from "./context";
import {
  catchUpProgressOf,
  eventsOf,
  integrityOf,
  maxSequenceOnDisk,
  operatorObservationOn,
  persistedClock,
} from "./direct";

/** How far back the harness moves the wall cursor: a three hour sleep, well past the one-hour catch-up cap. */
const SLEEP_MS = 3 * 60 * 60 * 1000;
const CATCH_UP_CAP_MS = 60 * 60 * 1000;
const CHUNK_TICKS = 60;

export async function stepKillMidCatchUp(
  recorder: Recorder,
  story: Story,
): Promise<void> {
  await recorder.run(
    "S13",
    "Kill mid catch-up past the cap",
    "After a three hour sleep, catch-up discards the excess over the one-hour cap in its own commit before any chunk. A SIGKILL partway through and a restart then apply the rest of the capped backlog once: the restarted frame's summary reports the whole backlog, and ticks since the discard equal whole seconds of cursor advance.",
    async (step) => {
      await stopClean(
        story,
        "the sidecar shuts down cleanly before the simulated sleep",
      );
      // Direct read: the sidecar is stopped, so no endpoint answers.
      const stopped = persistedClock(story);
      const tickBase = stopped.tick;
      const sleepStart = stopped.cursorWallMs - SLEEP_MS;
      const sequenceBase = maxSequenceOnDisk(story);
      const path = activeStorePath(story.dataDir);
      // Fault injection: the machine slept for SLEEP_MS.
      backdateCursor(path, sleepStart);

      const sidecar = await story.restart();
      // Direct read: a running catch-up publishes nothing on /frame until it ends, so its committed chunks are only visible in the store.
      const watcher = new Database(path, { readonly: true });
      let exitCode: number | null;
      let killedAtMs: number;
      try {
        await waitFor(
          "catch-up commits its first chunks",
          () =>
            readClockRow(watcher).tick - tickBase >= 2 * CHUNK_TICKS
              ? true
              : undefined,
          { timeoutMs: 30_000, intervalMs: 1 },
        );
        exitCode = await sidecar.stop("SIGKILL");
        killedAtMs = Date.now();
      } finally {
        watcher.close();
      }
      check(exitCode !== 0, "the sidecar was killed", `exit code ${exitCode}`);

      // Direct reads: the sidecar is killed, and no endpoint serves catch-up progress.
      const atKill = persistedClock(story);
      const progress = catchUpProgressOf(story);
      check(
        progress !== undefined,
        "the unfinished backlog's progress is committed",
        "no catch_up_progress row",
      );
      const applied = atKill.tick - tickBase;
      check(
        progress.appliedMs === applied * 1000 && applied % CHUNK_TICKS === 0,
        "the progress records exactly the whole chunks committed",
        `${fmt(progress)} vs ${applied} ticks`,
      );
      check(
        applied < CATCH_UP_CAP_MS / 1000 - CHUNK_TICKS,
        "the kill landed partway through the capped backlog",
        `${applied} of ${CATCH_UP_CAP_MS / 1000} ticks applied`,
      );
      const discarded = progress.discardedMs;
      const expectedDiscard = SLEEP_MS - CATCH_UP_CAP_MS;
      check(
        discarded >= expectedDiscard && discarded < expectedDiscard + 60_000,
        "the excess over the cap was discarded, committed before the chunks",
        `${discarded} ms discarded, expected ${expectedDiscard} plus the seconds before the restart sampled the clock`,
      );
      check(
        operatorObservationOn(story, `catch-up-discard:${discarded}`),
        "the discard is on record as its own operator observation",
        `no catch-up-discard:${discarded}`,
      );
      // After the discard the cursor sat one cap behind the moment catch-up
      // sampled the clock; every applied second moves it and the tick together.
      const backlogStart = sleepStart + discarded;
      const baseline = { tick: tickBase, backdatedCursorMs: backlogStart };
      const killIdentity = catchUpIdentity(baseline, atKill);
      check(
        killIdentity.ok,
        "at the kill, ticks since the discard equal whole seconds of cursor advance",
        fmt(killIdentity),
      );
      const integrity = integrityOf(story);
      check(
        integrity === "ok",
        "the store passes integrity_check after SIGKILL",
        integrity,
      );

      if (story.options.control === "catch-up") {
        // Positive control: a store that kept the ticks but lost the cursor
        // advance would replay the chunks already applied. The identity must notice.
        backdateCursor(path, backlogStart);
      }

      const second = await story.restart();
      const restartedAtMs = Date.now();
      // A full hour of the town takes the service longer than its sleep threshold, so a short
      // second pass may follow and replace the backlog's summary: read it as soon as it is
      // written, then wait for the log line.
      // The frame may still carry an earlier backlog's summary until this one is written, so
      // the one wanted is the one that applied the whole cap.
      const firstSummary = await waitFor(
        "the frame carries the backlog's catch-up summary",
        async () => {
          const found = (await readFrame(second)).frame.catchUpSummary;
          return found !== undefined && found.appliedMs >= CATCH_UP_CAP_MS
            ? found
            : undefined;
        },
        { timeoutMs: 60_000, intervalMs: 10 },
      );
      await waitForLog(
        second,
        "startup catch-up complete",
        "the second catch-up finishes",
      );
      // Direct read: the wall cursor is in no endpoint.
      const clock = persistedClock(story);
      const identity = catchUpIdentity(baseline, clock);
      check(
        identity.ok,
        "after the second catch-up, ticks since the discard equal whole seconds of cursor advance (nothing was applied twice)",
        fmt(identity),
      );
      const summary = firstSummary;
      check(
        summary !== undefined,
        "the restarted frame carries a catch-up summary",
        "none",
      );
      check(
        summary.skippedMs === discarded,
        "the restarted summary reports the whole backlog's discard, committed before the kill",
        `${summary.skippedMs} vs ${discarded}`,
      );
      // The cap bounds the remaining backlog: seconds that passed between the
      // kill and the restart are new gap, applied once on top.
      const extraMs = summary.appliedMs - CATCH_UP_CAP_MS;
      const downtimeMs = restartedAtMs - killedAtMs;
      check(
        extraMs >= 0 && extraMs % 1000 === 0 && extraMs <= downtimeMs + 1000,
        "the restarted summary reports the whole backlog applied: the cap plus only the seconds that passed while the service was down",
        `applied ${summary.appliedMs} ms, cap ${CATCH_UP_CAP_MS} ms, down ${downtimeMs} ms`,
      );
      // A full hour of the whole town takes the service longer than its sleep
      // threshold to apply, so it may run a short second pass over the seconds
      // that took. What follows the summary is then further catch-up (approximate)
      // and then live ticks: the ticks since the discard are the summary's applied
      // time plus those, never fewer.
      const laterTicks = clock.tick - tickBase - summary.appliedMs / 1000;
      check(
        laterTicks >= 0,
        "ticks since the discard are the summary's applied time plus any later catch-up and live ticks",
        `${clock.tick - tickBase} ticks, summary ${summary.appliedMs / 1000}, later ${laterTicks}`,
      );
      check(
        catchUpProgressOf(story) === undefined,
        "the backlog's progress is cleared once it completes",
        fmt(catchUpProgressOf(story)),
      );
      const catchUpEvents = eventsOf(story, sequenceBase + 1).filter(
        (event) => event.sequence <= summary.atSequence,
      );
      check(
        catchUpEvents.length > 0 &&
          catchUpEvents.every((event) => event.approximate),
        "every catch-up event is marked approximate",
        `${catchUpEvents.filter((event) => !event.approximate).length} exact`,
      );
      // Events after the summary are a second catch-up pass's (approximate), if
      // one ran, and then live ones: once a live event appears, no approximate
      // one follows it.
      const afterSummary = eventsOf(story, summary.atSequence + 1);
      const firstExact = afterSummary.findIndex((event) => !event.approximate);
      check(
        firstExact === -1 ||
          afterSummary.slice(firstExact).every((event) => !event.approximate),
        "live events after catch-up are exact",
        "an approximate event after a live one",
      );
      const finalIntegrity = integrityOf(story);
      check(
        finalIntegrity === "ok",
        "the store passes integrity_check after the second catch-up",
        finalIntegrity,
      );
      step.done(
        `sleep ${SLEEP_MS / 3_600_000} h, cap ${CATCH_UP_CAP_MS / 3_600_000} h: excess ${(discarded / 3_600_000).toFixed(3)} h discarded before the chunks; killed after ${applied / CHUNK_TICKS} chunks (${applied} ticks); restarted summary applied ${summary.appliedMs / 1000} ticks (the cap plus ${extraMs / 1000} s of downtime), skipped ${(summary.skippedMs / 3_600_000).toFixed(3)} h; ${catchUpEvents.length} approximate events`,
        [
          {
            name: "chunks committed before kill",
            unit: "chunks",
            value: applied / CHUNK_TICKS,
          },
          {
            name: "ticks applied by the whole backlog",
            unit: "ticks",
            value: summary.appliedMs / 1000,
          },
          {
            name: "seconds discarded beyond the cap",
            unit: "s",
            value: Math.round(summary.skippedMs / 1000),
          },
          {
            name: "ticks over cursor seconds (must be 0)",
            unit: "ticks",
            value: identity.ticksAdvanced - identity.ticksForCursorAdvance,
          },
        ],
      );
    },
  );
}
