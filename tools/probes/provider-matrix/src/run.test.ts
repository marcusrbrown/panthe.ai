import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBottomLine,
  buildFindings,
  type ContractResult,
  type ControlResult,
  type LiveResult,
  loadLatestModeResult,
  type OfflineResult,
  renderControlFinding,
  selectLiveRunPlan,
  writeLatestModeResult,
} from "./run";

const SAMPLE_LIVE: LiveResult = {
  authKeyName: { zen: "opencode", go: "opencode-go" },
  sameCredential: true,
  zenModels: [],
  goFreeModels: [],
  goSkippedReason: "scope-note fixture: Go arm not exercised in this test",
  fallbackTrace: [],
  fallbackDegraded: false,
};

const SAMPLE_OFFLINE: OfflineResult = {
  routerGuarantee: { requestCount: 20, hostedClientConstructions: 0 },
  capture: { status: "silent", totalPackets: 4 },
};

const SAMPLE_CONTRACT: ContractResult = {
  openaiRepairedAction: { kind: "idle" },
  anthropicRepairedAction: { kind: "idle" },
  parity: true,
  noActionFailsIdentically: true,
};

const CONTROL_NOT_SILENT: ControlResult = {
  capture: {
    status: "not-silent",
    totalPackets: 3,
    providerPackets: 2,
    providerDnsLookups: 0,
    sampleLines: [
      "1758901234.000000 IP 10.0.0.5.51234 > 5.6.7.8.443: Flags [S]",
    ],
  },
};

const CONTROL_SILENT: ControlResult = {
  capture: { status: "silent", totalPackets: 0 },
};

const CONTROL_REQUEST_FAILED: ControlResult = {
  capture: { status: "silent", totalPackets: 0 },
  requestError: "Go is not configured in auth.json",
};

describe("selectLiveRunPlan (live-run arm selection, no network)", () => {
  test("Go-only auth fixture selects the Go matrix and skips Zen with a clear message", () => {
    const plan = selectLiveRunPlan({
      zen: { configured: false },
      go: { configured: true },
    });

    expect(plan.runGo).toBe(true);
    expect(plan.goSkippedReason).toBeUndefined();
    expect(plan.runZen).toBe(false);
    expect(plan.zenSkippedReason).toBeDefined();
    expect(plan.zenSkippedReason).toContain("Zen");
    expect(plan.zenSkippedReason).toContain("not configured");
  });

  test("Zen-only auth fixture skips the Go matrix with a clear message", () => {
    const plan = selectLiveRunPlan({
      zen: { configured: true },
      go: { configured: false },
    });

    expect(plan.runZen).toBe(true);
    expect(plan.zenSkippedReason).toBeUndefined();
    expect(plan.runGo).toBe(false);
    expect(plan.goSkippedReason).toBeDefined();
    expect(plan.goSkippedReason).toContain("Go");
    expect(plan.goSkippedReason).toContain("not configured");
  });

  test("both configured selects both arms with no skip reasons", () => {
    const plan = selectLiveRunPlan({
      zen: { configured: true },
      go: { configured: true },
    });

    expect(plan.runZen).toBe(true);
    expect(plan.runGo).toBe(true);
    expect(plan.zenSkippedReason).toBeUndefined();
    expect(plan.goSkippedReason).toBeUndefined();
  });

  test("neither configured skips both arms with clear messages", () => {
    const plan = selectLiveRunPlan({
      zen: { configured: false },
      go: { configured: false },
    });

    expect(plan.runZen).toBe(false);
    expect(plan.runGo).toBe(false);
    expect(plan.zenSkippedReason).toBeDefined();
    expect(plan.goSkippedReason).toBeDefined();
  });
});

describe("buildFindings / buildBottomLine (README union rendering, no disk I/O)", () => {
  test("a mode with no recorded result renders an explicit 'not run yet' finding instead of silently vanishing", () => {
    const findings = buildFindings(undefined, SAMPLE_OFFLINE, SAMPLE_CONTRACT);
    expect(
      findings.some((line) =>
        line.includes("Live provider matrix: not run yet"),
      ),
    ).toBe(true);
    // The modes that DO have data must still render their real findings —
    // a missing live result must never suppress offline/contract findings.
    expect(
      findings.some((line) => line.includes("Offline router guarantee")),
    ).toBe(true);
    expect(
      findings.some((line) => line.includes("Contract repair parity")),
    ).toBe(true);
  });

  test("an --offline-only invocation's inputs never erase live/contract findings that ARE present", () => {
    // Simulates the exact bug: a --offline run only knows its own result,
    // but the README must still render previously-recorded live/contract
    // findings passed in from disk — this call itself proves buildFindings
    // takes all three independently, so nothing is dropped as a side
    // effect of which mode most recently ran.
    const findings = buildFindings(
      SAMPLE_LIVE,
      SAMPLE_OFFLINE,
      SAMPLE_CONTRACT,
    );
    expect(findings.some((line) => line.includes("Zen auth.json key"))).toBe(
      true,
    );
    expect(
      findings.some((line) => line.includes("Offline router guarantee")),
    ).toBe(true);
    expect(
      findings.some((line) => line.includes("Contract repair parity")),
    ).toBe(true);
    expect(findings.some((line) => line.includes("not run yet"))).toBe(false);
  });

  test("all three modes missing renders three distinct 'not run yet' findings", () => {
    const findings = buildFindings(undefined, undefined, undefined);
    expect(findings).toEqual([
      "Live provider matrix: not run yet — run `bun run src/run.ts --live` to populate this section.",
      "Offline capture: not run yet — run `bun run src/run.ts --offline` (add `--capture` for the packet-capture proof) to populate this section.",
      "Contract check: not run yet — run `bun run src/run.ts --contract` to populate this section.",
    ]);
  });

  test("buildBottomLine tolerates missing live/offline without throwing", () => {
    expect(() => buildBottomLine(undefined, undefined)).not.toThrow();
    expect(buildBottomLine(undefined, undefined)).toBe("");
  });
});

