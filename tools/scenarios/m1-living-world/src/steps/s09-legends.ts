// S9: a legend that cites a committed event is event-linked (an evidence
// link, never certification of its prose), one with no link is unlinked, a
// legend citing an unrelated event is recorded just the same, and a legend
// linking an unknown event is refused at intake.

import legendLinked from "../fixtures/legend-linked.json";
import legendRumor from "../fixtures/legend-rumor.json";
import legendUnknownLink from "../fixtures/legend-unknown-link.json";
import legendUnrelatedLink from "../fixtures/legend-unrelated-link.json";
import { check } from "../helpers";
import {
  fmt,
  knowsProposal,
  outcomeOf,
  postFixture,
  readFrame,
  type TracedOutcome,
  waitForTicks,
} from "./api";
import type { Recorder, Story } from "./context";
import { eventsOf } from "./direct";
import type { StrikeFacts } from "./s04-strike";

export async function stepLegends(
  recorder: Recorder,
  story: Story,
  strike: StrikeFacts,
): Promise<void> {
  await recorder.run(
    "S9",
    "Legends",
    "A legend that cites a committed event is recorded event-linked, one told with no link is recorded unlinked, and a legend citing an unrelated event is recorded the same way: the world keeps the narrator's assertion and their evidence link, attributed, and certifies none of it (no verified flag exists). A legend linking an unknown event is refused at intake.",
    async (step) => {
      // Different narrators, so both commit in the same tick.
      const linked = await postFixture(story, legendLinked, {
        "$event:ignited": strike.ignitedEventId,
      });
      const rumor = await postFixture(story, legendRumor);
      check(
        linked.status === 202 && rumor.status === 202,
        "both legends are accepted at intake",
        `${linked.status} ${fmt(linked.body)}, ${rumor.status} ${fmt(rumor.body)}`,
      );
      const linkedOutcome = await outcomeOf(
        story,
        linked.proposalId,
        "the linked legend's outcome is recorded",
      );
      const rumorOutcome = await outcomeOf(
        story,
        rumor.proposalId,
        "the rumor's outcome is recorded",
      );
      check(
        linkedOutcome.outcome === "committed" &&
          rumorOutcome.outcome === "committed",
        "both legends commit, though their narrators have routines",
        `${linkedOutcome.outcome} ${linkedOutcome.reason}, ${rumorOutcome.outcome} ${rumorOutcome.reason}`,
      );
      const legendEvent = (outcome: TracedOutcome) => {
        const found = eventsOf(story).filter((event) =>
          outcome.eventIds.includes(event.id),
        );
        check(
          found.length === 1 && found[0]?.kind === "legend-recorded",
          "a legend commits one legend-recorded event",
          found.map((event) => event.kind).join(),
        );
        return found[0];
      };
      const linkedEvent = legendEvent(linkedOutcome);
      const unlinkedEvent = legendEvent(rumorOutcome);
      check(
        linkedEvent.payload.linkedEventId === strike.ignitedEventId &&
          !("verified" in linkedEvent.payload),
        "a legend citing the strike's ignition carries that evidence link and no truth flag",
        fmt(linkedEvent.payload),
      );
      check(
        unlinkedEvent.payload.linkedEventId === undefined &&
          !("verified" in unlinkedEvent.payload),
        "a legend with no link carries none and no truth flag",
        fmt(unlinkedEvent.payload),
      );

      // Zeus (no routine) tells a story the cited event does not support.
      const unrelated = await postFixture(story, legendUnrelatedLink, {
        "$event:ignited": strike.ignitedEventId,
      });
      check(
        unrelated.status === 202,
        "a legend citing an unrelated committed event is accepted at intake",
        `${unrelated.status} ${fmt(unrelated.body)}`,
      );
      const unrelatedOutcome = await outcomeOf(
        story,
        unrelated.proposalId,
        "the unrelated-link legend's outcome is recorded",
      );
      check(
        unrelatedOutcome.outcome === "committed",
        "the world records a legend whose cited event does not support its prose: it judges evidence links, not truth",
        `${unrelatedOutcome.outcome} ${unrelatedOutcome.reason}`,
      );
      const unrelatedEvent = legendEvent(unrelatedOutcome);
      check(
        unrelatedEvent.payload.linkedEventId === strike.ignitedEventId &&
          !("verified" in unrelatedEvent.payload),
        "the unrelated citation is recorded as a link, never certified",
        fmt(unrelatedEvent.payload),
      );

      const unknown = await postFixture(story, legendUnknownLink);
      check(
        unknown.status === 400,
        "a legend linking an unknown event is refused at intake",
        `${unknown.status} ${fmt(unknown.body)}`,
      );
      await waitForTicks(story, 2, "two ticks pass after the refused legend");
      const known = await knowsProposal(
        story,
        unknown.proposalId,
        unknown.envelope,
      );
      check(
        !known.journaled &&
          !known.traced &&
          eventsOf(story).every(
            (event) => event.correlationId !== unknown.observationId,
          ),
        "the refused legend leaves no journal entry, no outcome, and no event",
        fmt(known),
      );
      const { state } = await readFrame(story.sidecar);
      const legends = [...state.legends.values()];
      check(
        legends.length === 3 &&
          legends.filter((legend) => legend.linkedEventId !== undefined)
            .length === 2 &&
          legends.every((legend) => !("verified" in legend)),
        "the world holds two event-linked legends and one unlinked one, none carrying a truth flag, and none for the refused one",
        fmt(
          legends.map((legend) => [
            legend.assertion.slice(0, 20),
            legend.linkedEventId,
          ]),
        ),
      );
      const narratorOf = (linked: boolean, unrelatedTale: boolean) =>
        legends.find(
          (legend) =>
            (legend.linkedEventId !== undefined) === linked &&
            legend.assertion.startsWith("Zeus destroyed") === unrelatedTale,
        )?.narrator;
      check(
        narratorOf(true, false) === "woodcutter" &&
          narratorOf(false, false) === "farmer" &&
          narratorOf(true, true) === "zeus",
        "each legend is attributed to the actor who told it",
        fmt(legends.map((legend) => [legend.narrator, legend.linkedEventId])),
      );
      check(
        new Set(legends.map((legend) => legend.id)).size === legends.length,
        "each telling has its own identity",
        fmt(legends.map((legend) => legend.id)),
      );
      step.done(
        `event-linked legend by the woodcutter at sequence ${linkedEvent.sequence} cites ${strike.ignitedEventId.slice(0, 14)}; unlinked legend by the farmer at sequence ${unlinkedEvent.sequence}; zeus's legend citing the same event for an unrelated tale at sequence ${unrelatedEvent.sequence} recorded event-linked, uncertified; both mortal tellings committed although both narrators have routines; unknown link refused (${unknown.status}) with no record; legends in world state: ${legends.length}, all distinct, none with a truth flag`,
        [{ name: "legends held", unit: "count", value: legends.length }],
      );
    },
  );
}
