// S9: a legend about a committed event is verified, one with no link is a
// rumor, and a legend linking an unknown event is refused at intake.

import legendRumor from "../fixtures/legend-rumor.json";
import legendUnknownLink from "../fixtures/legend-unknown-link.json";
import legendVerified from "../fixtures/legend-verified.json";
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
    "A legend a mortal tells about a committed event is verified, one told with no link is a rumor, both are attributed to their narrators and are records rather than facts, and a legend linking an unknown event is refused at intake.",
    async (step) => {
      // Different narrators, so both commit in the same tick.
      const linked = await postFixture(story, legendVerified, {
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
      const verifiedEvent = legendEvent(linkedOutcome);
      const rumorEvent = legendEvent(rumorOutcome);
      check(
        verifiedEvent.payload.verified === true &&
          verifiedEvent.payload.linkedEventId === strike.ignitedEventId,
        "a legend linked to the strike's ignition is verified",
        fmt(verifiedEvent.payload),
      );
      check(
        rumorEvent.payload.verified === false &&
          rumorEvent.payload.linkedEventId === undefined,
        "a legend with no link is a rumor",
        fmt(rumorEvent.payload),
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
        legends.length === 2 &&
          legends.filter((legend) => legend.verified).length === 1,
        "the world holds one verified legend and one rumor, and none for the refused one",
        fmt(
          legends.map((legend) => [
            legend.assertion.slice(0, 20),
            legend.verified,
          ]),
        ),
      );
      const narratorOf = (verified: boolean) =>
        legends.find((legend) => legend.verified === verified)?.narrator;
      check(
        narratorOf(true) === "woodcutter" && narratorOf(false) === "farmer",
        "each legend is attributed to the mortal who told it",
        fmt(legends.map((legend) => [legend.narrator, legend.verified])),
      );
      step.done(
        `verified legend by the woodcutter at sequence ${verifiedEvent.sequence} links ${strike.ignitedEventId.slice(0, 14)}; rumor by the farmer at sequence ${rumorEvent.sequence} has no link; both committed although both narrators have routines; unknown link refused (${unknown.status}) with no record; legends in world state: ${legends.length}`,
        [{ name: "legends held", unit: "count", value: legends.length }],
      );
    },
  );
}
