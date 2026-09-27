#!/usr/bin/env bun
// CLI entry point driving the coexistence probe (Unit 8). Service staging
// (ollama serve, sd-server, the packaged renderer app) is a prerequisite
// done outside this tool (see README "How to run") — this file only
// exercises already-running servers plus one-shot cold-start spawns for the
// transition measurements, and persists/reports the results. Subcommands:
//
//   scenario --name baseline|unconstrained|mutex|admission
//            [--threshold-mib <n>] --duration-ms <n>
//            --ollama-base-url <url> --model <name>
//            [--sdcpp-base-url <url>] --ollama-pid <pid>
//            [--sdserver-pid <pid>] [--renderer-pid <pid>]
//            [--renderer-log <path>] --label <name>
//     Runs one 3-minute (by default) measurement window: renderer stays
//     running throughout; the LLM loop always runs; the image loop runs
//     for every policy except baseline, gated per policy (mutex: a single
//     lock shared with the LLM loop; admission: gated on live free+inactive
//     memory; unconstrained: no gate). Writes results/<label>.json.
//
//   transition-llm --ollama-base-url <url> --model <name> --label <name>
//                  --transition llm-cold-baseline|llm-cold-after-sdcpp-resident
//     Times one Ollama chat request end-to-end (the caller evicts the
//     model first with `ollama stop <model>` for a true cold-start
//     measurement). Writes results/<label>.json.
//
//   sdserver-spawn --binary <path> --model <path> --port <n> --label <name>
//                  --transition sdserver-cold-baseline|sdserver-cold-after-llm-resident
//                  [--timeout-ms <n>]
//     Spawns a fresh sd-server, polls until reachable, records ms-to-ready,
//     and prints its pid on stdout (left running — kill it yourself when
//     done). Writes results/<label>.json.
//
//   report [--out README.md]
//     Reads every results/*.json record and renders the README.
//
//   publish-raw
//     Redacts results/A-baseline.json and results/D-admission-3gib.json
//     (the two scenarios re-measured with the fixed instrumentation) down
//     to per-request {t, ok, latencyMs} and per-tick {t, freeMiB,
//     inactiveMiB, swapUsedMiB, rss} arrays — no prompts, no completions,
//     no environment strings — and writes them under results/raw/, which
//     is un-ignored so they can be committed. Downsamples memory ticks to
//     1-second buckets if the combined payload would exceed 300 KB.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  captureEnvironment,
  type EnvironmentInfo,
  p50 as percentile50,
  p95 as percentile95,
} from "@panthea/tools-probes-shared";
import {
  type CoexistenceLock,
  createAdmissionGate,
  createLock,
  type ImageRunSample,
  type LlmRequestSample,
  runImageLoop,
  runLlmLoop,
  timeOllamaChatRequest,
  timeOneImage,
  waitForReady,
} from "./orchestrate";
import {
  type CandidateResult,
  choosePolicy,
  computePenalty,
  evaluateCandidate,
  isLlmEvaluable,
  llmEvaluabilityReason,
  type PolicyDecision,
  type PolicyName,
  type ScenarioMetrics,
} from "./policies";
import {
  createMemorySampler,
  type MemorySample,
  ollamaRunnerTarget,
  readRssKb,
  staticPidTarget,
} from "./sample";

const SRC_DIR = import.meta.dir;
const PROBE_DIR = join(SRC_DIR, "..");
const RESULTS_DIR = process.env.COEXISTENCE_RESULTS_DIR
  ? resolve(process.env.COEXISTENCE_RESULTS_DIR)
  : join(PROBE_DIR, "results");
const README_PATH = process.env.COEXISTENCE_README_PATH
  ? resolve(process.env.COEXISTENCE_README_PATH)
  : join(PROBE_DIR, "README.md");
const SUMMARY_FILENAME = "summary.json";

function parseFlags(argv: readonly string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      flags[key] = next && !next.startsWith("--") ? next : "true";
      if (next && !next.startsWith("--")) {
        i += 1;
      }
    }
  }
  return flags;
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (value === undefined) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function isScenarioName(
  value: string,
): value is "baseline" | "unconstrained" | "mutex" | "admission" {
  return (
    value === "baseline" ||
    value === "unconstrained" ||
    value === "mutex" ||
    value === "admission"
  );
}

function isPidAlive(pid: number): boolean {
  return readRssKb(pid) !== undefined;
}

interface FrameStats {
  readonly p50: number;
  readonly p95: number;
  readonly sampleCount: number;
}

function parseFrameStatsSince(
  content: string,
  offset: number,
): FrameStats | undefined {
  const slice = content.slice(offset);
  const idx = slice.lastIndexOf('"frameTime"');
  if (idx === -1) {
    return undefined;
  }
  const window = slice.slice(idx, idx + 200);
  const p50Match = /"p50":\s*([\d.]+)/.exec(window);
  const p95Match = /"p95":\s*([\d.]+)/.exec(window);
  if (!p50Match?.[1] || !p95Match?.[1]) {
    return undefined;
  }
  return { p50: Number(p50Match[1]), p95: Number(p95Match[1]), sampleCount: 0 };
}

/** Triggers a metrics dump in the already-running probe-renderer app (`d` keystroke) and reads the frame-time block back out of its captured stdout log. Never throws. */
async function sampleRendererFrameStats(
  logPath: string,
): Promise<FrameStats | undefined> {
  try {
    if (!existsSync(logPath)) {
      return undefined;
    }
    const before = readFileSync(logPath, "utf8");
    Bun.spawnSync([
      "osascript",
      "-e",
      'tell application "System Events" to tell process "panthea-probe-renderer" to set frontmost to true',
    ]);
    await Bun.sleep(1000);
    Bun.spawnSync([
      "osascript",
      "-e",
      'tell application "System Events" to keystroke "d"',
    ]);
    await Bun.sleep(500);
    let content = readFileSync(logPath, "utf8");
    if (content.length === before.length) {
      Bun.spawnSync(["cliclick", "t:d"]);
      await Bun.sleep(500);
      content = readFileSync(logPath, "utf8");
    }
    return parseFrameStatsSince(content, before.length);
  } catch {
    return undefined;
  }
}

