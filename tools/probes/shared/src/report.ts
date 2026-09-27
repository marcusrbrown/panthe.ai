// Renders the README results section from a typed result object so numbers
// are never hand-copied, and scrubs personally-identifying artifacts
// (username, $HOME, hostname, hardware serial) from every string it emits.
//
// Preserves the established tools/probes/webgpu-wkwebview/README.md section
// order: Question, How to run, Caveat, Environment, Results, Findings,
// Bottom line.

import { homedir, hostname, userInfo } from "node:os";
import type { EnvironmentInfo } from "./env";
import { p50, p95 } from "./timing";

export interface MetricInput {
  readonly name: string;
  readonly unit: string;
  readonly samples: readonly number[];
}

export interface ReportInput {
  readonly question: string;
  readonly howToRun: string;
  readonly caveat?: string;
  readonly environment: EnvironmentInfo;
  readonly metrics: readonly MetricInput[];
  readonly findings: readonly string[];
  readonly bottomLine: string;
}

function heading(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

function renderEnvironmentTable(environment: EnvironmentInfo): string {
  const rows: Array<readonly [string, string]> = [
    ["Hardware", environment.hardware.brand],
    ["Memory", environment.hardware.memoryBytes],
    [
      "OS",
      `${environment.os.productName} ${environment.os.productVersion} (${environment.os.buildVersion})`,
    ],
    ["Bun", environment.bun.version],
    ["Tauri", environment.pinned.tauri],
    ["Three.js", environment.pinned.three],
    ["Three Flatland", environment.pinned.threeFlatland],
    ...Object.entries(environment.extra),
  ];
  const header = "| Field | Value |\n| --- | --- |";
  const body = rows
    .map(([field, value]) => `| ${field} | ${value} |`)
    .join("\n");
  return `${header}\n${body}`;
}

function formatMetricValue(value: number | undefined): string {
  return value === undefined ? "no samples" : String(value);
}

function renderMetricsTable(metrics: readonly MetricInput[]): string {
  if (metrics.length === 0) {
    return "No metrics recorded.";
  }
  const header =
    "| Metric | Unit | Samples | p50 | p95 |\n| --- | --- | --- | --- | --- |";
  const body = metrics
    .map((metric) => {
      const p50Value = formatMetricValue(p50(metric.samples));
      const p95Value = formatMetricValue(p95(metric.samples));
      return `| ${metric.name} | ${metric.unit} | ${metric.samples.length} | ${p50Value} | ${p95Value} |`;
    })
    .join("\n");
  return `${header}\n${body}`;
}

function renderFindings(findings: readonly string[]): string {
  if (findings.length === 0) {
    return "_No findings recorded yet._";
  }
  return findings.map((finding) => `- ${finding}`).join("\n");
}

function scrubOccurrences(
  text: string,
  value: string | undefined,
  placeholder: string,
): string {
  if (!value || value.length === 0) {
    return text;
  }
  return text.split(value).join(placeholder);
}

function readHardwareSerial(): string | undefined {
  try {
    const result = Bun.spawnSync([
      "ioreg",
      "-c",
      "IOPlatformExpertDevice",
      "-d",
      "2",
    ]);
    if (result.exitCode !== 0) {
      return undefined;
    }
    const output = result.stdout.toString();
    const match = /"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/.exec(output);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/** Replaces the current username, $HOME, hostname, and hardware serial with placeholders. */
function scrub(text: string): string {
  let result = text;
  result = scrubOccurrences(result, homedir(), "<HOME>");
  result = scrubOccurrences(result, userInfo().username, "<USER>");
  result = scrubOccurrences(result, hostname(), "<HOSTNAME>");
  result = scrubOccurrences(result, readHardwareSerial(), "<SERIAL>");
  return result;
}

/** Renders the README results section in the established section order. */
export function renderReport(input: ReportInput): string {
  const sections: string[] = [
    heading("Question", input.question),
    heading("How to run", input.howToRun),
  ];
  if (input.caveat) {
    sections.push(heading("Caveat", input.caveat));
  }
  sections.push(
    heading("Environment", renderEnvironmentTable(input.environment)),
    heading("Results", renderMetricsTable(input.metrics)),
    heading("Findings", renderFindings(input.findings)),
    heading("Bottom line", input.bottomLine),
  );
  return scrub(sections.join("\n\n"));
}
