// S18: over everything the scripted story did, the real-run properties of the
// practice threads hold. The run's data is read back from the store the way the
// real run reads its own (requests with their prompts, the journaled god
// proposals, every event), so these are the same checks the gate applies to a
// model. With a practice control named, the data is broken first, on purpose:
// the check for the property it targets must then fail.

import { activeStorePath } from "../../../m1-living-world/src/world-db";
import { readProposals, readRealRequests, readStoredEvents } from "../db";
import { analyzePractices, type PracticeAnalysis } from "../practice-analysis";
import {
  CONTROLLED_PROPERTY,
  PRACTICE_CONTROLS,
  sabotage,
} from "../practice-controls";
import type { RealInput } from "../real-analysis";
import type { Recorder, Story } from "./context";
import { check } from "./support";

/** The run's data as the real run reads it, from the store. */
export function collectInput(story: Story): RealInput {
  const path = activeStorePath(story.dataDir);
  return {
    // The story scripts Zeus and Hera through the thread practices. The other five gods take turns too,
    // and wait; Athena and Poseidon also play a contest (S17), which is no thread. The thread properties
    // judge the gods who had threads to answer, and the seven-god run judges all of them; the contest
    // property reads the events alone, so it sees the contest whoever played it.
    requests: readRealRequests(path).filter(
      (request) => request.role === "zeus" || request.role === "hera",
    ),
    proposals: readProposals(path)
      .filter(
        (entry) =>
          entry.source === "model" &&
          (entry.actor === "zeus" || entry.actor === "hera"),
      )
      .map((entry) => ({
        proposalId: entry.proposalId,
        actor: entry.actor,
        kind: entry.kind,
        observationId: String(entry.proposal.observationId),
        proposal: entry.proposal,
        outcome: entry.outcome as "committed" | "rejected" | undefined,
        ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      })),
    events: readStoredEvents(path),
    polls: { total: 1, degraded: 0 },
  };
}

export async function stepPracticeProperties(
  recorder: Recorder,
  story: Story,
): Promise<PracticeAnalysis> {
  await recorder.run(
    "S18",
    "The practice properties hold over the scripted episode",
    "Over the requests, journaled proposals, and events of the whole scripted run, each god caused a thread ending that left a persistent consequence; the run held a supplication and a settlement, with a refusal and a breach among them; every thread ended with its parties remembering how, or is open inside its deadline; no thread reopened without a cause learned since it opened; every move judged no progress left a refusal record and advanced nothing; a recorded consequence changed a later choice, with the ending in the prompt behind it; and every turn an obligated god took has its recorded classification. With any of the practice controls applied to the data first, the property it targets fails.",
    async (step) => {
      const control = story.options.control;
      const practice = (PRACTICE_CONTROLS as readonly string[]).includes(
        control ?? "",
      )
        ? (control as (typeof PRACTICE_CONTROLS)[number])
        : undefined;
      const collected = collectInput(story);
      const input =
        practice === undefined ? collected : sabotage(practice, collected);
      const analysis = analyzePractices(input);
      if (practice !== undefined) {
        const target = CONTROLLED_PROPERTY[practice];
        const property = analysis.properties.find((p) => p.name === target);
        check(
          property?.ok === true,
          `${target} holds`,
          property?.detail ?? "no such property",
        );
      }
      for (const property of analysis.properties) {
        check(property.ok, `${property.name} holds`, property.detail);
      }
      const classes = new Map<string, number>();
      for (const turn of analysis.obligated.turns) {
        classes.set(turn.class, (classes.get(turn.class) ?? 0) + 1);
      }
      step.done(
        `${analysis.threads.length} threads (${analysis.threads.filter((t) => t.ending !== undefined).length} ended, ${analysis.open.length} open), ${analysis.noProgress.length} moves judged no progress, ${analysis.obligated.turns.length} obligated turns (${[...classes].map(([k, n]) => `${n} ${k}`).join(", ") || "none"}); ${analysis.properties.map((p) => p.name).join("; ")} all held`,
        [
          { name: "threads", unit: "threads", value: analysis.threads.length },
          {
            name: "moves judged no progress",
            unit: "moves",
            value: analysis.noProgress.length,
          },
          {
            name: "obligated turns",
            unit: "turns",
            value: analysis.obligated.turns.length,
          },
        ],
      );
    },
  );
  return analyzePractices(collectInput(story));
}
