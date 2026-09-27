// Regression test for the `report` command's three-way dispatch (see
// `cmdReport` in run.ts): a fresh checkout only ever has the committed
// `results/summary.json`, never the gitignored raw per-request records —
// `report` must render from that aggregate instead of misparsing it as an
// empty set of raw records and overwriting both the README and the
// aggregate itself with empty tables. Each test spawns the real CLI as a
// subprocess against a disposable temp directory (via the
// `INFERENCE_BASELINE_RESULTS_DIR`/`INFERENCE_BASELINE_README_PATH` env var
// overrides) — no network, no shared state with the probe's real
// results/README.

import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUN_TS_PATH = join(import.meta.dir, "run.ts");

const FIXTURE_SUMMARY = {
  generatedAt: "2026-09-27T00:00:00.000Z",
  suites: [
    {
      model: "llama3.2:3b",
      server: "ollama",
      tier: "4k",
      sampleCount: 40,
      nativeValidRate: 1,
      kindAcceptableRate: 0.83,
      repairedValidRate: 0.13,
      timeoutCount: 0,
      errorCount: 0,
      ttftP50: 155,
      ttftP95: 210,
      totalP50: 706,
      totalP95: 1538,
      tokPerSecP50: 46.3,
      rssPeakBytes: 2917761024,
      rssBug: false,
      diskSizeBytes: undefined,
      rendererFrameP95: 17,
    },
  ],
  parallel: [],
  outage: [],
  environment: {
    hardware: { brand: "Apple M1 Pro", memoryBytes: "17179869184" },
    os: {
      productName: "macOS",
      productVersion: "15.7.9",
      buildVersion: "24G830",
    },
    bun: { version: "1.4.2" },
    pinned: {
      tauri: "2.12.0",
      three: "0.185.1",
      threeFlatland: "0.1.0-alpha.10",
    },
    extra: { ollama: "0.34.4" },
  },
};

function runReportCli(
  resultsDir: string,
  readmePath: string,
): {
  readonly exitCode: number;
  readonly stderr: string;
} {
  const result = Bun.spawnSync(["bun", "run", RUN_TS_PATH, "report"], {
    env: {
      ...process.env,
      INFERENCE_BASELINE_RESULTS_DIR: resultsDir,
      INFERENCE_BASELINE_README_PATH: readmePath,
    },
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
  };
}

describe("report command: fresh-checkout dispatch (only results/summary.json present)", () => {
  test("renders the README from the committed summary.json and leaves it byte-identical", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "inference-baseline-report-"));
    try {
      const resultsDir = join(tempDir, "results");
      mkdirSync(resultsDir, { recursive: true });
      const summaryPath = join(resultsDir, "summary.json");
      const summaryContent = JSON.stringify(FIXTURE_SUMMARY, null, 2);
      writeFileSync(summaryPath, summaryContent);
      const readmePath = join(tempDir, "README.md");

      const { exitCode, stderr } = runReportCli(resultsDir, readmePath);

      expect(exitCode).toBe(0);
      expect(stderr).toContain(
        "rendered README from committed results/summary.json",
      );

      const readme = readFileSync(readmePath, "utf8");
      // Published numbers from the fixture must appear in the rendered README.
      expect(readme).toContain("llama3.2:3b");
      expect(readme).toContain("83%"); // kindAcceptableRate
      expect(readme).toContain("706/1538"); // completion p50/p95

      // summary.json must be untouched — byte-identical to what was written
      // before the CLI ran (not merely "still valid JSON with similar data").
      const summaryAfter = readFileSync(summaryPath, "utf8");
      expect(summaryAfter).toBe(summaryContent);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("report command: nothing-to-report dispatch (empty results directory)", () => {
  test("exits non-zero and writes no files", () => {
    const tempDir = mkdtempSync(
      join(tmpdir(), "inference-baseline-report-empty-"),
    );
    try {
      const resultsDir = join(tempDir, "results");
      mkdirSync(resultsDir, { recursive: true });
      const readmePath = join(tempDir, "README.md");

      const { exitCode, stderr } = runReportCli(resultsDir, readmePath);

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("nothing to report");
      expect(() => readFileSync(readmePath, "utf8")).toThrow();
      expect(() =>
        readFileSync(join(resultsDir, "summary.json"), "utf8"),
      ).toThrow();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
