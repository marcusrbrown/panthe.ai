import { expect, test } from "bun:test";
import { createSampler, p50, p95, summarize } from "./timing";

test("p50/p95 match hand-computed values for 100 samples", () => {
  const samples = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  expect(p50(samples)).toBe(50);
  expect(p95(samples)).toBe(95);
});

test("empty sample set returns undefined, not NaN", () => {
  expect(p50([])).toBeUndefined();
  expect(p95([])).toBeUndefined();
  expect(summarize([])).toEqual({ p50: undefined, p95: undefined });
});

test("odd sample count uses nearest-rank on unsorted input", () => {
  const samples = [5, 3, 1, 4, 2];
  expect(p50(samples)).toBe(3);
});

test("even sample count uses nearest-rank on unsorted input", () => {
  const samples = [8, 6, 2, 4]; // sorted: [2, 4, 6, 8]
  expect(p50(samples)).toBe(4);
});

test("unsorted input gives the same result as pre-sorted input", () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const shuffled = [7, 2, 9, 1, 5, 10, 3, 8, 4, 6];
  expect(p50(shuffled)).toBe(p50(sorted));
  expect(p95(shuffled)).toBe(p95(sorted));
});

test("sampler records at least one sample and stops cleanly", async () => {
  const sampler = createSampler(5);
  sampler.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  const samples = sampler.stop();
  expect(samples.length).toBeGreaterThan(0);
  expect(typeof samples[0]?.rss).toBe("number");
  expect(typeof samples[0]?.cpu.user).toBe("number");
});
