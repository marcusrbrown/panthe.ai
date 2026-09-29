// S10: malformed input is refused at intake, a false claim and a stale
// proposal are recorded as rejections, and none of them changes the world.

import { createProposalId } from "@panthea/telemetry";
import claimFalse from "../fixtures/claim-false.json";
import malformedAuthority from "../fixtures/malformed-authority.json";
import missingObservation from "../fixtures/missing-observation.json";
import staleStrike from "../fixtures/stale-strike.json";
import { check, instantiate } from "../helpers";
import {
  fmt,
  knowsProposal,
  outcomeOf,
  postFixture,
  readFrame,
  waitForTicks,
} from "./api";
import type { Recorder, Story } from "./context";
import { eventsOf } from "./direct";
import type { TreeStrike } from "./s03-tree-strike";
import { building } from "./state";

/** What a later step needs from the bad proposals. */
export interface BadProposalFacts {
  readonly staleProposalId: string;
}

export async function stepBadProposals(
  recorder: Recorder,
  story: Story,
  oak: TreeStrike,
): Promise<BadProposalFacts> {
  return recorder.run(
    "S10",
    "Malformed, false, and stale proposals",
    "Malformed input is refused at intake with no journal entry and no record; a false claim and a stale proposal are journaled and recorded as rejections with a reason code; none of them changes the world.",
    async (step) => {
      const beforeState = (await readFrame(story.sidecar)).state;
      const refused: {
        label: string;
        status: number;
        proposalId: string;
        observationId: string;
        envelope: unknown;
      }[] = [];

      const invalid = await story.sidecar.request(
        "POST",
        "/proposals",
        "{not json",
      );
      check(
        invalid.status === 400,
        "invalid JSON is refused",
        `${invalid.status}`,
      );
      const missingProposalId = createProposalId();
      const missingEnvelope = {
        proposalId: missingProposalId,
        ...(instantiate(missingObservation, {}) as object),
      };
      const missing = await story.sidecar.request(
        "POST",
        "/proposals",
        missingEnvelope,
      );
      check(
        missing.status === 400,
        "a proposal without its observation wrapper is refused",
        `${missing.status} ${fmt(missing.body)}`,
      );
      refused.push({
        label: "missing observation",
        status: missing.status,
        proposalId: missingProposalId,
        observationId: "obs-without-a-record",
        envelope: missingEnvelope,
      });
      const authority = await postFixture(story, malformedAuthority);
      check(
        authority.status === 400,
        "a proposal declaring its own costs is refused",
        `${authority.status} ${fmt(authority.body)}`,
      );
      check(
        fmt(authority.body).includes("costs"),
        "the refusal names the offending field",
        fmt(authority.body),
      );
      refused.push({
        label: "self-declared costs",
        status: authority.status,
        proposalId: authority.proposalId,
        observationId: authority.observationId,
        envelope: authority.envelope,
      });

      const claim = await postFixture(story, claimFalse);
      const stale = await postFixture(story, staleStrike);
      check(
        claim.status === 202 && stale.status === 202,
        "the false claim and stale proposal reach the validator",
        `${claim.status}, ${stale.status}`,
      );
      const claimOutcome = await outcomeOf(
        story,
        claim.proposalId,
        "the false claim's rejection is recorded",
      );
      const staleOutcome = await outcomeOf(
        story,
        stale.proposalId,
        "the stale proposal's rejection is recorded",
      );
      check(
        claimOutcome.outcome === "rejected" &&
          claimOutcome.reason === "unauthorized-claim",
        "a false ownership claim is rejected as unauthorized",
        `${claimOutcome.outcome} ${claimOutcome.reason}`,
      );
      check(
        staleOutcome.outcome === "rejected" &&
          staleOutcome.reason === "stale-target",
        "a proposal against a stale revision is rejected as stale",
        `${staleOutcome.outcome} ${staleOutcome.reason}`,
      );

      await waitForTicks(story, 2, "two ticks pass after the bad proposals");
      for (const entry of refused) {
        const known = await knowsProposal(
          story,
          entry.proposalId,
          entry.envelope,
        );
        check(
          !known.journaled && !known.traced,
          `a refused proposal (${entry.label}) leaves no journal entry and no trace outcome`,
          fmt(known),
        );
      }
      const events = eventsOf(story);
      // Positive control: put an observation that did cause events (the tree
      // strike's) among the "bad" ones, so a change IS observed.
      const controlObservation =
        story.options.control === "bad-proposals" ? [oak.observationId] : [];
      for (const id of [
        claim.observationId,
        stale.observationId,
        ...refused.map((entry) => entry.observationId),
        ...controlObservation,
      ]) {
        check(
          events.every((event) => event.correlationId !== id),
          "no bad proposal caused an event",
          id,
        );
      }
      const afterState = (await readFrame(story.sidecar)).state;
      // Positive control: probe a building that does have an owner (the tavern's).
      const ownerProbe =
        story.options.control === "claim-owner" ? "the-tavern" : "old-oak";
      check(
        building(afterState, ownerProbe).owner === undefined &&
          building(beforeState, ownerProbe).owner === undefined,
        "the false claim did not give the old oak an owner",
        fmt(building(afterState, ownerProbe).owner),
      );
      step.done(
        `refused at intake (400): invalid JSON, missing observation, self-declared costs; recorded rejections: claim ${claimOutcome.reason}, stale strike ${staleOutcome.reason}; events caused by all five: 0; old oak owner unchanged`,
        [{ name: "bad proposals posted", unit: "count", value: 5 }],
      );
      return { staleProposalId: stale.proposalId };
    },
  );
}
