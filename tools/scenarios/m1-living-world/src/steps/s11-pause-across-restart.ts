// S11: a paused world commits nothing, stays paused through a clean restart,
// and the paused wall time never becomes catch-up when it resumes.

import { check, waitFor } from "../helpers";
import { fmt, readFrame, stopClean, waitForLog, waitForTicks } from "./api";
import type { Recorder, Story } from "./context";
import {
  eventsOf,
  integrityOf,
  observationSources,
  persistedClock,
} from "./direct";

export async function stepPauseAcrossRestart(
  recorder: Recorder,
  story: Story,
): Promise<void> {
  await recorder.run(
    "S11",
    "Pause across restart",
    "A paused world commits nothing, stays paused through a clean restart, and the paused wall time never becomes catch-up when it resumes.",
    async (step) => {
      const operatorBefore = observationSources(story).operator ?? 0;
      const paused = await story.sidecar.request("POST", "/pause");
      check(
        paused.status === 200,
        "POST /pause answers",
        `${paused.status} ${fmt(paused.body)}`,
      );
      await waitFor(
        "the frame reports paused",
        async () =>
          (await readFrame(story.sidecar)).frame.status === "paused"
            ? true
            : undefined,
        { timeoutMs: 5000 },
      );
      // The paused flag as persisted: /frame's status is in-memory state.
      const persisted = persistedClock(story);
      check(
        persisted.paused,
        "the pause is persisted in the clock row",
        fmt(persisted),
      );
      const pausedAt = await readFrame(story.sidecar);
      const pausedTick = pausedAt.state.tick;
      const pausedSequence = pausedAt.frame.sequence;
      await Bun.sleep(2500);
      const stillPaused = await readFrame(story.sidecar);
      check(
        stillPaused.state.tick === pausedTick &&
          stillPaused.frame.sequence === pausedSequence,
        "a paused world commits nothing for 2.5 s",
        `tick ${pausedTick} -> ${stillPaused.state.tick}`,
      );

      if (story.options.control === "pause") {
        // Positive control: resume before the restart, so the world is
        // running when it stops and does not come back paused.
        await story.sidecar.request("POST", "/resume");
        await waitForTicks(story, 1, "the resumed world ticks");
      }
      await stopClean(story, "the paused sidecar shuts down cleanly");
      const integrity = integrityOf(story);
      check(
        integrity === "ok",
        "the store is intact after the clean stop",
        integrity,
      );
      // Long enough that a gap counted as catch-up would be obvious (the sleep threshold is 5 s).
      await Bun.sleep(4000);
      const restarted = await story.restart();
      await waitForLog(
        restarted,
        "startup catch-up complete",
        "startup catch-up finishes after the paused restart",
      );
      const held = await readFrame(restarted);
      check(
        held.frame.status === "paused",
        "the restarted world is still paused",
        held.frame.status,
      );
      await Bun.sleep(2500);
      const restartedPaused = await readFrame(story.sidecar);
      check(
        restartedPaused.state.tick === pausedTick &&
          restartedPaused.frame.sequence === pausedSequence,
        "the restarted paused world commits nothing for 2.5 s",
        `tick ${pausedTick} -> ${restartedPaused.state.tick}`,
      );
      check(
        !held.frame.catchUpSummary || held.frame.catchUpSummary.appliedMs === 0,
        "the restart did not turn the paused interval into catch-up",
        fmt(held.frame.catchUpSummary),
      );

      const resumed = await story.sidecar.request("POST", "/resume");
      check(
        resumed.status === 200,
        "POST /resume answers",
        `${resumed.status} ${fmt(resumed.body)}`,
      );
      const tick = await waitForTicks(
        story,
        2,
        "the resumed world ticks again",
      );
      const advanced = tick - pausedTick;
      check(
        advanced >= 2 && advanced <= 6,
        "resuming applies live ticks, not the paused interval",
        `${advanced} ticks since the pause`,
      );
      const sinceResume = eventsOf(story, pausedSequence + 1);
      check(
        sinceResume.length > 0 &&
          sinceResume.every((event) => !event.approximate),
        "no event after the pause is marked approximate",
        `${sinceResume.filter((event) => event.approximate).length} approximate`,
      );
      const sources = observationSources(story);
      check(
        (sources.operator ?? 0) >= operatorBefore + 2,
        "the pause and resume are recorded as operator observations",
        `${operatorBefore} before, ${fmt(sources)} after`,
      );
      step.done(
        `paused at tick ${pausedTick}, sequence ${pausedSequence}; unchanged through 2.5 s, a clean restart with 4 s down, and 2.5 s after; resumed: +${advanced} ticks; operator observations ${operatorBefore} -> ${sources.operator}`,
        [
          {
            name: "ticks advanced after resume",
            unit: "ticks",
            value: advanced,
          },
        ],
      );
    },
  );
}
