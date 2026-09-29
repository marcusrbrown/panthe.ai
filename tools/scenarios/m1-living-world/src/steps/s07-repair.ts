// S7: a fixture repair accepted while the world is paused stays pending until
// ticking resumes, then commits and restores the tavern.

import { effectiveServices } from "@panthea/world";
import repair from "../fixtures/repair.json";
import { check, waitFor } from "../helpers";
import { fmt, outcomeOf, postFixture, readFrame, waitForTicks } from "./api";
import type { Recorder, Story } from "./context";
import { eventsOf } from "./direct";
import { actor, amountOf, building } from "./state";

export async function stepRepair(
  recorder: Recorder,
  story: Story,
): Promise<void> {
  await recorder.run(
    "S7",
    "Repair",
    "A fixture repair by an actor holding planks, accepted while the world is paused, stays pending until ticking resumes and then commits, taking the actor's slot from its routine. Repair spends exactly the authored cost in planks; service and income return and the goods lost in the fire stay lost.",
    async (step) => {
      const destroyedAt = eventsOf(story).find(
        (event) =>
          event.kind === "building-destroyed" &&
          event.payload.entityId === "the-tavern",
      );
      check(
        destroyedAt !== undefined,
        "the destruction is on record before repair starts",
        "no building-destroyed event",
      );

      // The world is paused, so who holds planks is frozen while the fixture is chosen.
      let repairer: string | undefined;
      for (
        let attempt = 1;
        attempt <= 12 && repairer === undefined;
        attempt += 1
      ) {
        const { state } = await readFrame(story.sidecar);
        check(
          ["destroyed", "repairing"].includes(
            building(state, "the-tavern").status,
          ),
          "the tavern still needs repair",
          building(state, "the-tavern").status,
        );
        repairer = ["farmer", "woodcutter"].find(
          (id) => amountOf(actor(state, id).inventory, "planks") >= 1,
        );
        if (repairer === undefined) {
          await story.sidecar.request("POST", "/resume");
          await waitForTicks(
            story,
            1,
            "a tick passes while nobody holds planks",
          );
          await story.sidecar.request("POST", "/pause");
        }
      }
      check(
        repairer !== undefined,
        "some actor holds planks to repair with",
        "none within 12 ticks",
      );

      const tickWhilePaused = (await readFrame(story.sidecar)).state.tick;
      const posted = await postFixture(story, repair, { $actor: repairer });
      check(
        posted.status === 202 &&
          (posted.body as { status?: string }).status === "pending",
        "the repair fixture is accepted as pending",
        `${posted.status} ${fmt(posted.body)}`,
      );
      await Bun.sleep(1500);
      const retryWhilePaused = await story.sidecar.request(
        "POST",
        "/proposals",
        posted.envelope,
      );
      const tickAfterWait = (await readFrame(story.sidecar)).state.tick;
      check(
        tickAfterWait === tickWhilePaused &&
          (retryWhilePaused.body as { status?: string }).status === "pending",
        "a proposal accepted while paused stays pending: no tick, and a retry reports pending",
        `tick ${tickAfterWait} vs ${tickWhilePaused}, ${fmt(retryWhilePaused.body)}`,
      );

      const resumed = await story.sidecar.request("POST", "/resume");
      check(
        resumed.status === 200,
        "POST /resume answers",
        `${resumed.status} ${fmt(resumed.body)}`,
      );
      const outcome = await outcomeOf(
        story,
        posted.proposalId,
        "the fixture repair's outcome is recorded once ticking resumes",
      );
      check(
        outcome.outcome === "committed",
        "a fixture repair by an actor holding planks commits (its routine yielded the slot)",
        `${outcome.outcome} ${outcome.reason}`,
      );
      const fixtureEvents = eventsOf(story).filter(
        (event) => event.correlationId === posted.observationId,
      );
      check(
        fixtureEvents[0]?.kind === "repair-progressed" &&
          fixtureEvents[0].payload.entityId === repairer,
        "the fixture's repair step is by the actor it named",
        fixtureEvents.map((event) => event.kind).join(),
      );
      const sameTickByRoutine = eventsOf(story).filter(
        (event) =>
          event.payload.simTime === fixtureEvents[0]?.payload.simTime &&
          event.payload.entityId === repairer &&
          event.correlationId !== posted.observationId &&
          !event.correlationId.startsWith("tick-"),
      );
      check(
        sameTickByRoutine.length === 0,
        "the repairer's routine did not also act in that tick",
        sameTickByRoutine.map((event) => event.kind).join(),
      );

      const repaired = await waitFor(
        "the tavern is repaired",
        () =>
          eventsOf(story, destroyedAt.sequence).find(
            (event) =>
              event.kind === "building-repaired" &&
              event.payload.entityId === "the-tavern",
          ),
        { timeoutMs: 40_000, intervalMs: 100 },
      );
      const { state } = await readFrame(story.sidecar);
      const cost = state.rules.economyBalance.repairCostPlanks ?? 0;
      const progress = eventsOf(story, destroyedAt.sequence).filter(
        (event) =>
          event.kind === "repair-progressed" &&
          event.payload.structureId === "the-tavern" &&
          event.sequence < repaired.sequence,
      );
      const spent = progress.reduce(
        (sum, event) => sum + (event.payload.amount as number),
        0,
      );
      check(
        progress.every((event) => event.payload.resource === "planks"),
        "repair spends only planks",
        fmt(progress.map((event) => event.payload.resource)),
      );
      check(
        progress.some((event) => event.correlationId === posted.observationId),
        "the fixture contributed repair progress",
        "no fixture progress found",
      );
      check(
        spent === cost,
        "repair spends exactly the authored cost",
        `${spent} planks spent, cost ${cost}`,
      );
      const repairedEvents = eventsOf(story, destroyedAt.sequence).filter(
        (event) =>
          event.kind === "building-repaired" &&
          event.payload.entityId === "the-tavern",
      );
      check(
        repairedEvents.length === 1,
        "the tavern is repaired exactly once",
        `${repairedEvents.length}`,
      );
      const tavern = building(state, "the-tavern");
      check(
        tavern.status === "operational",
        "the repaired tavern is operational",
        tavern.status,
      );
      check(
        effectiveServices(tavern).join() === "drink",
        "the repaired tavern offers its service again",
        fmt(effectiveServices(tavern)),
      );
      check(
        tavern.inventory.size === 0,
        "the goods lost in the fire stay lost",
        fmt([...tavern.inventory]),
      );
      await waitFor(
        "the repaired tavern earns income again",
        () =>
          eventsOf(story, repaired.sequence).find(
            (event) =>
              event.kind === "income-earned" &&
              event.payload.buildingId === "the-tavern",
          ),
        { timeoutMs: 10_000, intervalMs: 100 },
      );
      const ticksDown =
        Math.round((repaired.payload.simTime as number) / 1000) -
        Math.round((destroyedAt.payload.simTime as number) / 1000);
      step.done(
        `${progress.length} repair steps spent ${spent} planks (cost ${cost}); the fixture repair by ${repairer} was accepted while paused, stayed pending through 1.5 s with no tick (a retry reported pending), and committed once resumed; tavern operational again ${ticksDown} ticks after destruction`,
        [
          { name: "planks spent on repair", unit: "planks", value: spent },
          {
            name: "ticks from destruction to repair",
            unit: "ticks",
            value: ticksDown,
          },
        ],
      );
    },
  );
}
