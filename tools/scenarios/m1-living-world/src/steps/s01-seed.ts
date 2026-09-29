// S1: the fresh world loads the authored seed and its first frame carries no
// catch-up summary.

import { effectiveServices } from "@panthea/world";
import { createHeadlessClient } from "../client";
import { check } from "../helpers";
import { fmt, readFrame, waitForLog } from "./api";
import type { Recorder, Story } from "./context";
import { actor, amountOf, building } from "./state";

export async function stepSeed(
  recorder: Recorder,
  story: Story,
): Promise<void> {
  await recorder.run(
    "S1",
    "Seed",
    "A fresh data directory loads the authored Greek world across three realms with nothing committed yet, and its first frame carries no catch-up summary.",
    async (step) => {
      await waitForLog(
        story.sidecar,
        "startup catch-up complete",
        "the startup catch-up of the fresh world finishes",
      );
      const { frame, state } = await readFrame(story.sidecar);
      check(
        frame.catchUpSummary === undefined,
        "a fresh world's first frame has no catch-up summary",
        fmt(frame.catchUpSummary),
      );
      const locations = [...state.locations.values()];
      const realms = Object.fromEntries(
        [...new Set(locations.map((location) => location.realm))].map(
          (realm) => [
            realm,
            locations.filter((location) => location.realm === realm).length,
          ],
        ),
      );
      check(
        Object.keys(realms).sort().join() === "mortal,olympus,underworld",
        "the seed spans mortal, olympus, and underworld",
        fmt(realms),
      );
      for (const id of ["woodcutter", "farmer", "zeus"]) actor(state, id);
      for (const id of ["agora-shop", "the-tavern", "old-oak"]) {
        check(
          building(state, id).status === "operational",
          `${id} starts operational`,
          building(state, id).status,
        );
      }
      check(
        effectiveServices(building(state, "the-tavern")).join() === "drink",
        "the tavern offers its authored service while operational",
        fmt(effectiveServices(building(state, "the-tavern"))),
      );
      check(
        amountOf(actor(state, "zeus").inventory, "divinity") === 10,
        "zeus starts with 10 divinity",
        fmt([...actor(state, "zeus").inventory]),
      );
      check(
        frame.status === "running",
        "the fresh world is running",
        frame.status,
      );
      check(
        frame.sequence === 0,
        "nothing is committed at seed",
        `frame ${frame.sequence}`,
      );

      // The client follows the farmer, in the mortal realm, for the rest of the run.
      story.clients.push(
        createHeadlessClient({ kind: "actor", id: "farmer" }, story.sidecar),
      );

      step.done(
        `${state.locations.size} locations (${Object.entries(realms)
          .map(([realm, n]) => `${realm} ${n}`)
          .join(
            ", ",
          )}), ${state.actors.size} actors, ${state.buildings.size} buildings, sequence ${frame.sequence}; first frame has no catch-up summary`,
        [
          {
            name: "seed locations",
            unit: "count",
            value: state.locations.size,
          },
          { name: "seed actors", unit: "count", value: state.actors.size },
          {
            name: "seed buildings",
            unit: "count",
            value: state.buildings.size,
          },
        ],
      );
    },
  );
}
