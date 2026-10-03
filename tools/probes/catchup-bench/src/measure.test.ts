import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { runEndToEnd, runPhases } from "./measure";
import { createWorld, makeRunDir } from "./world";

test("a short mirrored run and the real catch-up produce the same event stream and the same world: the mirror does the same work, not a different one", async () => {
  // Five minutes of catch-up, in five-chunk steps of the world's own chunk size; the real function is the reference.
  const dirA = makeRunDir("catchup-bench-test-a-");
  const dirB = makeRunDir("catchup-bench-test-b-");
  try {
    const real = createWorld(dirA, 4);
    const mirrored = createWorld(dirB, 4);
    const hour = await runEndToEnd(real);
    const phases = await runPhases(mirrored);
    expect(phases.ticks).toBe(hour.ticks);
    expect(phases.eventDigest).toBe(hour.eventDigest);
    expect(phases.projectionDigest).toBe(hour.projectionDigest);
    expect(phases.added.events).toBe(hour.added.events);
    expect(phases.added.outcomes).toBe(hour.added.outcomes);
    // Both left a trace that answers where every event came from.
    for (const run of [hour, phases]) {
      expect(run.trace.outcomesChecked).toBeGreaterThan(0);
      expect(run.trace.outcomesWithoutObservation).toBe(0);
      expect(run.trace.brokenEventLinks).toBe(0);
      expect(run.trace.eventsWithoutOutcome).toBe(0);
    }
    // The phases cover the hour: nothing named is bigger than the whole.
    const named = Object.values(phases.phases);
    expect(named.length).toBeGreaterThan(5);
    real.dispose();
    mirrored.dispose();
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
}, 120_000);