function captureProbeEnvironment(
  extra: Record<string, string>,
): EnvironmentInfo {
  return captureEnvironment({ extra });
}

interface ScenarioRecord {
  readonly kind: "scenario";
  readonly label: string;
  readonly policy: PolicyName | "baseline";
  readonly thresholdMiB?: number;
  readonly durationMs: number;
  readonly timestamp: string;
  readonly llmSamples: readonly LlmRequestSample[];
  readonly imageSamples: readonly ImageRunSample[];
  readonly memorySamples: readonly MemorySample[];
  readonly rendererFrameP95Before?: number;
  readonly rendererFrameP95After?: number;
  readonly processDied: boolean;
  readonly processDeathNote?: string;
  readonly environment: EnvironmentInfo;
}

type TransitionKind =
  | "llm-cold-baseline"
  | "llm-cold-after-sdcpp-resident"
  | "sdserver-cold-baseline"
  | "sdserver-cold-after-llm-resident";

interface TransitionRecord {
  readonly kind: "transition";
  readonly label: string;
  readonly transition: TransitionKind;
  readonly ms: number;
  readonly ok: boolean;
  readonly timestamp: string;
}

type StoredRecord = ScenarioRecord | TransitionRecord;

function writeResult(label: string, record: StoredRecord): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = join(RESULTS_DIR, `${label}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2));
  console.error(`[coexistence] wrote ${path}`);
}

async function cmdScenario(flags: Record<string, string>): Promise<void> {
  const nameRaw = requireFlag(flags, "name");
  if (!isScenarioName(nameRaw)) {
    throw new Error(
      "--name must be baseline, unconstrained, mutex, or admission",
    );
  }
  const policy: PolicyName | "baseline" =
    nameRaw === "baseline"
      ? "baseline"
      : nameRaw === "admission"
        ? "admission-queue"
        : nameRaw;
  const thresholdMiB =
    nameRaw === "admission"
      ? Number(requireFlag(flags, "threshold-mib"))
      : undefined;
  const durationMs = Number(flags["duration-ms"] ?? "180000");
  const ollamaBaseUrl = requireFlag(flags, "ollama-base-url");
  const model = requireFlag(flags, "model");
  const sdcppBaseUrl = flags["sdcpp-base-url"];
  const ollamaPid = Number(requireFlag(flags, "ollama-pid"));
  const sdserverPid = flags["sdserver-pid"]
    ? Number(flags["sdserver-pid"])
    : undefined;
  const rendererPid = flags["renderer-pid"]
    ? Number(flags["renderer-pid"])
    : undefined;
  const rendererLog = flags["renderer-log"];
  const label = requireFlag(flags, "label");

  if (nameRaw !== "baseline" && !sdcppBaseUrl) {
    throw new Error(
      "--sdcpp-base-url is required for every non-baseline scenario",
    );
  }

  console.error(
    `[coexistence] scenario ${label} (${nameRaw}${thresholdMiB ? `@${thresholdMiB}MiB` : ""}), duration ${durationMs}ms`,
  );

  const targets = [ollamaRunnerTarget(ollamaPid)];
  if (sdserverPid !== undefined) {
    targets.push(staticPidTarget("sd-server", sdserverPid));
  }
  if (rendererPid !== undefined) {
    targets.push(staticPidTarget("renderer", rendererPid));
  }
  const memorySampler = createMemorySampler(500, targets);

  const rendererFrameP95Before = rendererLog
    ? (await sampleRendererFrameStats(rendererLog))?.p95
    : undefined;

  memorySampler.start();

  const lock: CoexistenceLock | undefined =
    nameRaw === "mutex" ? createLock() : undefined;

  const llmLoopPromise = runLlmLoop({
    baseUrl: ollamaBaseUrl,
    model,
    durationMs,
    lock,
  });

  const imageLoopPromise =
    nameRaw === "baseline"
      ? Promise.resolve<readonly ImageRunSample[]>([])
      : runImageLoop({
          baseUrl: sdcppBaseUrl as string,
          durationMs,
          lock,
          admissionGate:
            nameRaw === "admission" && thresholdMiB !== undefined
              ? createAdmissionGate(
                  () => memorySampler.peek()?.admissionMiB,
                  thresholdMiB,
                )
              : undefined,
        });

  const [llmSamples, imageSamples] = await Promise.all([
    llmLoopPromise,
    imageLoopPromise,
  ]);

  const memorySamples = memorySampler.stop();

  const rendererFrameP95After = rendererLog
    ? (await sampleRendererFrameStats(rendererLog))?.p95
    : undefined;

  const deathNotes: string[] = [];
  if (!isPidAlive(ollamaPid)) {
    deathNotes.push(`ollama serve (pid ${ollamaPid}) is no longer running`);
  }
  if (sdserverPid !== undefined && !isPidAlive(sdserverPid)) {
    deathNotes.push(`sd-server (pid ${sdserverPid}) is no longer running`);
  }
  if (rendererPid !== undefined && !isPidAlive(rendererPid)) {
    deathNotes.push(`renderer (pid ${rendererPid}) is no longer running`);
  }

  const record: ScenarioRecord = {
    kind: "scenario",
    label,
    policy,
    thresholdMiB,
    durationMs,
    timestamp: new Date().toISOString(),
    llmSamples,
    imageSamples,
    memorySamples,
    rendererFrameP95Before,
    rendererFrameP95After,
    processDied: deathNotes.length > 0,
    processDeathNote: deathNotes.length > 0 ? deathNotes.join("; ") : undefined,
    environment: captureProbeEnvironment({ model }),
  };
  writeResult(label, record);

  const successTotals = llmSamples.filter((s) => s.ok).map((s) => s.totalMs);
  console.error(
    `[coexistence] ${label}: LLM p50/p95=${percentile50(successTotals)?.toFixed(0) ?? "n/a"}/${percentile95(successTotals)?.toFixed(0) ?? "n/a"}ms ` +
      `(${successTotals.length}/${llmSamples.length} successful) ` +
      `images=${imageSamples.filter((s) => s.ok).length}/${imageSamples.length} ` +
      `frameP95 after=${rendererFrameP95After ?? "n/a (not evaluable)"} ` +
      `processDied=${record.processDied}`,
  );
}

async function cmdTransitionLlm(flags: Record<string, string>): Promise<void> {
  const baseUrl = requireFlag(flags, "ollama-base-url");
  const model = requireFlag(flags, "model");
  const label = requireFlag(flags, "label");
  const transitionRaw = requireFlag(flags, "transition");
  if (
    transitionRaw !== "llm-cold-baseline" &&
    transitionRaw !== "llm-cold-after-sdcpp-resident"
  ) {
    throw new Error(
      "--transition must be llm-cold-baseline or llm-cold-after-sdcpp-resident",
    );
  }
  const result = await timeOllamaChatRequest(baseUrl, model, 60000);
  const record: TransitionRecord = {
    kind: "transition",
    label,
    transition: transitionRaw,
    ms: result.totalMs,
    ok: result.ok,
    timestamp: new Date().toISOString(),
  };
  writeResult(label, record);
  console.error(
    `[coexistence] ${label}: ${transitionRaw} = ${result.totalMs.toFixed(0)}ms (ok=${result.ok})`,
  );
}

async function cmdSdserverSpawn(flags: Record<string, string>): Promise<void> {
  const binary = requireFlag(flags, "binary");
  const modelPath = requireFlag(flags, "model");
  const port = requireFlag(flags, "port");
  const label = requireFlag(flags, "label");
  const timeoutMs = Number(flags["timeout-ms"] ?? "120000");
  const transitionRaw = requireFlag(flags, "transition");
  if (
    transitionRaw !== "sdserver-cold-baseline" &&
    transitionRaw !== "sdserver-cold-after-llm-resident"
  ) {
    throw new Error(
      "--transition must be sdserver-cold-baseline or sdserver-cold-after-llm-resident",
    );
  }

  const startedAt = performance.now();
  const child = Bun.spawn(
    [binary, "--model", modelPath, "--listen-port", port, "--diffusion-fa"],
    { stdout: "ignore", stderr: "ignore" },
  );
  // Detach from this script's own lifecycle immediately: sd-server must
  // outlive this one-shot spawn-and-time invocation (it stays running for
  // the next scenario/transition to reuse), and Bun keeps a spawned child's
  // event-loop reference held by default.
  child.unref();
  const baseUrl = `http://127.0.0.1:${port}`;
  const { ready, ms: readyMs } = await waitForReady(
    async () => {
      try {
        const response = await fetch(`${baseUrl}/sdcpp/v1/capabilities`);
        return response.ok;
      } catch {
        return false;
      }
    },
    500,
    timeoutMs,
  );

  // The HTTP listener answers `/sdcpp/v1/capabilities` before the checkpoint
  // tensors are loaded (measured: RSS stays near the process floor until the
  // first generation request) — "reachable" alone understates the real
  // cold-start cost. The transition this probe cares about (unified memory
  // reclaim behavior) is the wall-clock cost through the first completed
  // image, so that's what gets persisted as `ms`.
  let firstImageMs: number | undefined;
  let firstImageOk = false;
  if (ready) {
    const result = await timeOneImage(baseUrl, { jobTimeoutMs: timeoutMs });
    firstImageMs = result.totalMs;
    firstImageOk = result.ok;
  }
  const totalMs = performance.now() - startedAt;

  const record: TransitionRecord = {
    kind: "transition",
    label,
    transition: transitionRaw,
    ms: totalMs,
    ok: ready && firstImageOk,
    timestamp: new Date().toISOString(),
  };
  writeResult(label, record);
  console.error(
    `[coexistence] ${label}: spawn\u2192reachable=${readyMs.toFixed(0)}ms, reachable\u2192first-image=${firstImageMs?.toFixed(0) ?? "n/a"}ms, total=${totalMs.toFixed(0)}ms (ok=${record.ok}), sd-server pid=${child.pid}`,
  );
  // Left running intentionally — the caller reuses this process for the
  // next scenario or kills it explicitly once done.
}

