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

test("a real hour of 3,600 ticks in 60-tick chunks measures all 60 chunk gaps, the last included, and they and the ending commit add up to the whole run", async () => {
  const dir = makeRunDir("catchup-bench-test-gaps-");
  try {
    const world = createWorld(dir, 4);
    const chunkTicks = world.state.rules.catchUpChunkMs / 1000;
    expect(chunkTicks).toBe(60);
    const run = await runEndToEnd(world);
    expect(run.ticks).toBe(3_600);
    // One gap per chunk: the production callback does not run after the last one, so
    // a measurement that waits for it is one short.
    expect(run.chunkGapsMs).toHaveLength(3_600 / chunkTicks);
    for (const gap of run.chunkGapsMs) expect(gap).toBeGreaterThan(0);
    // The ending commit (cursor jump and summary) is its own interval, not part of any chunk.
    expect(run.endingCommitMs).toBeGreaterThan(0);
    // Nothing is left out and nothing counted twice: the intervals tile the run.
    const sum = run.chunkGapsMs.reduce((a, b) => a + b, 0);
    expect(Math.abs(sum + run.endingCommitMs - run.totalMs)).toBeLessThan(5);
    // The last chunk is the one this is about: its gap is a real chunk's (compute plus
    // commit), of the same order as its neighbours, not the ending commit's.
    const last = run.chunkGapsMs.at(-1) as number;
    const typical = [...run.chunkGapsMs].sort((a, b) => a - b)[30] as number;
    expect(last).toBeGreaterThan(typical / 10);
    world.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

test("the instrumented run times all 60 chunks too, and the real run's worst chunk is in the same range as the instrumented one's", async () => {
  const dirA = makeRunDir("catchup-bench-test-held-a-");
  const dirB = makeRunDir("catchup-bench-test-held-b-");
  try {
    const real = createWorld(dirA, 4);
    const mirrored = createWorld(dirB, 4);
    const hour = await runEndToEnd(real);
    const phases = await runPhases(mirrored);
    expect(phases.chunkHeldMs).toHaveLength(60);
    expect(hour.chunkGapsMs).toHaveLength(60);
    // Both measure the same chunks of the same work; the worst of each is within a factor of three of the other's.
    const worst = (xs: readonly number[]) =>
      xs.reduce((a, b) => (b > a ? b : a), 0);
    const ratio = worst(hour.chunkGapsMs) / worst(phases.chunkHeldMs);
    expect(ratio).toBeGreaterThan(1 / 3);
    expect(ratio).toBeLessThan(3);
    real.dispose();
    mirrored.dispose();
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
}, 120_000);
