// S4: a deity's fixture strike commits through the validator and ignites the
// tavern.

import strike from "../fixtures/strike.json";
import { check, waitFor } from "../helpers";
import { fmt, outcomeOf, postFixture, readFrame } from "./api";
import type { Recorder, Story } from "./context";
import { eventsOf } from "./direct";
import { actor, amountOf, building } from "./state";

/** What later steps need from the tavern strike. */
export interface StrikeFacts {
  readonly tavernInventoryBefore: ReadonlyMap<string, number>;
  readonly observationId: string;
  readonly proposalId: string;
  readonly firstEventId: string;
  readonly ignitedEventId: string;
  readonly sessionId: string;
  /** The committed sequence of the ignition. */
  readonly sequence: number;
}

export async function stepStrike(
  recorder: Recorder,
  story: Story,
): Promise<StrikeFacts> {
  return recorder.run(
    "S4",
    "Strike",
    "A deity's fixture strike commits through the validator: divinity is spent and the combustible tavern ignites, both caused by the strike's observation.",
    async (step) => {
      const { state } = await readFrame(story.sidecar);
      const tavern = building(state, "the-tavern");
      const zeusBefore = amountOf(actor(state, "zeus").inventory, "divinity");
      const tavernInventoryBefore = new Map(tavern.inventory);
      const priorIncome = eventsOf(story).filter(
        (event) =>
          event.kind === "income-earned" &&
          event.payload.buildingId === "the-tavern",
      ).length;
      check(
        priorIncome > 0,
        "the operational tavern earned income before the strike",
        `${priorIncome}`,
      );

      const posted = await postFixture(story, strike, {
        "$revision:the-tavern": tavern.revision,
      });
      check(
        posted.status === 202,
        "the strike fixture is accepted for the next tick",
        `${posted.status} ${fmt(posted.body)}`,
      );
      const outcome = await outcomeOf(
        story,
        posted.proposalId,
        "the strike's outcome is recorded in the trace",
      );
      check(
        outcome.outcome === "committed",
        "the strike commits",
        `${outcome.outcome} ${outcome.reason}`,
      );

      const caused = eventsOf(story).filter(
        (event) => event.correlationId === posted.observationId,
      );
      check(
        caused.map((event) => event.kind).join() ===
          "resource-consumed,building-ignited",
        "the strike's observation caused exactly a divinity spend and an ignition",
        caused.map((event) => event.kind).join(),
      );
      const [spend, ignited] = caused;
      check(
        spend !== undefined &&
          ignited !== undefined &&
          outcome.eventIds.join() === [spend.id, ignited.id].join(),
        "the trace lists every event the strike committed, in order",
        outcome.eventIds.join(),
      );
      check(
        spend.payload.resource === "divinity" && spend.payload.amount === 3,
        "the strike spends 3 divinity",
        fmt(spend.payload),
      );
      check(
        ignited.payload.entityId === "the-tavern",
        "the ignition names the tavern",
        fmt(ignited.payload),
      );

      const burning = await waitFor(
        "the tavern is observed burning",
        async () => {
          const latest = await readFrame(story.sidecar);
          const now = building(latest.state, "the-tavern");
          return now.status === "burning" ? { latest, now } : undefined;
        },
        { timeoutMs: 8000, intervalMs: 50 },
      );
      const zeusAfter = amountOf(
        actor(burning.latest.state, "zeus").inventory,
        "divinity",
      );
      check(
        zeusAfter === zeusBefore - 3,
        "zeus's divinity dropped by exactly the power spent",
        `${zeusBefore} -> ${zeusAfter}`,
      );

      const facts: StrikeFacts = {
        tavernInventoryBefore,
        observationId: posted.observationId,
        proposalId: posted.proposalId,
        firstEventId: spend.id,
        ignitedEventId: ignited.id,
        sessionId: burning.latest.frame.sessionId,
        sequence: ignited.sequence,
      };
      step.done(
        `strike committed at sequences ${spend.sequence}-${ignited.sequence}; divinity ${zeusBefore} -> ${zeusAfter}; tavern burning at intensity ${burning.now.fireIntensity ?? "?"}`,
        [
          {
            name: "divinity spent",
            unit: "divinity",
            value: zeusBefore - zeusAfter,
          },
        ],
      );
      return facts;
    },
  );
}