function listRawResultFiles(): readonly string[] {
  if (!existsSync(RESULTS_DIR)) {
    return [];
  }
  return readdirSync(RESULTS_DIR).filter(
    (name) => name.endsWith(".json") && name !== SUMMARY_FILENAME,
  );
}

function loadRawRecords(): readonly StoredRecord[] {
  return listRawResultFiles().map(
    (name) =>
      JSON.parse(readFileSync(join(RESULTS_DIR, name), "utf8")) as StoredRecord,
  );
}

/** Median gap (ms) between consecutive memory samples — verifies the 500ms sampler actually kept up under contention rather than silently degrading; published so the report is checkable, not just asserted. `undefined` with fewer than two samples. */
function computeMedianSampleIntervalMs(
  samples: readonly MemorySample[],
): number | undefined {
  if (samples.length < 2) {
    return undefined;
  }
  const sorted = [...samples].sort((a, b) => a.atMs - b.atMs);
  const deltas: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const current = sorted[i];
    if (prev && current) {
      deltas.push(current.atMs - prev.atMs);
    }
  }
  return percentile50(deltas);
}

function buildScenarioMetrics(record: ScenarioRecord): ScenarioMetrics {
  // Only successful requests feed the latency percentiles — a timed-out or
  // errored request measured near `timeoutMs` would otherwise pollute p95
  // with a number that isn't "how fast a real response came back", and an
  // all-failed scenario must never silently read as p95=0 (an empty
  // `percentile95([])` correctly returns `undefined`, not `0`).
  const successSamples = record.llmSamples.filter((s) => s.ok);
  const successTotals = successSamples.map((s) => s.totalMs);
  const llmSuccessCount = successSamples.length;
  const llmSampleCount = record.llmSamples.length;
  const llmErrorCount = llmSampleCount - llmSuccessCount;
  const swapValues = record.memorySamples
    .map((s) => s.swapUsedMiB)
    .filter((v): v is number => v !== undefined);
  const admissionValues = record.memorySamples.map((s) => s.admissionMiB);
  return {
    llmP50Ms: percentile50(successTotals),
    llmP95Ms: percentile95(successTotals),
    llmSuccessCount,
    llmErrorCount,
    llmSampleCount,
    imagesCompleted: record.imageSamples.filter((s) => s.ok).length,
    // Only the verified post-window measurement counts — falling back to
    // the pre-window value would silently publish a number that looks like
    // "frame p95 during contention" when it's actually "frame p95 before
    // contention started", i.e. a false pass.
    rendererFrameP95Ms: record.rendererFrameP95After,
    frameEvaluable: record.rendererFrameP95After !== undefined,
    peakSwapUsedMiB: swapValues.length > 0 ? Math.max(...swapValues) : 0,
    minFreeMiB: admissionValues.length > 0 ? Math.min(...admissionValues) : 0,
    processDied: record.processDied,
  };
}

