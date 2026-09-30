// S9: a god's proposal built from a snapshot the world has since moved past is
// rejected as stale-target, with no effect; the same proposal in an unchanged
// world commits.

import { outcomeOf } from "../../../m1-living-world/src/steps/api";
import { eventsOf } from "../../../m1-living-world/src/steps/direct";
import type { Recorder, Story } from "./context";
import {
  check,
  lastInputOrder,
  legend,
  locationOf,
  postFixture,
  waitForConsumed,
  waitForModelProposal,
  within,
} from "./support";

/** Holds a Hera turn in flight, optionally changes the world, releases it, and returns how it ended. */
async function heldTurn(story: Story, text: string, changeWorld: boolean) {
  const after = lastInputOrder(story);
  const held = story.provider.hold("hera", legend(text));
  await within("hera's turn is in flight", held.arrived, 30_000);
  if (changeWorld) {
    // While the model thinks, Hera is moved by a fixture: her revision changes.
    await postFixture(
      story,
      "hera",
      { kind: "move", to: "olympus-gate" },
      "hera is moved while her turn is in flight",
    );
    const at = await locationOf(story, "hera");
    check(at === "olympus-gate", "hera stands at the gate", String(at));
  }
  held.release();
  const journaled = await waitForModelProposal(
    story,
    "hera",
    "legend",
    after,
    "hera's held turn is journaled",
  );
  const consumed = await waitForConsumed(
    story,
    journaled.proposalId,
    "hera's held proposal is taken by a tick",
  );
  return { consumed, observationId: String(journaled.proposal.observationId) };
}

export async function stepStale(
  recorder: Recorder,
  story: Story,
): Promise<void> {
  await recorder.run(
    "S9",
    "Stale god proposal rejected",
    "A god's proposal, built from a snapshot the world has since moved past (its own revision changed while the model thought), is rejected as stale-target and causes no event; the same proposal in an unchanged world commits.",
    async (step) => {
      const unchanged = await heldTurn(
        story,
        "Hera speaks in a still world.",
        false,
      );
      check(
        unchanged.consumed.outcome === "committed",
        "in an unchanged world the held proposal commits",
        `${unchanged.consumed.outcome} ${unchanged.consumed.reason}`,
      );

      const stale = await heldTurn(
        story,
        "Hera speaks in a world that moved.",
        story.options.control !== "stale",
      );
      check(
        stale.consumed.outcome === "rejected" &&
          stale.consumed.reason === "stale-target",
        "the proposal built before the world moved is rejected as stale-target",
        `${stale.consumed.outcome} ${stale.consumed.reason}`,
      );
      const traced = await outcomeOf(
        story,
        stale.consumed.proposalId,
        "the rejection is in the trace",
      );
      check(
        traced.outcome === "rejected" && traced.reason === "stale-target",
        "the trace records the same rejection",
        `${traced.outcome} ${traced.reason}`,
      );
      check(
        eventsOf(story).every(
          (event) => event.correlationId !== stale.observationId,
        ),
        "the stale proposal caused no event",
        "an event carries its observation",
      );
      step.done(
        `held turn in an unchanged world: committed; the same kind of turn after hera was moved: ${stale.consumed.outcome} (${stale.consumed.reason}), no event`,
      );
    },
  );
}
