// S5: fire burns for the authored number of ticks, destroys the tavern, and
// disposes its goods through a declared sink.

import { check, expectedBurnTicks, waitFor } from "../helpers";
import { fmt, readFrame } from "./api";
import type { Recorder, Story } from "./context";
import { eventsOf } from "./direct";
import type { StrikeFacts } from "./s04-strike";
import { building } from "./state";

export async function stepFire(
  recorder: Recorder,
  story: Story,
  strike: StrikeFacts,
): Promise<void> {
  await recorder.run(
    "S5",
    "Fire",
    "Fire burns on its own after ignition for the authored number of ticks, destroys the tavern, and disposes its goods through a declared sink; a non-combustible building never ignites.",
    async (step) => {
      const ignitedSequence = strike.sequence;
      const destroyed = await waitFor(
        "the tavern is destroyed by fire",
        () =>
          eventsOf(story, ignitedSequence).find(
            (event) =>
              event.kind === "building-destroyed" &&
              event.payload.entityId === "the-tavern",
          ),
        { timeoutMs: 20_000, intervalMs: 100 },
      );
      const { state } = await readFrame(story.sidecar);
      const rules = state.rules.fireBalance;
      const growth = rules.intensityGrowthPerTick ?? 1;
      const burnTicks = eventsOf(story, ignitedSequence).filter(
        (event) =>
          event.kind === "building-burn-ticked" &&
          event.payload.entityId === "the-tavern" &&
          event.sequence < destroyed.sequence,
      );
      const expected = expectedBurnTicks(rules.destroyIntensity ?? 3, growth);
      check(
        burnTicks.length === expected,
        "the fire burns for the authored number of ticks",
        `${burnTicks.length} burn ticks, expected ${expected}`,
      );
      const intensities = burnTicks.map((event) => event.payload.fireIntensity);
      check(
        intensities.every((value, index) => value === (index + 1) * growth),
        "burn intensity grows by the authored rate",
        fmt(intensities),
      );
      const disposed = destroyed.payload.disposedInventory as {
        resource: string;
        amount: number;
      }[];
      const before = strike.tavernInventoryBefore;
      check(
        disposed.length === before.size &&
          disposed.every((line) => before.get(line.resource) === line.amount),
        "the goods lost in the fire are exactly the tavern's inventory (a declared sink)",
        `${fmt(disposed)} vs ${fmt([...before])}`,
      );
      const tavern = building(state, "the-tavern");
      check(
        tavern.status === "destroyed" && tavern.inventory.size === 0,
        "the destroyed tavern holds nothing",
        `${tavern.status} ${fmt([...tavern.inventory])}`,
      );
      check(
        building(state, "agora-shop").status === "operational",
        "the non-combustible shop never ignites",
        building(state, "agora-shop").status,
      );
      const ticksToDestroy = burnTicks.length + 1;
      step.done(
        `${burnTicks.length} burn ticks then destroyed at sequence ${destroyed.sequence} (${ticksToDestroy} ticks after ignition); disposed ${fmt(disposed)}; shop ${building(state, "agora-shop").status}; old oak ${building(state, "old-oak").status}`,
        [
          {
            name: "ticks from ignition to destruction",
            unit: "ticks",
            value: ticksToDestroy,
          },
        ],
      );
    },
  );
}