interface ScenarioReportExtras {
  readonly label: string;
  /** Median gap (ms) between consecutive memory samples — verifies the sampler kept up; published so the report is checkable. */
  readonly medianSampleIntervalMs: number | undefined;
  /**
   * `false` when this entry's raw record was measured in the run that
   * produced the current report (a "fresh" entry); `true` when it was
   * carried over from a previously committed summary with no raw record
   * in this run to re-derive it from (see {@link mergeSummaries}). A
   * percentage penalty between a fresh baseline and a historical
   * candidate compares two different measurement sessions and is not
   * trustworthy — see `formatPenaltyForReport`.
   */
  readonly historical: boolean;
}

interface Summary {
  readonly generatedAt: string;
  readonly environment: EnvironmentInfo | undefined;
  readonly baseline: (ScenarioMetrics & ScenarioReportExtras) | undefined;
  readonly candidates: readonly (CandidateResult & ScenarioReportExtras)[];
  readonly transitions: readonly {
    readonly transition: TransitionKind;
    readonly ms: number;
    readonly ok: boolean;
  }[];
  readonly decision: PolicyDecision | undefined;
}

function loadCommittedSummary(): Summary | undefined {
  const path = join(RESULTS_DIR, SUMMARY_FILENAME);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Summary;
  } catch {
    return undefined;
  }
}

function buildSummary(records: readonly StoredRecord[]): Summary {
  const scenarioRecords = records.filter(
    (r): r is ScenarioRecord => r.kind === "scenario",
  );
  const transitionRecords = records.filter(
    (r): r is TransitionRecord => r.kind === "transition",
  );
  const baselineRecord = scenarioRecords.find((r) => r.policy === "baseline");
  const candidateRecords = scenarioRecords.filter(
    (r) => r.policy !== "baseline",
  );

  const baseline = baselineRecord
    ? {
        ...buildScenarioMetrics(baselineRecord),
        label: baselineRecord.label,
        medianSampleIntervalMs: computeMedianSampleIntervalMs(
          baselineRecord.memorySamples,
        ),
        historical: false,
      }
    : undefined;
  const candidates = candidateRecords.map((r) => ({
    ...buildScenarioMetrics(r),
    policy: r.policy as PolicyName,
    thresholdMiB: r.thresholdMiB,
    label: r.label,
    medianSampleIntervalMs: computeMedianSampleIntervalMs(r.memorySamples),
    historical: false,
  }));

  const decision =
    baseline && candidates.length > 0
      ? choosePolicy({ baseline, candidates })
      : undefined;

  const environment = scenarioRecords[0]?.environment;

  return {
    generatedAt: new Date().toISOString(),
    environment,
    baseline,
    candidates,
    transitions: transitionRecords.map((r) => ({
      transition: r.transition,
      ms: r.ms,
      ok: r.ok,
    })),
    decision,
  };
}

function persistSummary(summary: Summary): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = join(RESULTS_DIR, SUMMARY_FILENAME);
  writeFileSync(path, JSON.stringify(summary, null, 2));
  console.error(`[coexistence] wrote ${path}`);
}

function formatMs(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toFixed(0);
}

function formatMiB(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toFixed(0);
}

function formatFrame(
  frameEvaluable: boolean,
  rendererFrameP95Ms: number | undefined,
): string {
  return frameEvaluable ? formatMs(rendererFrameP95Ms) : "n/a (not evaluable)";
}

function formatCounts(m: ScenarioMetrics): string {
  return m.llmSuccessCount !== undefined && m.llmSampleCount !== undefined
    ? `${m.llmSuccessCount}/${m.llmSampleCount}`
    : "n/a";
}

function scenarioStatusLabel(
  candidate: CandidateResult,
  baseline: ScenarioMetrics | undefined,
): string {
  if (!baseline) {
    return "n/a";
  }
  const status = evaluateCandidate(candidate, baseline);
  return status.kind === "viable"
    ? "viable"
    : `${status.kind}: ${status.reason}`;
}

/**
 * A percentage penalty only means something when both sides were measured
 * in the same run. A historical candidate (carried over with no raw record
 * this run — see {@link mergeSummaries}) compared against a freshly
 * re-measured baseline (or vice versa) is a cross-session comparison: the
 * two numbers were never observed under the same concurrent conditions, so
 * the delta between them conflates "policy effect" with "which day this was
 * measured on" (see the corrected D-admission-3072MiB result, which swung
 * from -10.6% to +148.4% between two same-code, different-session runs).
 * Rendering a percentage here would misrepresent it as directly comparable.
 */
function formatPenaltyForReport(
  candidate: {
    readonly llmP95Ms: number | undefined;
    readonly historical: boolean;
  },
  baseline:
    | { readonly llmP95Ms: number | undefined; readonly historical: boolean }
    | undefined,
): string {
  if (!baseline) {
    return "n/a";
  }
  if (candidate.historical !== baseline.historical) {
    return "n/a (different session)";
  }
  const penalty = computePenalty(candidate.llmP95Ms, baseline.llmP95Ms);
  if (penalty === undefined) {
    return "n/a";
  }
  if (!Number.isFinite(penalty)) {
    return "n/a (baseline p95 was 0ms)";
  }
  return `${penalty >= 0 ? "+" : ""}${(penalty * 100).toFixed(1)}%`;
}

