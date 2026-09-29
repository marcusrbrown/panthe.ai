import { describe, expect, test } from "bun:test";
import type { EnvironmentInfo } from "@panthea/tools-probes-shared";
import type { StepResult } from "./helpers";
import { buildReportInput, type RunSummary } from "./report";

const environment: EnvironmentInfo = {
  hardware: { brand: "test cpu", memoryBytes: "1" },
  os: { productName: "macOS", productVersion: "15", buildVersion: "x" },
  bun: { version: "1.4.2" },
  pinned: { tauri: "2", three: "0.185", threeFlatland: "0.1" },
  extra: {},
};

const step: StepResult = {
  id: "S3",
  title: "Strike",
  invariant: "The strike commits.",
  result: "divinity 10 -> 7",
  measurements: [{ name: "divinity spent", unit: "divinity", value: 3 }],
  notes: ["a note"],
  elapsedMs: 1500,
};

const summary: RunSummary = {
  steps: [step],
  controls: [
    {
      name: "archive",
      sabotage: "Skips the byte change.",
      exitCode: 1,
      failure: "FAIL invariant violated: corrupted archive is rejected",
    },
  ],
  environment,
  totalMs: 42_000,
  binaryBytes: 63 * 1024 * 1024,
  commit: "abc1234",
};

describe("buildReportInput", () => {
  test("turns each measurement into a metric prefixed with its step", () => {
    expect(buildReportInput(summary).metrics).toEqual([
      { name: "S3 divinity spent", unit: "divinity", samples: [3] },
    ]);
  });

  test("lists every step with its invariant and measured result, plus notes and controls", () => {
    const findings = buildReportInput(summary).findings;
    expect(findings[0]).toContain("**S3 Strike**");
    expect(findings[0]).toContain("Asserts: The strike commits.");
    expect(findings[0]).toContain("Measured: divinity 10 -> 7");
    expect(findings).toContain("**S3 note.** a note");
    expect(findings.at(-1)).toContain("Positive control `archive`");
    expect(findings.at(-1)).toContain("exited 1");
  });

  test("the bottom line reports the step count and only claims live controls when every control failed", () => {
    expect(buildReportInput(summary).bottomLine).toContain("All 1 steps held");
    expect(buildReportInput(summary).bottomLine).toContain(
      "positive controls exited non-zero",
    );
    const broken = buildReportInput({
      ...summary,
      controls: summary.controls.map((control) => ({
        ...control,
        exitCode: 0,
      })),
    });
    expect(broken.bottomLine).not.toContain(
      "positive controls exited non-zero",
    );
  });
});
