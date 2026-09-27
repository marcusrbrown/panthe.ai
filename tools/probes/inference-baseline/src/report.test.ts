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

// A single raw suite record for a candidate NOT present in FIXTURE_SUMMARY
// ("gemma4:e4b" @ 1k) — the incremental-re-run scenario: benching one more
// candidate against an already-published matrix without every prior
// candidate's gitignored raw records still on disk.
function promptResult(index: number) {
  return {
    promptId: `p${index}`,
    contextTier: "1k",
    mode: "native",
    outcome: "native-valid",
    kind: "say",
    kindAcceptable: true,
    ttftMs: 400 + index,
    totalMs: 2000 + index,
    tokPerSec: 25,
    serverTokPerSec: 25,
    promptTokens: 50,
    completionTokens: 30,
    errorMessage: undefined,
  };
}

const FRESH_RAW_RECORD = {
  kind: "suite",
  label: "gemma4-e4b-1k",
  server: "ollama",
  model: "gemma4:e4b",
  tier: "1k",
  timestamp: "2026-09-27T05:43:00.000Z",
  environment: FIXTURE_SUMMARY.environment,
  results: Array.from({ length: 10 }, (_unused, index) => promptResult(index)),
};

describe("report command: merge dispatch (raw records + committed summary.json both present)", () => {
  test("a fresh raw record for a new candidate is added to the committed matrix, not substituted for it", () => {
    const tempDir = mkdtempSync(
      join(tmpdir(), "inference-baseline-report-merge-"),
    );
    try {
      const resultsDir = join(tempDir, "results");
      mkdirSync(resultsDir, { recursive: true });
      writeFileSync(
        join(resultsDir, "summary.json"),
        JSON.stringify(FIXTURE_SUMMARY, null, 2),
      );
      writeFileSync(
        join(resultsDir, "gemma4-e4b-1k.json"),
        JSON.stringify(FRESH_RAW_RECORD, null, 2),
      );
      const readmePath = join(tempDir, "README.md");

      const { exitCode, stderr } = runReportCli(resultsDir, readmePath);

      expect(exitCode).toBe(0);
      // Neither the fresh-only nor the committed-only branch message fires —
      // this went through the merge path.
      expect(stderr).not.toContain("rendered README from committed");

      const readme = readFileSync(readmePath, "utf8");
      // The pre-existing committed candidate must still be present...
      expect(readme).toContain("llama3.2:3b");
      // ...alongside the newly added one, not instead of it.
      expect(readme).toContain("gemma4:e4b");

      const summaryAfter = JSON.parse(
        readFileSync(join(resultsDir, "summary.json"), "utf8"),
      ) as { suites: readonly { model: string }[] };
      const models = summaryAfter.suites.map((s) => s.model).sort();
      expect(models).toEqual(["gemma4:e4b", "llama3.2:3b"]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("a fresh raw record for an already-published candidate overrides its committed row, not both", () => {
    const tempDir = mkdtempSync(
      join(tmpdir(), "inference-baseline-report-merge-override-"),
    );
    try {
      const resultsDir = join(tempDir, "results");
      mkdirSync(resultsDir, { recursive: true });
      writeFileSync(
        join(resultsDir, "summary.json"),
        JSON.stringify(FIXTURE_SUMMARY, null, 2),
      );
      // Same model/server/tier as the committed row, but a re-measured
      // (worse) result — the fresh record must win, not be appended
      // alongside the stale committed one.
      const overrideRecord = {
        ...FRESH_RAW_RECORD,
        label: "llama3.2-3b-4k",
        model: "llama3.2:3b",
        tier: "4k",
        results: Array.from({ length: 10 }, (_unused, index) => ({
          ...promptResult(index),
          contextTier: "4k",
          kindAcceptable: false,
        })),
      };
      writeFileSync(
        join(resultsDir, "llama3.2-3b-4k.json"),
        JSON.stringify(overrideRecord, null, 2),
      );
      const readmePath = join(tempDir, "README.md");

      const { exitCode } = runReportCli(resultsDir, readmePath);
      expect(exitCode).toBe(0);

      const summaryAfter = JSON.parse(
        readFileSync(join(resultsDir, "summary.json"), "utf8"),
      ) as {
        suites: readonly {
          model: string;
          tier: string;
          kindAcceptableRate: number;
        }[];
      };
      const llamaRows = summaryAfter.suites.filter(
        (s) => s.model === "llama3.2:3b" && s.tier === "4k",
      );
      expect(llamaRows).toHaveLength(1);
      // The fresh (worse) measurement replaced the committed 83% figure.
      expect(llamaRows[0]?.kindAcceptableRate).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