function buildScenarioTable(summary: Summary): string {
  const rows: string[] = [];
  const header =
    "| Scenario | LLM p50 (ms) | LLM p95 (ms) | p95 penalty vs A | LLM success/attempts | Images completed | Frame p95 (ms) | Peak swap (MiB) | Min free+inactive (MiB) | Sample cadence (median ms) | Process died | Status |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  rows.push(header);
  if (summary.baseline) {
    const b = summary.baseline;
    const baselineStatus = isLlmEvaluable(b)
      ? "evaluable"
      : `not-evaluable: ${llmEvaluabilityReason(b)}`;
    rows.push(
      `| A: baseline (renderer + LLM) | ${formatMs(b.llmP50Ms)} | ${formatMs(b.llmP95Ms)} | — | ${formatCounts(b)} | ${b.imagesCompleted} | ${formatFrame(b.frameEvaluable, b.rendererFrameP95Ms)} | ${formatMiB(b.peakSwapUsedMiB)} | ${formatMiB(b.minFreeMiB)} | ${formatMs(b.medianSampleIntervalMs)} | ${b.processDied} | ${baselineStatus} |`,
    );
  }
  for (const c of summary.candidates) {
    const penaltyStr = formatPenaltyForReport(c, summary.baseline);
    const name =
      c.policy === "admission-queue"
        ? `D: admission-queue @ ${c.thresholdMiB}MiB`
        : c.policy === "unconstrained"
          ? "B: unconstrained"
          : "C: mutex";
    rows.push(
      `| ${name} | ${formatMs(c.llmP50Ms)} | ${formatMs(c.llmP95Ms)} | ${penaltyStr} | ${formatCounts(c)} | ${c.imagesCompleted} | ${formatFrame(c.frameEvaluable, c.rendererFrameP95Ms)} | ${formatMiB(c.peakSwapUsedMiB)} | ${formatMiB(c.minFreeMiB)} | ${formatMs(c.medianSampleIntervalMs)} | ${c.processDied} | ${scenarioStatusLabel(c, summary.baseline)} |`,
    );
  }
  return rows.join("\n");
}

function buildTransitionsTable(summary: Summary): string {
  if (summary.transitions.length === 0) {
    return "No transition measurements recorded.";
  }
  const header = "| Transition | ms | ok |\n| --- | --- | --- |";
  const rows = summary.transitions.map(
    (t) => `| ${t.transition} | ${t.ms.toFixed(0)} | ${t.ok} |`,
  );
  return [header, ...rows].join("\n");
}

function buildEnvironmentTable(
  environment: EnvironmentInfo | undefined,
): string {
  if (!environment) {
    return "No environment captured.";
  }
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
  const body = rows.map(([f, v]) => `| ${f} | ${v} |`).join("\n");
  return `${header}\n${body}`;
}

function buildFindings(summary: Summary): readonly string[] {
  const findings: string[] = [];
  if (summary.baseline) {
    const b = summary.baseline;
    const evaluability = isLlmEvaluable(b)
      ? "evaluable"
      : `NOT evaluable (${llmEvaluabilityReason(b)})`;
    findings.push(
      `Baseline (renderer + LLM loop only): LLM p50/p95 ${formatMs(b.llmP50Ms)}/${formatMs(b.llmP95Ms)}ms over ${formatCounts(b)} successful/attempted requests (${evaluability}), renderer frame p95 ${formatFrame(b.frameEvaluable, b.rendererFrameP95Ms)}, sample cadence median ${formatMs(b.medianSampleIntervalMs)}ms.`,
    );
  }
  if (summary.baseline) {
    const baselineRef = summary.baseline;
    for (const c of summary.candidates) {
      const label =
        c.policy === "admission-queue"
          ? `admission-queue@${c.thresholdMiB}MiB`
          : c.policy;
      const penaltyDesc = formatPenaltyForReport(c, baselineRef);
      const status = evaluateCandidate(c, baselineRef);
      const statusDesc =
        status.kind === "viable"
          ? "viable"
          : `${status.kind}: ${status.reason}`;
      const sessionNote = c.historical
        ? " [historical: carried over, not independently re-verified this session]"
        : "";
      findings.push(
        `${label}: LLM p95 ${formatMs(c.llmP95Ms)}ms (${penaltyDesc} vs baseline), ${formatCounts(c)} successful/attempted LLM requests, ${c.imagesCompleted} image(s) completed, frame p95 ${formatFrame(c.frameEvaluable, c.rendererFrameP95Ms)} \u2014 ${statusDesc}${sessionNote}`,
      );
    }
  }
  for (const t of summary.transitions) {
    findings.push(
      `Transition ${t.transition}: ${t.ms.toFixed(0)}ms (ok=${t.ok}).`,
    );
  }
  if (summary.decision?.policy === "inconclusive") {
    findings.push(
      "Next measurement steps to resolve this: re-run B (unconstrained), C (mutex), and D-admission-5120MiB with the fixed sampler (success-only percentiles, verified post-window frame samples) so every candidate is evaluable in the same run; and measure at least one intermediate admission threshold between 3072MiB and 5120MiB, since 3072MiB now measures a real +148.4% penalty (images ran almost continuously, rarely gated) while 5120MiB starves image generation to zero — the viable threshold, if one exists on this machine's pre-existing swap floor, likely sits between them.",
    );
  }
  return findings;
}

function buildBottomLine(summary: Summary): string {
  if (!summary.decision) {
    return "Not enough scenarios recorded yet to make a policy recommendation — need the baseline plus at least one candidate.";
  }
  const d = summary.decision;
  // The rationale text below is built inside policies.ts's pure choosePolicy
  // and states each candidate's raw LLM p95 percentage as computed directly
  // from the numbers — it has no concept of "session". A historical
  // candidate's percentage there is not comparable to a freshly re-measured
  // baseline (see formatPenaltyForReport); this note keeps the bottom line
  // from silently contradicting the Findings/table above, which render
  // those same comparisons as "n/a (different session)".
  const hasHistorical = summary.candidates.some((c) => c.historical);
  const historicalNote = hasHistorical
    ? ' The percentages quoted above for historical candidates (carried over with no raw record re-measured this session) are cross-session comparisons against the current baseline and are not directly comparable — see the Findings/table above, which render those as "n/a (different session)".'
    : "";
  if (d.policy === "inconclusive") {
    return `**No heavy-work serialization policy is recommended yet — inconclusive.** ${d.rationale}${historicalNote}`;
  }
  const label =
    d.policy === "admission-queue"
      ? `admission-queue @ ${d.thresholdMiB}MiB`
      : d.policy;
  return `**Recommended heavy-work serialization policy: ${label}.** ${d.rationale}${historicalNote}`;
}

