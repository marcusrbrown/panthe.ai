// Regression coverage for the "is the malformed-proxy-args fix actually
// verified this run" logic. Feeds synthetic `FixtureRunRecord[]` arrays —
// no subprocess, no quickjs/wasmoon runtime — so this asserts the pure
// decision logic (missing record, or a `terminated` record, must never be
// read as "closed") deterministically and fast.

import { describe, expect, test } from "bun:test";
import type { FixtureRunRecord } from "./host";
import {
  buildProxyFixNarrative,
  checkIntegrityFixtures,
} from "./readme-narrative";

function record(
  fixtureId: string,
  outcome: FixtureRunRecord["outcome"],
  overrides: Partial<FixtureRunRecord> = {},
): FixtureRunRecord {
  return {
    fixtureId,
    runtime: "quickjs",
    category: "malformed-input",
    outcome,
    timeToTerminationMs: 1,
    peakRssBytes: undefined,
    exitCode: 0,
    exitSignal: null,
    supervisorKilled: false,
    childOutput: {
      ok: true,
      durationMs: 1,
      apiLog: { calls: [], status: "committed" },
    },
    stderrTail: undefined,
    ...overrides,
  };
}

/** A records array where every integrity fixture ran and matches its own
 * manifest-declared `expectedOutcome` exactly. */
function allIntegrityFixturesPassing(): FixtureRunRecord[] {
  return [
    record("malformed-proxy-args", "completed"),
    record("malformed-getter-side-effect", "blocked"),
    record("malformed-nested-getter-parity", "blocked"),
    record("malformed-overwrite-descriptor-fn", "completed"),
    record("malformed-proxy-descriptor-trap", "completed"),
  ];
}

describe("readme-narrative integrity checks", () => {
  test("checkIntegrityFixtures: all pass when every fixture ran and matched its expected outcome", () => {
    const checks = checkIntegrityFixtures(allIntegrityFixturesPassing());
    expect(checks).toHaveLength(5);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  test("buildProxyFixNarrative: reports closed when every integrity fixture passes", () => {
    const narrative = buildProxyFixNarrative(allIntegrityFixturesPassing());
    expect(narrative).toContain("the escape is closed");
    expect(narrative).not.toContain("inconclusive");
  });

  test("checkIntegrityFixtures: a missing fixture fails with 'did not run'", () => {
    const records = allIntegrityFixturesPassing().filter(
      (r) => r.fixtureId !== "malformed-getter-side-effect",
    );
    const checks = checkIntegrityFixtures(records);
    const missing = checks.find(
      (c) => c.fixtureId === "malformed-getter-side-effect",
    );
    expect(missing?.ok).toBe(false);
    expect(missing?.reason).toContain("did not run");
  });

  test("checkIntegrityFixtures: a terminated fixture fails (outcome mismatch), never silently passes", () => {
    const records = allIntegrityFixturesPassing().map((r) =>
      r.fixtureId === "malformed-proxy-descriptor-trap"
        ? record(r.fixtureId, "terminated")
        : r,
    );
    const checks = checkIntegrityFixtures(records);
    const terminated = checks.find(
      (c) => c.fixtureId === "malformed-proxy-descriptor-trap",
    );
    expect(terminated?.ok).toBe(false);
    expect(terminated?.reason).toContain("terminated");
  });

  test("buildProxyFixNarrative: one missing + one terminated integrity fixture is reported inconclusive, never closed", () => {
    const records = allIntegrityFixturesPassing()
      .filter((r) => r.fixtureId !== "malformed-getter-side-effect")
      .map((r) =>
        r.fixtureId === "malformed-nested-getter-parity"
          ? record(r.fixtureId, "terminated")
          : r,
      );

    const narrative = buildProxyFixNarrative(records);

    expect(narrative).toContain("inconclusive");
    expect(narrative).not.toContain("the escape is closed");
    // Names both failures explicitly, not just a generic "something failed".
    expect(narrative).toContain("malformed-getter-side-effect");
    expect(narrative).toContain("did not run");
    expect(narrative).toContain("malformed-nested-getter-parity");
    expect(narrative).toContain("terminated");
  });

  test("buildProxyFixNarrative: an empty records array (nothing ran) is reported inconclusive, never closed", () => {
    const narrative = buildProxyFixNarrative([]);
    expect(narrative).toContain("inconclusive");
    expect(narrative).not.toContain("the escape is closed");
  });
});
