// S3: a strike below the ignition threshold damages a tree without burning it.

import strikeTree from "../fixtures/strike-tree.json";
import { check, waitFor } from "../helpers";
import { fmt, outcomeOf, postFixture, readFrame, traceEvent } from "./api";
import type { Recorder, Story } from "./context";
import { eventsOf } from "./direct";
import { actor, amountOf, building } from "./state";

/** What a later step needs from the tree strike. */
export interface TreeStrike {
  readonly damagedEventId: string;
  readonly observationId: string;
  readonly sessionId: string;
}

export async function stepTreeStrike(
  recorder: Recorder,
  story: Story,
): Promise<TreeStrike> {
  return recorder.run(
    "S3",
    "Strike a tree",
    "A fixture strike below the ignition threshold damages the old oak, a tree: the committed events are a divinity spend and a building-damaged event on the oak, both caused by the strike's observation and walkable through the trace; the oak's status changes from operational to damaged in world state, and it is not burning.",
    async (step) => {
      const before = (await readFrame(story.sidecar)).state;
      const oak = building(before, "old-oak");
      const zeusBefore = amountOf(actor(before, "zeus").inventory, "divinity");
      const threshold = before.rules.fireBalance.igniteThreshold ?? 0;
      const power = 1;
      check(
        oak.status === "operational" && oak.combustible && power < threshold,
        "the oak starts operational and combustible, and the strike is below the ignition threshold",
        `${oak.status}, combustible ${oak.combustible}, power ${power}, threshold ${threshold}`,
      );

      const posted = await postFixture(story, strikeTree, {
        "$revision:old-oak": oak.revision,
      });
      check(
        posted.status === 202,
        "the tree strike is accepted",
        `${posted.status} ${fmt(posted.body)}`,
      );
      const outcome = await outcomeOf(
        story,
        posted.proposalId,
        "the tree strike's outcome is recorded in the trace",
      );
      check(
        outcome.outcome === "committed",
        "the tree strike commits",
        `${outcome.outcome} ${outcome.reason}`,
      );
      const caused = eventsOf(story).filter(
        (event) => event.correlationId === posted.observationId,
      );
      check(
        caused.map((event) => event.kind).join() ===
          "resource-consumed,building-damaged",
        "the strike's observation caused exactly a divinity spend and damage",
        caused.map((event) => event.kind).join(),
      );
      const [spend, damaged] = caused;
      check(
        spend !== undefined &&
          damaged !== undefined &&
          outcome.eventIds.join() === [spend.id, damaged.id].join(),
        "the trace lists both events the strike committed, in order",
        outcome.eventIds.join(),
      );
      check(
        spend.payload.resource === "divinity" && spend.payload.amount === power,
        `the strike spends ${power} divinity`,
        fmt(spend.payload),
      );
      check(
        damaged.payload.entityId === "old-oak" &&
          damaged.payload.amount === power,
        "the damage names the old oak and the strike's power",
        fmt(damaged.payload),
      );

      const chain = (await traceEvent(story, damaged.id)).steps;
      const [observation, proposal, validation, event, projection] = chain;
      check(
        observation?.step === "observation" &&
          observation.record.id === posted.observationId &&
          observation.record.source === "fixture" &&
          proposal?.step === "proposal" &&
          proposal.proposalId === posted.proposalId &&
          proposal.record.kind === "strike" &&
          proposal.record.target === "old-oak" &&
          validation?.step === "validation" &&
          validation.outcome === "committed" &&
          event?.step === "event" &&
          event.eventId === damaged.id &&
          projection?.step === "projection-change" &&
          projection.revision === damaged.sequence,
        "the damage traces to the tree strike: observation, proposal, validation, event, projection change",
        chain.map((entry) => entry.step).join(" -> "),
      );

      const after = await waitFor(
        "the damage appears in the committed frame",
        async () => {
          const latest = await readFrame(story.sidecar);
          return latest.frame.sequence >= damaged.sequence ? latest : undefined;
        },
        { timeoutMs: 5000, intervalMs: 50 },
      );
      const oakAfter = building(after.state, "old-oak");
      check(
        oakAfter.status === "damaged" &&
          oakAfter.revision === oak.revision + 1 &&
          oakAfter.fireIntensity === undefined,
        "the oak is damaged, not burning, and its revision advanced by the strike",
        fmt([oakAfter.status, oakAfter.revision, oakAfter.fireIntensity]),
      );
      const zeusAfter = amountOf(
        actor(after.state, "zeus").inventory,
        "divinity",
      );
      check(
        zeusAfter === zeusBefore - power,
        "zeus's divinity dropped by exactly the power spent",
        `${zeusBefore} -> ${zeusAfter}`,
      );

      const facts: TreeStrike = {
        damagedEventId: damaged.id,
        observationId: posted.observationId,
        sessionId: after.frame.sessionId,
      };
      step.done(
        `strike of power ${power} (ignition threshold ${threshold}) at sequences ${spend.sequence}-${damaged.sequence}: old oak ${oak.status} -> ${oakAfter.status} (revision ${oak.revision} -> ${oakAfter.revision}); divinity ${zeusBefore} -> ${zeusAfter}; trace chain ${chain.map((entry) => entry.step).join(" -> ")}`,
        [
          { name: "divinity spent", unit: "divinity", value: power },
          {
            name: "oak revision change",
            unit: "revisions",
            value: oakAfter.revision - oak.revision,
          },
        ],
      );
      return facts;
    },
  );
}