const QUESTION =
  "What happens when the renderer, the LLM, and stable-diffusion.cpp image generation run concurrently under 16 GB unified memory, and which heavy-work serialization policy — unconstrained, a global mutex, or an admission-controlled queue — does the measured data support?";

const HOW_TO_RUN = `**Staging (prerequisite, not timed):** start every service and keep it running for every scenario invocation below.

\`\`\`sh
ollama serve &                       # native /api/chat on :11434 (llama3.2:3b, ADR-0005's baseline profile)
/tmp/PantheaProbe/panthea-probe-renderer.app/Contents/MacOS/panthea-probe-renderer > /tmp/panthea-probe-renderer.stdout.log 2>&1 &
cd tools/probes/art-local && ./bin/sd-server --model models/sd-v1-5-pruned-emaonly-Q8_0.gguf --listen-port 1234 --diffusion-fa &
\`\`\`

**Scenario** (one 3-minute window per candidate; run \`baseline\` first):

\`\`\`sh
cd tools/probes/coexistence
bun run src/run.ts scenario --name baseline --duration-ms 180000 \\
  --ollama-base-url http://localhost:11434 --model llama3.2:3b \\
  --ollama-pid <ollama-serve-pid> --renderer-pid <renderer-pid> \\
  --renderer-log /tmp/panthea-probe-renderer.stdout.log --label A-baseline

bun run src/run.ts scenario --name unconstrained --duration-ms 180000 \\
  --ollama-base-url http://localhost:11434 --model llama3.2:3b \\
  --sdcpp-base-url http://127.0.0.1:1234 \\
  --ollama-pid <pid> --sdserver-pid <pid> --renderer-pid <pid> \\
  --renderer-log /tmp/panthea-probe-renderer.stdout.log --label B-unconstrained

bun run src/run.ts scenario --name mutex ... --label C-mutex

bun run src/run.ts scenario --name admission --threshold-mib 3072 ... --label D-admission-3gib
bun run src/run.ts scenario --name admission --threshold-mib 5120 ... --label D-admission-5gib
\`\`\`

**Transition costs**:

\`\`\`sh
ollama stop llama3.2:3b   # evict the model, forcing the next request to reload it
bun run src/run.ts transition-llm --ollama-base-url http://localhost:11434 --model llama3.2:3b \\
  --transition llm-cold-after-sdcpp-resident --label llm-cold-after-sdcpp

kill <sd-server-pid>
bun run src/run.ts sdserver-spawn --binary ./bin/sd-server --model models/sd-v1-5-pruned-emaonly-Q8_0.gguf \\
  --port 1234 --transition sdserver-cold-after-llm-resident --label sdserver-cold-after-llm
\`\`\`

**Report**: \`bun run src/run.ts report\` — renders this README from raw \`results/*.json\` records when present (and regenerates the committed \`results/summary.json\` published aggregate to match); on a fresh checkout with no raw records, renders from that committed aggregate instead and leaves it untouched; with neither present, exits non-zero and writes nothing.

**Publish raw**: \`bun run src/run.ts publish-raw\` — writes redacted per-request/per-tick sample records for the re-measured scenarios under \`results/raw/\` (see Caveat).`;

function buildCaveat(): string {
  const parts: string[] = [
    "Each scenario window is 3 minutes; longer windows would surface slower memory-pressure effects (sustained compression growth, deferred jetsam) this probe's window may miss.",
    "Renderer frame p95 is sampled via a `d`-keystroke dump into the packaged app's stdout log before and after each window, not continuously during it (a continuous automated-keystroke sampler would itself compete for the same CPU the renderer's animation loop runs on) — the window server driving synthetic keystrokes measured flaky in this environment; when a dump could not be captured the table records `n/a` rather than a stale or fabricated number.",
    "Draw Things was not exercised here — art-local's stable-diffusion.cpp base arm is the only image-generation adapter under contention (Unit 7's owner direction: sd.cpp is the cross-platform base arm and must work standalone).",
    "The pixel-art LoRA used by art-local's own bench is omitted here: this probe measures memory/latency contention, not image style, and the LoRA is a negligible ~26 MiB addition to sd-server's resident footprint.",
    "This machine carries a large pre-existing swap floor (roughly 7 GiB already committed before this probe's own scenarios ever ran) that macOS's dynamic swapfiles do not shrink again once the pressure that caused them eases — every scenario's peak-swap reading includes that inherited floor, not just this probe's own contribution, so peak swap alone is not a clean discriminating signal between candidates; min free+inactive memory and the LLM p95 penalty are the more reliable ones.",
    "No co-resident qemu-system-aarch64 VM was running during this probe's scenarios (checked via `pgrep -fl qemu` immediately before and after) — unlike the background load noted in tools/probes/inference-baseline/README.md's own caveat, this run's contention is attributable to the three tracked services alone plus the pre-existing swap floor above.",
    "Fro Bot review on PR #22 found three measurement bugs in the original run: LLM p50/p95 included failed/timed-out requests (inflating or, for an all-failed scenario, silently reading p95=0), a missing post-window frame dump fell back to the pre-window value instead of reading n/a, and 'no viable candidate' silently defaulted to recommending the mutex hypothesis instead of reporting inconclusive. All three are fixed in this run's code (success-only percentiles with a >=20-success/<=5%-error-rate evaluability floor, frame p95 only ever from a verified post-window sample, and an explicit 'inconclusive' outcome that never silently picks a fallback). The A (baseline) and D-admission-3072MiB scenarios were re-measured end to end with the fixed sampler; B (unconstrained), C (mutex), and D-admission-5120MiB were not re-run because their raw per-request records were gitignored and did not survive the worktree that produced them being retired — their rows below carry over the original run's LLM p50/p95/images/peak-swap numbers for context but are marked not-evaluable (their success/error counts and post-window frame samples cannot be recomputed without the lost raw records).",
    "The re-measured D-admission-queue@3072MiB result changed materially between runs: the original run (same code, same machine, several hours earlier in a long multi-scenario session) measured a -10.6% LLM p95 penalty; this fresh, independently-started re-run measured +148.4%, with LLM latency climbing roughly monotonically across the 3-minute window (352ms first request → 3329ms last) while sd.cpp generated images almost back-to-back (6 images in 180s — the 3072MiB gate was cleared almost continuously and rarely actually throttled image start). Both runs used the same (correct, success-only) percentile logic for this scenario — the difference is real machine-to-machine-session variance, not a measurement artifact, and it means a single 3-minute window's number for this threshold should not be treated as stable without a repeat measurement.",
    "Fro Bot's round-2 review on PR #22 found three more issues: a candidate could be recommended even when its (or the baseline's) renderer frame p95 had no verified post-window sample; the global mutex was structurally excluded from ever winning instead of being judged by the same criteria as every other candidate; and a historical candidate's LLM p95 percentage was compared directly against a freshly re-measured baseline as if both came from the same run. All three are fixed: evaluateCandidate/choosePolicy now treat a missing post-window frame sample (baseline or candidate) as not-evaluable — nothing can be recommended without one; the mutex is evaluated under the identical healthy/completes-images/<=25%-penalty/frame-evaluable bar as unconstrained and admission-queue, and can win on its own merits (it does not, here — see the table); and any comparison between a historical candidate and the current (fresh) baseline now renders as 'n/a (different session)' rather than a number, in both the results table and the findings list.",
    "Redacted raw sample records for the two re-measured scenarios (A-baseline, D-admission-3gib) are published under results/raw/ (bun run src/run.ts publish-raw): per-request {t, ok, latencyMs} and per-tick {t, freeMiB, inactiveMiB, swapUsedMiB, rss} — no prompts, no completions, no environment strings — so the table above is independently checkable, not just an assertion. Combined payload here is well under the 300 KB budget (no downsampling needed); if a future re-run's combined payload exceeds it, memory ticks are downsampled to 1-second buckets and the published record says so via its own downsampled field.",
  ];
  const qemu = process.env.COEXISTENCE_QEMU_NOTE;
  if (qemu) {
    parts.push(qemu);
  }
  return parts.join(" ");
}

