// S16: every causal chain is walkable from the identifiers the producer used,
// through to the presentation receipt the client sent.

import type { FollowResult } from "@panthea/telemetry";
import { check } from "../helpers";
import { fmt, traceEvent, traceProposal } from "./api";
import type { Recorder, Story } from "./context";
import { eventsOf } from "./direct";
import type { StrikeFacts } from "./s04-strike";
import type { WorshipFacts } from "./s08-worship";
import type { BadProposalFacts } from "./s10-bad-proposals";

export async function stepTrace(
  recorder: Recorder,
  story: Story,
  facts: {
    readonly strike: StrikeFacts;
    readonly worship: WorshipFacts;
    readonly bad: BadProposalFacts;
  },
): Promise<void> {
  const { strike, worship, bad } = facts;
  await recorder.run(
    "S16",
    "Trace",
    "Every chain is walkable from the identifiers the producer used: a rejected proposal ends at its rejection, a routine trade and a worship reach the presentation receipt the client sent, and the strike's own ignition walks observation, proposal, validation, event, projection change, and the client's presentation receipt.",
    async (step) => {
      const stepNames = (steps: FollowResult["steps"]) =>
        steps.map((entry) => entry.step).join(" -> ");

      // A rejected proposal's chain ends at its rejection, with the reason.
      const staleTrace = (await traceProposal(story, bad.staleProposalId))
        .steps;
      const staleValidation = staleTrace[2];
      check(
        stepNames(staleTrace) === "observation -> proposal -> validation" &&
          staleValidation?.step === "validation" &&
          staleValidation.outcome === "rejected" &&
          staleValidation.reason === "stale-target",
        "a rejected proposal's chain ends at its rejection with the reason",
        fmt(staleTrace),
      );

      // A routine's trade is one drawn event: observation by a routine through its receipt.
      const presented = story.clients[0]?.presented() ?? [];
      const tradeReceipt = presented.find(
        (entry) => entry.kind === "resource-traded",
      );
      check(
        tradeReceipt !== undefined,
        "a receipted routine trade exists to trace",
        "none",
      );
      const tradeTrace = (await traceEvent(story, tradeReceipt.eventId)).steps;
      check(
        tradeTrace[0]?.step === "observation" &&
          tradeTrace[0].record.source === "routine" &&
          stepNames(tradeTrace).startsWith(
            "observation -> proposal -> validation -> event -> projection-change -> receipt",
          ),
        "a routine trade's chain runs from a routine's observation to its receipt",
        stepNames(tradeTrace),
      );
      const tradeReceiptStep = tradeTrace.find(
        (entry) => entry.step === "receipt",
      );
      check(
        tradeReceiptStep?.step === "receipt" &&
          tradeReceiptStep.sessionId === tradeReceipt.sessionId,
        "the trade chain ends at the receipt the client sent",
        fmt(tradeReceiptStep),
      );

      // The worship: a fixture proposal by a mortal, walked to its receipt.
      const worshipTrace = (await traceEvent(story, worship.eventId)).steps;
      const worshipObservation = worshipTrace[0];
      const worshipReceipt = worshipTrace.find(
        (entry) => entry.step === "receipt",
      );
      check(
        worshipObservation?.step === "observation" &&
          worshipObservation.record.source === "fixture" &&
          worshipObservation.record.observer === "woodcutter" &&
          stepNames(worshipTrace).startsWith(
            "observation -> proposal -> validation -> event -> projection-change -> receipt",
          ) &&
          worshipReceipt?.step === "receipt" &&
          worshipReceipt.sessionId === worship.sessionId,
        "the worship chain runs from the fixture's observation by the woodcutter to the client's receipt",
        stepNames(worshipTrace),
      );

      // The strike, from its proposal: every event it committed, in order.
      const byProposal = (await traceProposal(story, strike.proposalId)).steps;
      const strikeEvents = eventsOf(story).filter(
        (row) => row.correlationId === strike.observationId,
      );
      check(
        byProposal.filter((entry) => entry.step === "event").length === 2 &&
          strikeEvents.map((row) => row.id).join() ===
            byProposal
              .flatMap((entry) =>
                entry.step === "event" ? [entry.eventId] : [],
              )
              .join(),
        "following the strike from its proposal lists both events it committed, in order",
        stepNames(byProposal),
      );
      const spendChain = (await traceEvent(story, strike.firstEventId)).steps;
      check(
        stepNames(spendChain) ===
          "observation -> proposal -> validation -> event -> projection-change",
        "the divinity spend, which the client never draws, walks to its projection change and has no receipt",
        stepNames(spendChain),
      );

      // Final assertion: the strike's ignition, observation through presentation.
      const ignition = strikeEvents.find(
        (row) => row.id === strike.ignitedEventId,
      );
      check(
        ignition?.kind === "building-ignited",
        "the strike's ignition event is on record",
        `${ignition?.kind}`,
      );
      const chain = await traceEvent(story, strike.ignitedEventId);
      const [observation, proposal, validation, event, projection, receipt] =
        chain.steps;
      check(
        chain.found &&
          stepNames(chain.steps).startsWith(
            "observation -> proposal -> validation -> event -> projection-change -> receipt",
          ),
        "the strike's ignition chain runs observation, proposal, validation, event, projection change, presentation receipt",
        stepNames(chain.steps),
      );
      check(
        observation?.step === "observation" &&
          observation.record.id === strike.observationId &&
          observation.record.source === "fixture" &&
          observation.record.observer === "zeus",
        "the chain starts at the strike's own observation, by zeus",
        fmt(observation),
      );
      check(
        proposal?.step === "proposal" &&
          proposal.proposalId === strike.proposalId &&
          proposal.record.kind === "strike" &&
          proposal.record.observationId === strike.observationId,
        "the proposal is the strike the producer posted, citing that observation",
        fmt(proposal),
      );
      check(
        validation?.step === "validation" && validation.outcome === "committed",
        "validation committed the strike",
        fmt(validation),
      );
      check(
        event?.step === "event" &&
          event.eventId === strike.ignitedEventId &&
          projection?.step === "projection-change" &&
          projection.revision === ignition.sequence,
        "the event is the ignition and its projection change is that event's committed sequence",
        fmt([event, projection]),
      );
      check(
        receipt?.step === "receipt" &&
          receipt.sessionId === strike.sessionId &&
          receipt.presentedAtMs > 0,
        "the chain ends at the presentation receipt the client sent for the ignition, in the session it happened in",
        fmt(receipt),
      );

      step.done(
        `stale chain ${stepNames(staleTrace)} (${staleValidation?.step === "validation" ? staleValidation.reason : "?"}); trade chain and worship chain each end at the client's receipt; strike from its proposal: ${stepNames(byProposal)}; strike ignition chain ${stepNames(chain.steps)} (event sequence ${ignition.sequence}, receipt session ${receipt?.step === "receipt" ? receipt.sessionId.slice(0, 16) : "?"}...)`,
        [
          {
            name: "strike ignition chain hops",
            unit: "hops",
            value: chain.steps.length,
          },
          {
            name: "worship chain hops",
            unit: "hops",
            value: worshipTrace.length,
          },
          {
            name: "trade chain hops",
            unit: "hops",
            value: tradeTrace.length,
          },
        ],
      );
    },
  );
}
