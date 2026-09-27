import { expect, test } from "bun:test";
import {
  createMemorySampler,
  parseSwapUsage,
  parseVmStat,
  staticPidTarget,
} from "./sample";

const VM_STAT_FIXTURE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                3754.
Pages active:                            365348.
Pages inactive:                          363213.
Pages speculative:                          638.
Pages throttled:                              0.
Pages wired down:                        137829.
Pages purgeable:                           4920.
"Translation faults":               10660779259.
Pages copy-on-write:                  590442559.
Pages zero filled:                   3443238662.
Pages reactivated:                   2703480161.
Pages purged:                         206635803.
File-backed pages:                       181282.
Anonymous pages:                         547917.
Pages stored in compressor:              905173.
Pages occupied by compressor:            125495.
Decompressions:                      2609019910.
Compressions:                        3149374746.
Pageins:                              208823226.
Pageouts:                               5517555.
Swapins:                               55004486.
Swapouts:                              64301281.
`;

test("parseVmStat reads page size, free/active/inactive, and swap counters", () => {
  const parsed = parseVmStat(VM_STAT_FIXTURE);
  expect(parsed).toBeDefined();
  expect(parsed?.pageSizeBytes).toBe(16384);
  expect(parsed?.freePages).toBe(3754);
  expect(parsed?.activePages).toBe(365348);
  expect(parsed?.inactivePages).toBe(363213);
  expect(parsed?.wiredPages).toBe(137829);
  expect(parsed?.compressorPages).toBe(125495);
  expect(parsed?.swapinsTotal).toBe(55004486);
  expect(parsed?.swapoutsTotal).toBe(64301281);
});

test("parseVmStat returns undefined for malformed input, not a throw", () => {
  expect(parseVmStat("")).toBeUndefined();
  expect(parseVmStat("not vm_stat output at all")).toBeUndefined();
  expect(
    parseVmStat("page size of 16384 bytes\nno matching lines"),
  ).toBeUndefined();
});

test("parseSwapUsage reads total/used/free in MiB", () => {
  const text =
    "vm.swapusage: total = 8192.00M  used = 7070.50M  free = 1121.50M  (encrypted)";
  const parsed = parseSwapUsage(text);
  expect(parsed).toEqual({ totalMiB: 8192, usedMiB: 7070.5, freeMiB: 1121.5 });
});

test("parseSwapUsage handles the zero-swap case", () => {
  const text = "vm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M";
  expect(parseSwapUsage(text)).toEqual({ totalMiB: 0, usedMiB: 0, freeMiB: 0 });
});

test("parseSwapUsage returns undefined for malformed input, not a throw", () => {
  expect(parseSwapUsage("")).toBeUndefined();
  expect(parseSwapUsage("vm.swapusage: unavailable")).toBeUndefined();
});

test("createMemorySampler combines vm_stat, swapusage, and per-target RSS into one sample", async () => {
  const runCommand = (command: readonly string[]): string | undefined => {
    const [executable] = command;
    if (executable === "vm_stat") {
      return VM_STAT_FIXTURE;
    }
    if (executable === "sysctl") {
      return "vm.swapusage: total = 1024.00M  used = 100.00M  free = 924.00M";
    }
    if (executable === "ps") {
      return "  2048\n";
    }
    return undefined;
  };
  const sampler = createMemorySampler(
    5,
    [staticPidTarget("sd-server", 4242)],
    runCommand,
  );
  sampler.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const samples = sampler.stop();
  expect(samples.length).toBeGreaterThan(0);
  const sample = samples[0];
  expect(sample?.processRssMiB["sd-server"]).toBe(2);
  expect(sample?.swapUsedMiB).toBe(100);
  expect(sample?.admissionMiB).toBeCloseTo(
    (3754 + 363213) * (16384 / (1024 * 1024)),
    5,
  );
});

test("createMemorySampler skips a tick when vm_stat is unavailable, rather than pushing a broken sample", async () => {
  const sampler = createMemorySampler(5, [], () => undefined);
  sampler.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const samples = sampler.stop();
  expect(samples.length).toBe(0);
});