function writeReadmeFromSummary(summary: Summary): void {
  const sections = [
    `## Question\n\n${QUESTION}`,
    `## How to run\n\n${HOW_TO_RUN}`,
    `## Caveat\n\n${buildCaveat()}`,
    `## Environment\n\n${buildEnvironmentTable(summary.environment)}`,
    `## Results\n\n#### Per-scenario memory and latency\n\n${buildScenarioTable(summary)}\n\n#### Transition costs\n\n${buildTransitionsTable(summary)}`,
    `## Findings\n\n${buildFindings(summary)
      .map((f) => `- ${f}`)
      .join("\n")}`,
    `## Bottom line\n\n${buildBottomLine(summary)}`,
  ];
  writeFileSync(README_PATH, sections.join("\n\n"));
  console.error(`[coexistence] wrote ${README_PATH}`);
}

/**
 * Merges a fresh raw-derived summary with the previously committed one: a
 * fresh baseline/candidate/transition entry overrides a committed entry of
 * the same label (a re-run with corrected instrumentation); a committed
 * entry whose label has no fresh counterpart (its raw records are gone —
 * gitignored, not recomputable) is kept as historical context. Historical
 * entries predate the success/error-count and frame-evaluability fields, so
 * they read as "not evaluable" wherever those fields are missing — never
 * silently promoted to look freshly verified.
 */
function mergeSummaries(committed: Summary, fresh: Summary): Summary {
  const baseline =
    fresh.baseline ??
    (committed.baseline
      ? { ...committed.baseline, historical: true }
      : undefined);
  const freshLabels = new Set(fresh.candidates.map((c) => c.label));
  const candidates = [
    ...fresh.candidates,
    ...committed.candidates
      .filter((c) => !freshLabels.has(c.label))
      .map((c) => ({ ...c, historical: true })),
  ];
  const environment = fresh.environment ?? committed.environment;
  const transitions =
    fresh.transitions.length > 0 ? fresh.transitions : committed.transitions;
  const decision =
    baseline && candidates.length > 0
      ? choosePolicy({ baseline, candidates })
      : undefined;
  return {
    generatedAt: new Date().toISOString(),
    environment,
    baseline,
    candidates,
    transitions,
    decision,
  };
}

/**
 * `report`'s three-way dispatch:
 *   1. Raw `results/*.json` records exist — build a fresh summary from
 *      them, merged with the committed aggregate (see
 *      {@link mergeSummaries}) so a partial re-run (e.g. only the baseline
 *      and one candidate re-measured after a sampler fix) doesn't silently
 *      drop every other previously-published candidate whose raw records
 *      are gone. Render the README and regenerate `summary.json`.
 *   2. No raw records, but the committed `results/summary.json` aggregate
 *      exists — a fresh checkout: render the README from that aggregate
 *      instead, and leave `summary.json` untouched.
 *   3. Neither exists: nothing to report — exit non-zero without writing
 *      any file.
 */
function cmdReport(): void {
  const rawFiles = listRawResultFiles();
  const committedSummary = loadCommittedSummary();
  if (rawFiles.length > 0) {
    const records = loadRawRecords();
    const fresh = buildSummary(records);
    const summary = committedSummary
      ? mergeSummaries(committedSummary, fresh)
      : fresh;
    writeReadmeFromSummary(summary);
    persistSummary(summary);
    return;
  }
  if (committedSummary) {
    writeReadmeFromSummary(committedSummary);
    console.error(
      "[coexistence] rendered README from committed results/summary.json (no raw results/*.json records present) — summary.json left unchanged",
    );
    return;
  }
  console.error(
    "[coexistence] no results found: no raw results/*.json records and no results/summary.json — nothing to report",
  );
  process.exitCode = 1;
}