describe("positive control rendering (buildFindings/buildBottomLine + renderControlFinding, no disk I/O)", () => {
  test("control skipped (--control absent): no 'Positive control' finding, and the silent verdict is NOT hedged as inconclusive", () => {
    const findings = buildFindings(undefined, SAMPLE_OFFLINE, undefined);
    expect(findings.some((line) => line.includes("Positive control"))).toBe(
      false,
    );

    const bottomLine = buildBottomLine(undefined, SAMPLE_OFFLINE);
    expect(bottomLine).toContain("silent on the wire");
    expect(bottomLine).not.toContain("INCONCLUSIVE");
  });

  test("control not-silent: the offline proof stands — findings show the control passed, bottom line does not hedge", () => {
    const findings = buildFindings(
      undefined,
      SAMPLE_OFFLINE,
      undefined,
      CONTROL_NOT_SILENT,
    );
    expect(
      findings.some(
        (line) =>
          line.includes("Positive control: not-silent") &&
          line.includes("observe provider traffic"),
      ),
    ).toBe(true);

    const bottomLine = buildBottomLine(
      undefined,
      SAMPLE_OFFLINE,
      CONTROL_NOT_SILENT,
    );
    expect(bottomLine).toContain("positive control confirmed");
    expect(bottomLine).not.toContain("INCONCLUSIVE");
  });

  test("control silent: the offline proof is marked inconclusive in both findings and bottom line", () => {
    const findings = buildFindings(
      undefined,
      SAMPLE_OFFLINE,
      undefined,
      CONTROL_SILENT,
    );
    expect(
      findings.some(
        (line) =>
          line.includes("Positive control: FAILED") &&
          line.includes("INCONCLUSIVE"),
      ),
    ).toBe(true);

    const bottomLine = buildBottomLine(
      undefined,
      SAMPLE_OFFLINE,
      CONTROL_SILENT,
    );
    expect(bottomLine).toContain("INCONCLUSIVE");
  });

  test("a control whose request itself failed to send is reported distinctly from a silent capture", () => {
    const line = renderControlFinding(CONTROL_REQUEST_FAILED);
    expect(line).toContain("FAILED to send its request");
    expect(line).toContain("Go is not configured in auth.json");
    expect(line).toContain("UNVERIFIED");
  });

  test("a control capture that itself fails is reported distinctly from a silent capture", () => {
    const line = renderControlFinding({
      capture: { status: "capture-failed", reason: "pcap file not found" },
    });
    expect(line).toContain("control capture itself FAILED");
    expect(line).toContain("pcap file not found");
    expect(line).toContain("INCONCLUSIVE");
  });
});

describe("writeLatestModeResult / loadLatestModeResult (persistence round trip, isolated temp dir)", () => {
  test("writing one mode's result does not touch another mode's file, and a never-written mode reads back undefined", () => {
    const dir = mkdtempSync(join(tmpdir(), "provider-matrix-run-"));
    try {
      writeLatestModeResult("offline", SAMPLE_OFFLINE, dir);

      expect(loadLatestModeResult<OfflineResult>("offline", dir)).toEqual(
        SAMPLE_OFFLINE,
      );
      // live/contract were never written to this isolated dir — must read
      // back as undefined ("not run yet"), never throw or fabricate data.
      expect(loadLatestModeResult<LiveResult>("live", dir)).toBeUndefined();
      expect(
        loadLatestModeResult<ContractResult>("contract", dir),
      ).toBeUndefined();

      // A second mode's write must not disturb the first mode's file —
      // this is the exact guarantee the union-rendering fix depends on.
      writeLatestModeResult("contract", SAMPLE_CONTRACT, dir);
      expect(loadLatestModeResult<OfflineResult>("offline", dir)).toEqual(
        SAMPLE_OFFLINE,
      );
      expect(loadLatestModeResult<ContractResult>("contract", dir)).toEqual(
        SAMPLE_CONTRACT,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
