// S6: a burning and then destroyed tavern offers no services and earns no
// income while the untouched shop keeps earning.

import { effectiveServices } from "@panthea/world";
import { check, waitFor } from "../helpers";
import { fmt, readFrame } from "./api";
import type { Recorder, Story } from "./context";
import { eventsOf } from "./direct";
import type { StrikeFacts } from "./s04-strike";
import { building } from "./state";

export async function stepLostService(
  recorder: Recorder,
  story: Story,
  strike: StrikeFacts,
): Promise<void> {
  await recorder.run(
    "S6",
    "Lost service",
    "A burning and then destroyed tavern offers no services and earns no income while the untouched shop keeps earning. The operator pauses the world once the tavern is down.",
    async (step) => {
      const paused = await story.sidecar.request("POST", "/pause");
      check(
        paused.status === 200,
        "POST /pause answers",
        `${paused.status} ${fmt(paused.body)}`,
      );
      await waitFor(
        "the frame reports paused",
        async () =>
          (await readFrame(story.sidecar)).frame.status === "paused"
            ? true
            : undefined,
        { timeoutMs: 5000, intervalMs: 50 },
      );
      const { state } = await readFrame(story.sidecar);
      const tavern = building(state, "the-tavern");
      check(
        tavern.services.join() === "drink",
        "the tavern's authored services survive destruction",
        fmt(tavern.services),
      );
      check(
        ["destroyed", "repairing"].includes(tavern.status),
        "the tavern is down when the world is paused",
        tavern.status,
      );
      check(
        effectiveServices(tavern).length === 0,
        "a destroyed tavern offers no services",
        fmt(effectiveServices(tavern)),
      );

      // From ignition to destruction the tavern never earned, and the shop did.
      const ignitedSequence = strike.sequence;
      const destroyed = eventsOf(story, ignitedSequence).find(
        (event) =>
          event.kind === "building-destroyed" &&
          event.payload.entityId === "the-tavern",
      );
      check(
        destroyed !== undefined,
        "the destruction is on record",
        "no building-destroyed event",
      );
      const fireWindow = eventsOf(story, ignitedSequence).filter(
        (event) =>
          event.kind === "income-earned" &&
          event.sequence <= destroyed.sequence,
      );
      const tavernIncome = fireWindow.filter(
        (event) => event.payload.buildingId === "the-tavern",
      ).length;
      const shopIncome = fireWindow.filter(
        (event) => event.payload.buildingId === "agora-shop",
      ).length;
      check(
        tavernIncome === 0,
        "a burning tavern earns no income",
        `${tavernIncome} income events`,
      );
      check(
        shopIncome > 0,
        "the untouched shop kept earning through the fire",
        `${shopIncome} income events`,
      );
      step.done(
        `world paused with the tavern ${tavern.status}: services ${fmt(effectiveServices(tavern))} of authored ${fmt(tavern.services)}; from ignition to destruction tavern income events ${tavernIncome}, shop ${shopIncome}`,
        [
          {
            name: "tavern income events during the fire",
            unit: "count",
            value: tavernIncome,
          },
          {
            name: "shop income events during the fire",
            unit: "count",
            value: shopIncome,
          },
        ],
      );
    },
  );
}
