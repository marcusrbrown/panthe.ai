// Runs a curated subset of the Lua fixture matrix through the real
// subprocess host (not mocked) — same rationale as quickjs.test.ts.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type FixtureCategory, getFixture } from "./fixtures/manifest";
import { runFixtureInSubprocess } from "./host";

const RUN_FILE_PATH = join(import.meta.dir, "run.ts");

function run(fixtureId: string, category: FixtureCategory) {
  return runFixtureInSubprocess({
    runFilePath: RUN_FILE_PATH,
    runtime: "lua",
    fixtureId,
    category,
    expect: getFixture(fixtureId).expect,
  });
}

describe("lua sandbox", () => {
  test("happy path lands both calls", async () => {
    const record = await run("happy-path", "happy-path");
    expect(record.outcome).toBe("completed");
    expect(record.childOutput?.ok).toBe(true);
    expect(record.childOutput?.apiLog.calls.length).toBe(2);
    expect(record.childOutput?.apiLog.status).toBe("committed");
  }, 10_000);

  test("external-capability fixtures are blocked by the absence of any standard library", async () => {
    const ids = [
      "external-require",
      "external-io-os",
      "external-process",
      "external-globalthis-leak",
      "external-function-eval-ctor",
    ];
    for (const id of ids) {
      const record = await run(id, "external-capability");
      expect(record.outcome).not.toBe("escaped");
      expect(record.childOutput?.apiLog.calls.length ?? 0).toBe(0);
    }
  }, 30_000);

  test("infinite loop terminates within the deadline via the lua_sethook count hook", async () => {
    const record = await run("loop-infinite", "loop-recursion");
    expect(record.outcome).toBe("terminated");
    expect(record.timeToTerminationMs).toBeLessThan(2000);
  }, 5_000);

  test("deep recursion hits the stack limit", async () => {
    const record = await run("loop-deep-recursion", "loop-recursion");
    expect(record.outcome).toBe("terminated");
  }, 5_000);

  test("allocation bomb terminates, with isolated RSS recorded honestly", async () => {
    const record = await run("allocation-array-growth", "allocation");
    expect(record.outcome).toBe("terminated");
    expect(record.peakRssBytes).toBeGreaterThan(0);
  }, 5_000);

  test("malformed API input is blocked with no committed effect", async () => {
    const record = await run("malformed-wrong-types", "malformed-input");
    expect(record.outcome).toBe("blocked");
    expect(record.childOutput?.apiLog.calls.length ?? 0).toBe(0);
  }, 5_000);

  test("over-budget calls stop exactly at the invocation budget", async () => {
    const record = await run("malformed-over-budget", "malformed-input");
    expect(record.childOutput?.apiLog.calls.length).toBe(50);
    expect(record.childOutput?.apiLog.status).toBe("rolled-back");
  }, 5_000);

  test("after a terminated fixture, the next valid behavior runs in a fresh engine", async () => {
    const terminated = await run("loop-infinite", "loop-recursion");
    expect(terminated.outcome).toBe("terminated");
    const followUp = await run("happy-path", "happy-path");
    expect(followUp.outcome).toBe("completed");
  }, 10_000);

  test("partial-failure leaves exactly the staged calls and a rolled-back marker", async () => {
    const record = await run("partial-failure", "partial-failure");
    expect(record.childOutput?.apiLog.calls.length).toBe(2);
    expect(record.childOutput?.apiLog.status).toBe("rolled-back");
  }, 5_000);
});
