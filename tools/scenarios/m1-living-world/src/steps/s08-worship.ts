// S8: a fixture worship by a mortal with a routine commits, and its favor
// raises the worshiper's gather yield until it expires.

import worship from "../fixtures/worship.json";
import { check, waitFor } from "../helpers";
import type { EventRow } from "../world-db";
import { fmt, outcomeOf, postFixture, readFrame } from "./api";
import type { Recorder, Story } from "./context";
import { eventsOf } from "./direct";
import { actor, amountOf } from "./state";

/** What later steps need from the worship. */
export interface WorshipFacts {
  readonly eventId: string;
  readonly sessionId: string;
}

export async function stepWorship(
  recorder: Recorder,
  story: Story,
): Promise<WorshipFacts> {
  return recorder.run(
    "S8",
    "Worship and favor",
    "A fixture worship by a mortal with a routine commits (its routine yields the slot): the deity's divinity rises by the authored gain, the worshiper holds a favor with its source and duration, the favor raises the worshiper's gather yield while it lasts, and the yield returns to normal once it expires.",
    async (step) => {
      const before = (await readFrame(story.sidecar)).state;
      const divinityBefore = amountOf(
        actor(before, "zeus").inventory,
        "divinity",
      );

      const posted = await postFixture(story, worship);
      check(
        posted.status === 202,
        "the worship fixture is accepted",
        `${posted.status} ${fmt(posted.body)}`,
      );
      const outcome = await outcomeOf(
        story,
        posted.proposalId,
        "the worship outcome is recorded",
      );
      check(
        outcome.outcome === "committed",
        "a fixture worship by an actor with a routine commits",
        `${outcome.outcome} ${outcome.reason}`,
      );
      const caused = eventsOf(story).filter(
        (event) => event.correlationId === posted.observationId,
      );
      check(
        caused.map((event) => event.kind).join() === "worship-performed",
        "worship commits exactly one worship event",
        caused.map((event) => event.kind).join(),
      );
      const [performed] = caused;
      check(
        performed !== undefined && outcome.eventIds[0] === performed.id,
        "the trace lists the worship event",
        outcome.eventIds.join(),
      );
      const worshipTick = Math.round(
        (performed.payload.simTime as number) / 1000,
      );
      const routineSameTick = eventsOf(story).filter(
        (event) =>
          event.payload.simTime === performed.payload.simTime &&
          event.payload.entityId === "woodcutter" &&
          event.correlationId !== posted.observationId &&
          !event.correlationId.startsWith("tick-"),
      );
      check(
        routineSameTick.length === 0,
        "the woodcutter's routine yielded that tick",
        routineSameTick.map((event) => event.kind).join(),
      );

      const after = await waitFor(
        "the worship appears in the committed frame",
        async () => {
          const latest = await readFrame(story.sidecar);
          return latest.frame.sequence >= performed.sequence
            ? latest
            : undefined;
        },
        { timeoutMs: 5000, intervalMs: 50 },
      );
      const economy = after.state.rules.economyBalance;
      const gain = economy.worshipCapacityGain ?? 1;
      const duration = economy.favorDurationTicks ?? 0;
      const bonus = economy.favorGatherBonus ?? 0;
      const base = economy.gatherAmount ?? 0;
      const divinityAfter = amountOf(
        actor(after.state, "zeus").inventory,
        "divinity",
      );
      check(
        divinityAfter === divinityBefore + gain,
        "worship raises the deity's divinity by the authored gain",
        `${divinityBefore} -> ${divinityAfter}, gain ${gain}`,
      );
      const expiresAt = performed.payload.favorExpiresAtTick as number;
      check(
        expiresAt - worshipTick === duration,
        "the favor lasts the authored duration",
        `expires ${expiresAt}, granted at tick ${worshipTick}, duration ${duration}`,
      );
      const favor = (actor(after.state, "woodcutter").favors ?? []).find(
        (candidate) => candidate.expiresAtTick === expiresAt,
      );
      check(
        favor !== undefined &&
          favor.source === "zeus" &&
          favor.effect === "divine-favor",
        "the worshiper holds the favor with zeus as its source",
        fmt(actor(after.state, "woodcutter").favors),
      );

      const gatherTick = (event: EventRow) =>
        Math.round((event.payload.simTime as number) / 1000);
      const woodcutterGathers = (from: number) =>
        eventsOf(story, from).filter(
          (event) =>
            event.kind === "resource-gathered" &&
            event.payload.entityId === "woodcutter",
        );
      const boosted = await waitFor(
        "the woodcutter gathers with the favor's bonus while it lasts",
        () =>
          woodcutterGathers(performed.sequence).find(
            (event) =>
              gatherTick(event) < expiresAt &&
              event.payload.amount === base + bonus,
          ),
        { timeoutMs: (duration + 5) * 1000, intervalMs: 100 },
      );
      const plainBefore = woodcutterGathers(1).filter(
        (event) => event.sequence < performed.sequence,
      );
      check(
        plainBefore.length > 0 &&
          plainBefore.every((event) => event.payload.amount === base),
        "before the favor, every woodcutter gather yielded the base amount",
        fmt(plainBefore.map((event) => event.payload.amount)),
      );

      const expired = await waitFor(
        "the woodcutter gathers again after the favor expires",
        () =>
          woodcutterGathers(performed.sequence).find(
            (event) => gatherTick(event) >= expiresAt,
          ),
        { timeoutMs: (duration + 15) * 1000, intervalMs: 100 },
      );
      check(
        expired.payload.amount === base,
        "after the favor expires the gather yield returns to the base amount",
        `${expired.payload.amount} vs base ${base}`,
      );

      const facts: WorshipFacts = {
        eventId: performed.id,
        sessionId: after.frame.sessionId,
      };
      step.done(
        `worship at sequence ${performed.sequence} (tick ${worshipTick}): divinity ${divinityBefore} -> ${divinityAfter}; favor from zeus expires at tick ${expiresAt} (${duration} ticks); gather ${base + bonus} at tick ${gatherTick(boosted)} inside the window, ${expired.payload.amount} at tick ${gatherTick(expired)} after it`,
        [
          {
            name: "divinity gained from worship",
            unit: "divinity",
            value: divinityAfter - divinityBefore,
          },
          { name: "favor duration", unit: "ticks", value: duration },
          {
            name: "favored gather yield over base",
            unit: "resource",
            value: (boosted.payload.amount as number) - base,
          },
        ],
      );
      return facts;
    },
  );
}
