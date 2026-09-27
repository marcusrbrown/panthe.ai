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

  const totals = llmSamples.map((s) => s.totalMs);
  console.error(
    `[coexistence] ${label}: LLM p50/p95=${percentile50(totals)?.toFixed(0)}/${percentile95(totals)?.toFixed(0)}ms ` +
      `images=${imageSamples.filter((s) => s.ok).length}/${imageSamples.length} ` +
      `frameP95 before/after=${rendererFrameP95Before ?? "n/a"}/${rendererFrameP95After ?? "n/a"} ` +
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

function buildScenarioMetrics(record: ScenarioRecord): ScenarioMetrics {
  const totals = record.llmSamples.map((s) => s.totalMs);
  const swapValues = record.memorySamples
    .map((s) => s.swapUsedMiB)
    .filter((v): v is number => v !== undefined);
  const admissionValues = record.memorySamples.map((s) => s.admissionMiB);
  return {
    llmP50Ms: percentile50(totals) ?? 0,
    llmP95Ms: percentile95(totals) ?? 0,
    imagesCompleted: record.imageSamples.filter((s) => s.ok).length,
    rendererFrameP95Ms:
      record.rendererFrameP95After ?? record.rendererFrameP95Before,
    peakSwapUsedMiB: swapValues.length > 0 ? Math.max(...swapValues) : 0,
    minFreeMiB: admissionValues.length > 0 ? Math.min(...admissionValues) : 0,
    processDied: record.processDied,
  };
}

interface Summary {
  readonly generatedAt: string;
  readonly environment: EnvironmentInfo | undefined;
  readonly baseline: (ScenarioMetrics & { readonly label: string }) | undefined;
  readonly candidates: readonly (CandidateResult & {
    readonly label: string;
  })[];
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
    ? { ...buildScenarioMetrics(baselineRecord), label: baselineRecord.label }
    : undefined;
  const candidates = candidateRecords.map((r) => ({
    ...buildScenarioMetrics(r),
    policy: r.policy as PolicyName,
    thresholdMiB: r.thresholdMiB,
    label: r.label,
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

function buildScenarioTable(summary: Summary): string {
  const rows: string[] = [];
  const header =
    "| Scenario | LLM p50 (ms) | LLM p95 (ms) | p95 penalty vs A | Images completed | Frame p95 (ms) | Peak swap (MiB) | Min free+inactive (MiB) | Process died |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  rows.push(header);
  if (summary.baseline) {
    const b = summary.baseline;
    rows.push(
      `| A: baseline (renderer + LLM) | ${formatMs(b.llmP50Ms)} | ${formatMs(b.llmP95Ms)} | — | ${b.imagesCompleted} | ${formatMs(b.rendererFrameP95Ms)} | ${formatMiB(b.peakSwapUsedMiB)} | ${formatMiB(b.minFreeMiB)} | ${b.processDied} |`,
    );
  }
  for (const c of summary.candidates) {
    const penalty = summary.baseline
      ? computePenalty(c.llmP95Ms, summary.baseline.llmP95Ms)
      : undefined;
    const penaltyStr =
      penalty === undefined
        ? "n/a"
        : Number.isFinite(penalty)
          ? `${penalty >= 0 ? "+" : ""}${(penalty * 100).toFixed(1)}%`
          : "n/a (baseline p95 was 0ms)";
    const name =
      c.policy === "admission-queue"
        ? `D: admission-queue @ ${c.thresholdMiB}MiB`
        : c.policy === "unconstrained"
          ? "B: unconstrained"
          : "C: mutex";
    rows.push(
      `| ${name} | ${formatMs(c.llmP50Ms)} | ${formatMs(c.llmP95Ms)} | ${penaltyStr} | ${c.imagesCompleted} | ${formatMs(c.rendererFrameP95Ms)} | ${formatMiB(c.peakSwapUsedMiB)} | ${formatMiB(c.minFreeMiB)} | ${c.processDied} |`,
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
    findings.push(
      `Baseline (renderer + LLM loop only): LLM p50/p95 ${formatMs(summary.baseline.llmP50Ms)}/${formatMs(summary.baseline.llmP95Ms)}ms, renderer frame p95 ${formatMs(summary.baseline.rendererFrameP95Ms)}ms.`,
    );
  }
  for (const c of summary.candidates) {
    const penalty = summary.baseline
      ? computePenalty(c.llmP95Ms, summary.baseline.llmP95Ms)
      : undefined;
    const label =
      c.policy === "admission-queue"
        ? `admission-queue@${c.thresholdMiB}MiB`
        : c.policy;
    findings.push(
      `${label}: LLM p95 ${formatMs(c.llmP95Ms)}ms (${penalty !== undefined && Number.isFinite(penalty) ? `${penalty >= 0 ? "+" : ""}${(penalty * 100).toFixed(1)}%` : "n/a"} vs baseline), ${c.imagesCompleted} image(s) completed, peak swap ${formatMiB(c.peakSwapUsedMiB)}MiB, min free+inactive ${formatMiB(c.minFreeMiB)}MiB${c.processDied ? ", process died" : ""}.`,
    );
  }
  for (const t of summary.transitions) {
    findings.push(
      `Transition ${t.transition}: ${t.ms.toFixed(0)}ms (ok=${t.ok}).`,
    );
  }
  return findings;
}

function buildBottomLine(summary: Summary): string {
  if (!summary.decision) {
    return "Not enough scenarios recorded yet to make a policy recommendation — need the baseline plus at least one candidate.";
  }
  const d = summary.decision;
  const label =
    d.policy === "admission-queue"
      ? `admission-queue @ ${d.thresholdMiB}MiB`
      : d.policy;
  return `**Recommended heavy-work serialization policy: ${label}.** ${d.rationale}`;
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

**Report**: \`bun run src/run.ts report\` — renders this README from raw \`results/*.json\` records when present (and regenerates the committed \`results/summary.json\` published aggregate to match); on a fresh checkout with no raw records, renders from that committed aggregate instead and leaves it untouched; with neither present, exits non-zero and writes nothing.`;

function buildCaveat(): string {
  const parts: string[] = [
    "Each scenario window is 3 minutes; longer windows would surface slower memory-pressure effects (sustained compression growth, deferred jetsam) this probe's window may miss.",
    "Renderer frame p95 is sampled via a `d`-keystroke dump into the packaged app's stdout log before and after each window, not continuously during it (a continuous automated-keystroke sampler would itself compete for the same CPU the renderer's animation loop runs on) — the window server driving synthetic keystrokes measured flaky in this environment; when a dump could not be captured the table records `n/a` rather than a stale or fabricated number.",
    "Draw Things was not exercised here — art-local's stable-diffusion.cpp base arm is the only image-generation adapter under contention (Unit 7's owner direction: sd.cpp is the cross-platform base arm and must work standalone).",
    "The pixel-art LoRA used by art-local's own bench is omitted here: this probe measures memory/latency contention, not image style, and the LoRA is a negligible ~26 MiB addition to sd-server's resident footprint.",
    "Peak swap reads identically (~7015 MiB) across every scenario below, including the renderer+LLM-only baseline: this machine already had that swap committed before this probe started (a pre-existing, not probe-caused, condition — macOS grows its dynamic swapfiles but does not shrink them again after the pressure that caused them eases, so a prior session's peak persists as this session's floor). Peak swap is therefore not a discriminating signal between candidates in this run; min free+inactive memory and the LLM p95 penalty are.",
    "No co-resident qemu-system-aarch64 VM was running during this probe's scenarios (checked via `pgrep -fl qemu` immediately before and after) — unlike the background load noted in tools/probes/inference-baseline/README.md's own caveat, this run's contention is attributable to the three tracked services alone plus the pre-existing swap floor above.",
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

function cmdReport(): void {
  const rawFiles = listRawResultFiles();
  const committedSummary = loadCommittedSummary();
  if (rawFiles.length > 0) {
    const records = loadRawRecords();
    const summary = buildSummary(records);
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
    default:
      console.error(
        "usage: bun run src/run.ts <scenario|transition-llm|sdserver-spawn|report> [flags]",
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
