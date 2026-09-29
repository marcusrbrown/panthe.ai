// S2: with no external input, routines commit events every tick.

import { check } from "../helpers";
import { fmt, readFrame, waitForTicks } from "./api";
import type { Recorder, Story } from "./context";
import { eventsOf, observationSources } from "./direct";

export async function stepUnattended(
  recorder: Recorder,
  story: Story,
): Promise<void> {
  await recorder.run(
    "S2",
    "Unattended routines",
    "With no external input, routines commit events every tick, and every observation on record is a routine's.",
    async (step) => {
      const beforeFrame = await readFrame(story.sidecar);
      const tickBefore = beforeFrame.state.tick;
      const seqBefore = beforeFrame.frame.sequence;
      const tick = await waitForTicks(
        story,
        8,
        "eight ticks pass with no external input",
      );
      const events = eventsOf(story);
      const kinds = new Set(events.map((event) => event.kind));
      const sources = observationSources(story);
      const added = (await readFrame(story.sidecar)).frame.sequence - seqBefore;
      check(added > 0, "the event log grows unattended", "no new events");
      check(
        kinds.has("resource-gathered") && kinds.has("income-earned"),
        "routines gather and buildings earn income unattended",
        fmt([...kinds]),
      );
      check(
        Object.keys(sources).join() === "routine",
        "only routines have made observations so far",
        fmt(sources),
      );
      step.done(
        `${tick - tickBefore} ticks, ${added} events, kinds ${[...kinds].sort().join(", ")}; observations by source ${fmt(sources)}`,
        [{ name: "unattended events", unit: "count", value: added }],
      );
    },
  );
}