const RAW_DIR = join(RESULTS_DIR, "raw");
/** Total budget for every published redacted raw record combined — kept small deliberately so it's cheap to commit and review; downsample rather than blow through it. */
const MAX_PUBLISHED_RAW_BYTES = 300 * 1024;
/** The only two scenarios re-measured with the fixed instrumentation (see the README caveat); the rest are historical and have no raw record left to redact. */
const PUBLISHABLE_RAW_LABELS = ["A-baseline", "D-admission-3gib"];

interface RedactedLlmSample {
  readonly t: number;
  readonly ok: boolean;
  readonly latencyMs: number;
}

interface RedactedMemoryTick {
  readonly t: number;
  readonly freeMiB: number;
  readonly inactiveMiB: number;
  readonly swapUsedMiB: number | undefined;
  readonly rss: Readonly<Record<string, number>>;
}

interface RedactedScenario {
  readonly label: string;
  readonly durationMs: number;
  readonly llmSamples: readonly RedactedLlmSample[];
  readonly memoryTicks: readonly RedactedMemoryTick[];
  /** `true` if `memoryTicks` was downsampled to keep the published total under {@link MAX_PUBLISHED_RAW_BYTES}. */
  readonly downsampled: boolean;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Strips a raw {@link ScenarioRecord} down to exactly the fields this
 * probe's decision depends on — per-request `{t, ok, latencyMs}` and
 * per-tick `{t, freeMiB, inactiveMiB, swapUsedMiB, rss}` — and nothing
 * else: no prompts, no completions, no environment strings, no derived
 * fields already published in `summary.json`. Never throws; `t` values are
 * relative milliseconds since the scenario started, never wall-clock
 * timestamps.
 */
function redactScenarioRecord(record: ScenarioRecord): RedactedScenario {
  const llmSamples: RedactedLlmSample[] = record.llmSamples.map((s) => ({
    t: Math.round(s.atMs),
    ok: s.ok,
    latencyMs: Math.round(s.totalMs),
  }));
  const memoryTicks: RedactedMemoryTick[] = record.memorySamples.map((s) => ({
    t: Math.round(s.atMs),
    freeMiB: round1(s.freeMiB),
    inactiveMiB: round1(s.inactiveMiB),
    swapUsedMiB:
      s.swapUsedMiB !== undefined ? round1(s.swapUsedMiB) : undefined,
    rss: Object.fromEntries(
      Object.entries(s.processRssMiB).map(([name, mib]) => [name, round1(mib)]),
    ),
  }));
  return {
    label: record.label,
    durationMs: record.durationMs,
    llmSamples,
    memoryTicks,
    downsampled: false,
  };
}

/** Keeps only the first tick in each 1-second bucket — a coarser but still trend-legible series. */
function downsampleMemoryTicksToOneSecond(
  ticks: readonly RedactedMemoryTick[],
): readonly RedactedMemoryTick[] {
  const buckets = new Map<number, RedactedMemoryTick>();
  for (const tick of ticks) {
    const bucketKey = Math.floor(tick.t / 1000);
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, tick);
    }
  }
  return [...buckets.values()];
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Publishes redacted raw sample records for the scenarios re-measured with
 * the fixed instrumentation ({@link PUBLISHABLE_RAW_LABELS}) under
 * `results/raw/`, so the report's numbers are independently checkable
 * without trusting `summary.json`'s already-computed aggregates alone.
 * Downsamples memory ticks to 1-second buckets (and says so in the
 * published record) if the combined redacted payload would otherwise
 * exceed {@link MAX_PUBLISHED_RAW_BYTES}.
 */
function cmdPublishRaw(): void {
  const redacted: RedactedScenario[] = [];
  for (const label of PUBLISHABLE_RAW_LABELS) {
    const path = join(RESULTS_DIR, `${label}.json`);
    if (!existsSync(path)) {
      console.error(
        `[coexistence] publish-raw: no raw record for ${label} on disk, skipping`,
      );
      continue;
    }
    const record = JSON.parse(readFileSync(path, "utf8")) as ScenarioRecord;
    redacted.push(redactScenarioRecord(record));
  }
  if (redacted.length === 0) {
    console.error(
      "[coexistence] publish-raw: no publishable raw records found — nothing written",
    );
    process.exitCode = 1;
    return;
  }

  let totalBytes = byteLength(redacted);
  if (totalBytes > MAX_PUBLISHED_RAW_BYTES) {
    for (let i = 0; i < redacted.length; i += 1) {
      const entry = redacted[i];
      if (entry) {
        redacted[i] = {
          ...entry,
          memoryTicks: downsampleMemoryTicksToOneSecond(entry.memoryTicks),
          downsampled: true,
        };
      }
    }
    totalBytes = byteLength(redacted);
    console.error(
      `[coexistence] publish-raw: downsampled memory ticks to 1s to fit the ${MAX_PUBLISHED_RAW_BYTES}-byte budget`,
    );
  }

  mkdirSync(RAW_DIR, { recursive: true });
  for (const entry of redacted) {
    const outPath = join(RAW_DIR, `${entry.label}.json`);
    writeFileSync(outPath, JSON.stringify(entry, null, 2));
    console.error(`[coexistence] wrote ${outPath}`);
  }
  console.error(
    `[coexistence] publish-raw: ${redacted.length} file(s), ${totalBytes} bytes total (budget ${MAX_PUBLISHED_RAW_BYTES})`,
  );
  if (totalBytes > MAX_PUBLISHED_RAW_BYTES) {
    console.error(
      `[coexistence] publish-raw: WARNING — still over budget after 1s downsampling (${totalBytes} > ${MAX_PUBLISHED_RAW_BYTES} bytes)`,
    );
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (command) {
    case "scenario":
      await cmdScenario(flags);
      return;
    case "transition-llm":
      await cmdTransitionLlm(flags);
      return;
    case "sdserver-spawn":
      await cmdSdserverSpawn(flags);
      return;
    case "report":
      cmdReport();
      return;
    case "publish-raw":
      cmdPublishRaw();
      return;
    default:
      console.error(
        "usage: bun run src/run.ts <scenario|transition-llm|sdserver-spawn|report|publish-raw> [flags]",
      );
      process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
