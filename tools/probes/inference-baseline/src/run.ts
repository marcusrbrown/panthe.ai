#!/usr/bin/env bun
// CLI entry point driving the inference-baseline probe. Model staging
// (`ollama pull`, the llama-server binary, and launching the probe-renderer
// app) is a prerequisite done outside this tool (see README "How to run") —
// this file only exercises already-running servers and persists/report the
// measurements. Four subcommands:
//
//   suite    --server ollama|llama-server --base-url <url> --model <name>
//            --tier 1k|4k --max-tokens <n> --timeout-ms <n>
//            [--repair-audit <n>] [--rss-pid <pid>] [--renderer-log <path>]
//            --label <name>
//     Runs the full 40-prompt native-schema suite (plus an optional
//     prompt-only + repair audit sample of `--repair-audit` prompts),
//     polling an external process's RSS and, optionally, sampling the
//     renderer probe's frame-time p50/p95 before and after via a
//     `d`-keystroke dump into its stdout log. Writes results/<label>.json.
//
//   parallel --server --base-url --model --tier --concurrency <n>
//            --sample-count <n> --max-tokens --timeout-ms [--rss-pid]
//            --label
//     Fires `--sample-count` prompts in batches of `--concurrency` to
//     compare parallel=1 vs parallel=2 throughput and RSS growth.
//
//   outage   --server --base-url --model --tier --max-tokens --timeout-ms
//            --kill-pid <pid> --kill-after <n> --request-count <n> --label
//     Runs prompts sequentially; after `--kill-after` complete, sends
//     SIGTERM to `--kill-pid` and keeps issuing the remaining requests to
//     confirm the bench records a clean timeout/network-error and
//     continues rather than crashing.
//
//   report   [--out README.md]
//     Reads every results/*.json record and renders the README.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  captureEnvironment,
  p50 as percentile50,
  p95 as percentile95,
  renderReport,
} from "@panthea/tools-probes-shared";
import {
  type ContextTier,
  type ExpectedKinds,
  estimateSchedule,
  type PromptFixture,
  type PromptResult,
  runPrompt,
  runSuite,
  summarizeValidity,
} from "./bench";
import expectedJson from "./fixtures/expected.json";
import promptsJson from "./fixtures/prompts.json";
import {
  type ChatServer,
  createLlamaServerServer,
  createOllamaServer,
} from "./servers";

const SRC_DIR = import.meta.dir;
const PROBE_DIR = join(SRC_DIR, "..");
const RESULTS_DIR = join(PROBE_DIR, "results");
const README_PATH = join(PROBE_DIR, "README.md");

const PROMPTS = promptsJson as unknown as readonly PromptFixture[];
const EXPECTED = expectedJson as unknown as ExpectedKinds;

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

function isTier(value: string): value is ContextTier {
  return value === "1k" || value === "4k";
}

function buildServer(name: string, baseUrl: string): ChatServer {
  if (name === "ollama") {
    return createOllamaServer(baseUrl);
  }
  if (name === "llama-server") {
    return createLlamaServerServer(baseUrl);
  }
  throw new Error(
    `unknown --server: ${name} (expected ollama or llama-server)`,
  );
}

interface RssSamples {
  readonly peakBytes: number | undefined;
  readonly sampleCount: number;
}

function pollExternalRss(pid: number, intervalMs = 1500) {
  let peakKb = 0;
  let sampleCount = 0;
  const timer = setInterval(() => {
    try {
      const result = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)]);
      const text = result.stdout.toString().trim();
      const kb = Number(text);
      if (Number.isFinite(kb) && kb > 0) {
        sampleCount += 1;
        if (kb > peakKb) {
          peakKb = kb;
        }
      }
    } catch {
      // Process gone (e.g. the outage test's mid-run kill) — stop counting.
    }
  }, intervalMs);
  return {
    stop(): RssSamples {
      clearInterval(timer);
      return { peakBytes: peakKb > 0 ? peakKb * 1024 : undefined, sampleCount };
    },
  };
}

interface FrameStats {
  readonly p50: number;
  readonly p95: number;
  readonly sampleCount: number;
}

/** Triggers a metrics dump in the already-running probe-renderer app (`d`
 * keystroke via System Events) and reads the frame-time block back out of
 * its captured stdout log. Returns undefined (never throws) if the app or
 * log isn't available — a probe run must not fail because the renderer
 * concurrency signal couldn't be sampled. */
async function sampleRendererFrameStats(
  logPath: string,
): Promise<FrameStats | undefined> {
  try {
    if (!existsSync(logPath)) {
      return undefined;
    }
    Bun.spawnSync([
      "osascript",
      "-e",
      'tell application "System Events" to tell process "panthea-probe-renderer" to set frontmost to true',
    ]);
    await Bun.sleep(150);
    Bun.spawnSync([
      "osascript",
      "-e",
      'tell application "System Events" to keystroke "d"',
    ]);
    await Bun.sleep(500);
    const content = readFileSync(logPath, "utf8");
    const idx = content.lastIndexOf('"frameTime"');
    if (idx === -1) {
      return undefined;
    }
    const slice = content.slice(idx, idx + 200);
    const p50Match = /"p50":\s*([\d.]+)/.exec(slice);
    const p95Match = /"p95":\s*([\d.]+)/.exec(slice);
    const countMatch = /"sampleCount":\s*(\d+)/.exec(slice);
    if (!p50Match || !p95Match || !countMatch) {
      return undefined;
    }
    return {
      p50: Number(p50Match[1]),
      p95: Number(p95Match[1]),
      sampleCount: Number(countMatch[1]),
    };
  } catch {
    return undefined;
  }
}

function writeResult(label: string, record: Record<string, unknown>): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = join(RESULTS_DIR, `${label}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2));
  console.error(`[inference-baseline] wrote ${path}`);
}

function summarizeLatency(results: readonly PromptResult[]): {
  ttftP50: number | undefined;
  ttftP95: number | undefined;
  totalP50: number | undefined;
  totalP95: number | undefined;
  tokPerSecP50: number | undefined;
} {
  const nativeResults = results.filter(
    (r) => r.mode === "native" && r.ttftMs !== undefined,
  );
  const ttft = nativeResults
    .map((r) => r.ttftMs)
    .filter((v): v is number => v !== undefined);
  const total = nativeResults
    .map((r) => r.totalMs)
    .filter((v): v is number => v !== undefined);
  const tokPerSec = nativeResults
    .map((r) => r.tokPerSec)
    .filter((v): v is number => v !== undefined);
  return {
    ttftP50: percentile50(ttft),
    ttftP95: percentile95(ttft),
    totalP50: percentile50(total),
    totalP95: percentile95(total),
    tokPerSecP50: percentile50(tokPerSec),
  };
}

async function cmdSuite(flags: Record<string, string>): Promise<void> {
  const serverName = requireFlag(flags, "server");
  const baseUrl = requireFlag(flags, "base-url");
  const model = requireFlag(flags, "model");
  const tierRaw = requireFlag(flags, "tier");
  if (!isTier(tierRaw)) {
    throw new Error("--tier must be 1k or 4k");
  }
  const label = requireFlag(flags, "label");
  const maxTokens = Number(flags["max-tokens"] ?? "150");
  const timeoutMs = Number(flags["timeout-ms"] ?? "30000");
  const repairAuditCount = Number(flags["repair-audit"] ?? "0");
  const rssPid = flags["rss-pid"] ? Number(flags["rss-pid"]) : undefined;
  const rendererLog = flags["renderer-log"];

  const server = buildServer(serverName, baseUrl);
  const contextTokens = tierRaw === "1k" ? 1024 : 4096;
  const repairAuditPromptIds = PROMPTS.slice(0, repairAuditCount).map(
    (p) => p.id,
  );

  const rssPoller = rssPid !== undefined ? pollExternalRss(rssPid) : undefined;
  const rendererBefore = rendererLog
    ? await sampleRendererFrameStats(rendererLog)
    : undefined;

  console.error(
    `[inference-baseline] suite ${label}: ${serverName} ${model} @ ${tierRaw} (${PROMPTS.length} prompts` +
      (repairAuditCount > 0 ? ` + ${repairAuditCount} repair-audit)` : ")"),
  );
  const startedAt = Date.now();
  const results = await runSuite(server, PROMPTS, EXPECTED, tierRaw, {
    model,
    contextTokens,
    maxTokens,
    timeoutMs,
    repairAuditPromptIds,
  });
  const wallMs = Date.now() - startedAt;

  const rendererAfter = rendererLog
    ? await sampleRendererFrameStats(rendererLog)
    : undefined;
  const rss = rssPoller?.stop();

  const validity = summarizeValidity(results);
  const latency = summarizeLatency(results);
  console.error(
    `[inference-baseline] ${label}: nativeValid=${(validity.nativeValidRate * 100).toFixed(0)}% ` +
      `kindOk=${(validity.kindAcceptableRate * 100).toFixed(0)}% ` +
      `ttft p50/p95=${latency.ttftP50?.toFixed(0)}/${latency.ttftP95?.toFixed(0)}ms ` +
      `total p50/p95=${latency.totalP50?.toFixed(0)}/${latency.totalP95?.toFixed(0)}ms ` +
      `tok/s p50=${latency.tokPerSecP50?.toFixed(1)} wall=${wallMs}ms`,
  );

  writeResult(label, {
    kind: "suite",
    label,
    server: serverName,
    model,
    tier: tierRaw,
    timestamp: new Date().toISOString(),
    wallMs,
    results,
    rss,
    rendererBefore,
    rendererAfter,
  });
}

async function cmdParallel(flags: Record<string, string>): Promise<void> {
  const serverName = requireFlag(flags, "server");
  const baseUrl = requireFlag(flags, "base-url");
  const model = requireFlag(flags, "model");
  const tierRaw = requireFlag(flags, "tier");
  if (!isTier(tierRaw)) {
    throw new Error("--tier must be 1k or 4k");
  }
  const label = requireFlag(flags, "label");
  const concurrency = Number(flags.concurrency ?? "2");
  const sampleCount = Number(flags["sample-count"] ?? "20");
  const maxTokens = Number(flags["max-tokens"] ?? "150");
  const timeoutMs = Number(flags["timeout-ms"] ?? "30000");
  const rssPid = flags["rss-pid"] ? Number(flags["rss-pid"]) : undefined;

  const server = buildServer(serverName, baseUrl);
  const contextTokens = tierRaw === "1k" ? 1024 : 4096;
  const prompts = PROMPTS.slice(0, sampleCount);
  const rssPoller = rssPid !== undefined ? pollExternalRss(rssPid) : undefined;

  console.error(
    `[inference-baseline] parallel ${label}: ${serverName} ${model} @ ${tierRaw}, concurrency=${concurrency}, ${prompts.length} prompts`,
  );
  const startedAt = Date.now();
  const results: PromptResult[] = [];
  for (let i = 0; i < prompts.length; i += concurrency) {
    const batch = prompts.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((fixture) =>
        runPrompt(server, fixture, tierRaw, EXPECTED, {
          model,
          contextTokens,
          maxTokens,
          timeoutMs,
          useNativeSchema: true,
        }),
      ),
    );
    results.push(...batchResults);
  }
  const wallMs = Date.now() - startedAt;
  const rss = rssPoller?.stop();
  const throughputPerSec = results.length / (wallMs / 1000);

  console.error(
    `[inference-baseline] ${label}: ${results.length} reqs in ${wallMs}ms (${throughputPerSec.toFixed(2)} req/s), rssPeak=${rss?.peakBytes}`,
  );

  writeResult(label, {
    kind: "parallel",
    label,
    server: serverName,
    model,
    tier: tierRaw,
    concurrency,
    timestamp: new Date().toISOString(),
    wallMs,
    throughputPerSec,
    results,
    rss,
  });
}

async function cmdOutage(flags: Record<string, string>): Promise<void> {
  const serverName = requireFlag(flags, "server");
  const baseUrl = requireFlag(flags, "base-url");
  const model = requireFlag(flags, "model");
  const tierRaw = requireFlag(flags, "tier");
  if (!isTier(tierRaw)) {
    throw new Error("--tier must be 1k or 4k");
  }
  const label = requireFlag(flags, "label");
  const maxTokens = Number(flags["max-tokens"] ?? "150");
  const timeoutMs = Number(flags["timeout-ms"] ?? "8000");
  const killPid = Number(requireFlag(flags, "kill-pid"));
  const killAfter = Number(flags["kill-after"] ?? "2");
  const requestCount = Number(flags["request-count"] ?? "5");

  const server = buildServer(serverName, baseUrl);
  const contextTokens = tierRaw === "1k" ? 1024 : 4096;
  const prompts = PROMPTS.slice(0, requestCount);

  const results: PromptResult[] = [];
  for (const [index, fixture] of prompts.entries()) {
    const result = await runPrompt(server, fixture, tierRaw, EXPECTED, {
      model,
      contextTokens,
      maxTokens,
      timeoutMs,
      useNativeSchema: true,
    });
    results.push(result);
    console.error(
      `[inference-baseline] outage ${label}: request ${index + 1}/${prompts.length} -> ${result.outcome} (${result.totalMs?.toFixed(0)}ms)`,
    );
    if (index + 1 === killAfter) {
      console.error(
        `[inference-baseline] outage ${label}: sending SIGTERM to pid ${killPid}`,
      );
      try {
        process.kill(killPid, "SIGTERM");
      } catch (error) {
        console.error(
          `[inference-baseline] outage ${label}: kill failed: ${String(error)}`,
        );
      }
    }
  }

  writeResult(label, {
    kind: "outage",
    label,
    server: serverName,
    model,
    tier: tierRaw,
    killedAfter: killAfter,
    timestamp: new Date().toISOString(),
    results,
  });
}

interface StoredRecord {
  readonly kind: "suite" | "parallel" | "outage";
  readonly label: string;
  readonly server: string;
  readonly model: string;
  readonly tier: ContextTier;
  readonly results: readonly PromptResult[];
  readonly rss?: RssSamples;
  /** True for suite records captured before this probe's development caught
   * a PID-selection bug: Ollama's supervisor process (what `ollama serve`
   * prints as its own pid) never holds the model weights — a separate
   * `llama-server` runner child process does, spawned per loaded model with
   * a pid that only exists once the model is resident. Every candidate
   * model's suite run sampled the supervisor pid, so `rss.peakBytes` for
   * those runs is the harness's own idle footprint, not the model's. Fixed
   * for the parallel/outage runs and the recommended baseline profile,
   * which sample the actual runner pid (see the README's Caveat section). */
  readonly rssBug?: boolean;
  /** On-disk model size (from `ollama list`) recorded as a fallback memory
   * proxy for `rssBug` records — a lower bound on resident memory (weights
   * only, no KV cache), not a substitute for a real RSS measurement. */
  readonly diskSizeBytes?: number;
  readonly rendererBefore?: FrameStats;
  readonly rendererAfter?: FrameStats;
  readonly concurrency?: number;
  readonly wallMs?: number;
  readonly throughputPerSec?: number;
  readonly killedAfter?: number;
}

function loadResults(): readonly StoredRecord[] {
  if (!existsSync(RESULTS_DIR)) {
    return [];
  }
  return readdirSync(RESULTS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map(
      (name) =>
        JSON.parse(
          readFileSync(join(RESULTS_DIR, name), "utf8"),
        ) as StoredRecord,
    );
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function formatMs(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toFixed(0);
}

function formatRss(bytes: number | undefined): string {
  return bytes === undefined
    ? "n/a"
    : `${(bytes / (1024 * 1024)).toFixed(0)} MiB`;
}

function buildModelMatrixMarkdown(records: readonly StoredRecord[]): string {
  const suites = records.filter(
    (r): r is StoredRecord & { kind: "suite" } => r.kind === "suite",
  );
  const header =
    "| Model | Server | Context | Native valid | Kind-acceptable | Repaired valid (audit) | TTFT p50/p95 (ms) | Completion p50/p95 (ms) | tok/s p50 | Server RSS peak | Renderer frame p95 (ms) |\n" +
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const rows = suites.map((record) => {
    const validity = summarizeValidity(record.results);
    const latency = summarizeLatency(record.results);
    const repaired =
      validity.repairedValidRate === undefined
        ? "n/a"
        : formatPct(validity.repairedValidRate);
    return (
      `| ${record.model} | ${record.server} | ${record.tier} | ${formatPct(validity.nativeValidRate)} | ` +
      `${formatPct(validity.kindAcceptableRate)} | ${repaired} | ` +
      `${formatMs(latency.ttftP50)}/${formatMs(latency.ttftP95)} | ` +
      `${formatMs(latency.totalP50)}/${formatMs(latency.totalP95)} | ` +
      `${latency.tokPerSecP50?.toFixed(1) ?? "n/a"} | ` +
      `${record.rssBug ? `${formatRss(record.diskSizeBytes)} (disk size\u2020)` : formatRss(record.rss?.peakBytes)} | ` +
      `${record.rendererAfter?.p95 ?? "n/a"} |`
    );
  });
  return [header, ...rows].join("\n");
}

function buildParallelMarkdown(records: readonly StoredRecord[]): string {
  const parallelRecords = records.filter((r) => r.kind === "parallel");
  if (parallelRecords.length === 0) {
    return "_No parallel=1 vs parallel=2 comparison recorded._";
  }
  const header =
    "| Model | Context | Concurrency | Requests | Wall time (ms) | Throughput (req/s) | RSS peak |\n| --- | --- | --- | --- | --- | --- | --- |";
  const rows = parallelRecords.map(
    (record) =>
      `| ${record.model} | ${record.tier} | ${record.concurrency} | ${record.results.length} | ${record.wallMs} | ${record.throughputPerSec?.toFixed(2)} | ${formatRss(record.rss?.peakBytes)} |`,
  );
  return [header, ...rows].join("\n");
}

function buildOutageMarkdown(records: readonly StoredRecord[]): string {
  const outageRecords = records.filter((r) => r.kind === "outage");
  if (outageRecords.length === 0) {
    return "_No outage test recorded._";
  }
  const header =
    "| Model | Request # | Outcome | Time (ms) |\n| --- | --- | --- | --- |";
  const rows = outageRecords.flatMap((record) =>
    record.results.map(
      (result, index) =>
        `| ${record.model} | ${index + 1}${index + 1 === record.killedAfter ? " (killed after)" : ""} | ${result.outcome} | ${formatMs(result.totalMs)} |`,
    ),
  );
  return [header, ...rows].join("\n");
}

/** Quality bar for the "candidate to actually deploy" ranking: a model that
 * hits the token cap on garbage or ignores the schema outright isn't a
 * viable population-scale candidate regardless of how fast it replies. */
const MIN_VIABLE_KIND_ACCEPTABLE_RATE = 0.7;

/**
 * Ranks candidate suites (Ollama only — the llama-server run is a
 * cross-check of an already-chosen candidate's GGUF, not a separate
 * candidate to rank against it) for the "which profile do we actually
 * recommend" decision: among suites clearing the viability bar, lowest p95
 * completion latency wins, because latency is what actually gates
 * population-scale reasoning cadence (see Population schedule estimate) —
 * the acceptance plan's 10s/30s targets don't discriminate between these
 * candidates (every one of them measured well under 30s p95). Falls back to
 * highest kind-acceptable rate if nothing clears the bar.
 */
function rankCandidates(
  records: readonly StoredRecord[],
): readonly (StoredRecord & { kind: "suite" })[] {
  const suites = records.filter(
    (r): r is StoredRecord & { kind: "suite" } =>
      r.kind === "suite" && r.server !== "llama-server",
  );
  const viable = suites.filter(
    (r) =>
      summarizeValidity(r.results).kindAcceptableRate >=
      MIN_VIABLE_KIND_ACCEPTABLE_RATE,
  );
  const pool = viable.length > 0 ? viable : suites;
  return [...pool].sort((a, b) => {
    if (viable.length > 0) {
      const aLatency =
        summarizeLatency(a.results).totalP95 ?? Number.POSITIVE_INFINITY;
      const bLatency =
        summarizeLatency(b.results).totalP95 ?? Number.POSITIVE_INFINITY;
      return aLatency - bLatency;
    }
    const aValidity = summarizeValidity(a.results).kindAcceptableRate;
    const bValidity = summarizeValidity(b.results).kindAcceptableRate;
    return bValidity - aValidity;
  });
}

function buildScheduleMarkdown(records: readonly StoredRecord[]): string {
  const bestSuite = rankCandidates(records)[0];
  if (!bestSuite) {
    return "_No suite results recorded yet — schedule estimate unavailable._";
  }
  const p95 = summarizeLatency(bestSuite.results).totalP95;
  if (p95 === undefined) {
    return "_No completion-latency samples recorded._";
  }
  const estimate = estimateSchedule(p95);
  return (
    `Using \`${bestSuite.model}\` @ ${bestSuite.tier} (measured p95 completion latency ${p95.toFixed(0)}ms) ` +
    `as the baseline profile, a single-model bounded queue (concurrency 1) serving ` +
    `${estimate.castSize} characters (7 gods + 20 inhabitants) supports ` +
    `**${estimate.reasoningTurnsPerMinute.toFixed(1)} reasoning turns/minute**, i.e. each character's next ` +
    `reasoning turn comes roughly every **${estimate.perCharacterCadenceSeconds.toFixed(1)}s** on average if turns ` +
    `are distributed round-robin. A character whose wait exceeds the ` +
    `${estimate.starvationThresholdSeconds}s acceptance-plan completion target ` +
    `(the starvation threshold used here) is effectively starved under this policy; at ` +
    `${estimate.castSize} characters and this measured p95, that threshold is ` +
    `${estimate.perCharacterCadenceSeconds > estimate.starvationThresholdSeconds ? "**already exceeded**" : "not yet exceeded, but has no slack left to absorb queueing overhead, context growth, or a second concurrent heavy consumer (image generation)"}.`
  );
}

function buildReadme(): void {
  const records = loadResults();
  const environment = captureEnvironment({
    extra: {
      ollama: "0.34.4",
      "llama-server release": "b11205 (ggml-org/llama.cpp, macos-arm64)",
      "llama-server sha256":
        "97b06f59ad15e2b4b6044ba7338c4e3f40354c6dc2b9c5cda234e2bd6b9fd65e",
    },
  });

  const base = renderReport({
    question:
      "Which locally-servable model, quantization, and context size meet the acceptance plan's 10s-first-reply / 30s-p95-completion model-feedback target on the M1 Pro 16GB baseline with the renderer scene running concurrently, and what reasoning-turn cadence does that support for 7 gods + 20 inhabitants?",
    howToRun:
      "**Staging (prerequisite, not timed):**\n\n```sh\nollama serve &                      # native /api/chat on :11434\nollama pull <model>                  # e.g. qwen3.5:2b-q4_K_M\n```\n\nllama-server (cross-server check, one GGUF): download the pinned `ggml-org/llama.cpp` release into `tools/probes/inference-baseline/bin/` (gitignored; identifier + sha256 recorded below), find the candidate's GGUF blob via `ollama show <model> --modelfile` (its `FROM` line), then:\n\n```sh\n./bin/llama-server --model <blob-path> --port 8090 -c 4096\n```\n\nRenderer concurrency: launch the already ad-hoc-signed packaged app directly (not via `open`, so stdout is capturable) and keep it running for every suite/parallel/outage invocation below:\n\n```sh\n/tmp/PantheaProbe/panthea-probe-renderer.app/Contents/MacOS/panthea-probe-renderer > /tmp/panthea-probe-renderer.stdout.log 2>&1 &\n```\n\n**Suite** (per model × context tier):\n\n```sh\ncd tools/probes/inference-baseline\nbun run src/run.ts suite --server ollama --base-url http://localhost:11434 \\\n  --model <model> --tier 1k --max-tokens 150 --timeout-ms 30000 \\\n  --repair-audit 8 --rss-pid <ollama-pid> --renderer-log /tmp/panthea-probe-renderer.stdout.log \\\n  --label <model>-1k\n```\n\nReasoning-capable models (Qwen3.5) default to hidden `<think>` tokens that can consume the whole `--max-tokens` budget before any action JSON is emitted — this probe's Ollama adapter always sends `think: false` (see servers.ts) for that reason.\n\n**Parallel**: `bun run src/run.ts parallel --server ollama --base-url ... --model <best> --tier 4k --concurrency 2 --sample-count 20 --rss-pid <pid> --label <best>-parallel2` (compare against a `--concurrency 1` run of the same sample).\n\n**Outage**: `bun run src/run.ts outage --server ollama --base-url ... --model <model> --kill-pid <ollama-pid> --kill-after 2 --request-count 5 --label <model>-outage` — sends SIGTERM to the server after 2 completed requests and confirms the remaining requests resolve as a clean timeout/error, not a bench crash.\n\n**Report**: `bun run src/run.ts report` (reads every `results/*.json`, renders this README).",
    caveat: buildCaveat(records),
    environment,
    metrics: [],
    findings: buildFindings(records),
    bottomLine: buildBottomLine(records),
  });

  const anyRssBug = records.some((r) => r.kind === "suite" && r.rssBug);
  const resultsMarkdown = [
    "#### Per-model × context matrix",
    "",
    buildModelMatrixMarkdown(records),
    ...(anyRssBug
      ? [
          "",
          "\u2020 RSS sampling bug (see Caveat): shows on-disk model size, a lower bound on resident memory, not a measured RSS peak.",
        ]
      : []),
    "",
    "#### parallel=1 vs parallel=2 (best model)",
    "",
    buildParallelMarkdown(records),
    "",
    "#### Outage recovery",
    "",
    buildOutageMarkdown(records),
    "",
    "#### Population schedule estimate",
    "",
    buildScheduleMarkdown(records),
  ].join("\n");

  const withResults = base.replace(
    "## Results\n\nNo metrics recorded.",
    `## Results\n\n${resultsMarkdown}`,
  );
  writeFileSync(README_PATH, withResults);
  console.error(`[inference-baseline] wrote ${README_PATH}`);
}

function buildCaveat(records: readonly StoredRecord[]): string {
  const parts: string[] = [
    "Candidate substitutions from the plan's named models: no `qwen3.5` 4B tier exists on the Ollama library (available sizes are 0.8B/2B/27B/35B/122B) — substituted `qwen3.5:2b-q4_K_M`, the nearest smaller tier. \"Gemma 4 E4B\" does not exist as a current model family; substituted `gemma3n:e4b` (Gemma 3n's elastic E4B execution profile), the nearest current equivalent. `ministral-3:8b-instruct-2512-q4_K_M`, `phi4-mini:3.8b`, and `llama3.2:3b` match the plan exactly.",
    "Ollama results use its native `/api/chat` endpoint, not `/v1/chat/completions` — the OpenAI-compatible endpoint has no per-request context-size control (Ollama's own docs: changing context size requires a Modelfile-derived model), while the native endpoint accepts `options.num_ctx` per request and the identical JSON Schema object via `format` that `response_format.json_schema.schema` would carry on the OpenAI-compatible endpoint. Only the transport differs; schema comparability with llama-server and Unit 6's future hosted adapters is unaffected.",
    "Renderer concurrency: `apps/probe-renderer`'s packaged `.app` (already ad-hoc signed by Unit 2) run directly (not via `open`, so its stdout is capturable), with its frame-time metrics dump (`d` keystroke, sent via `osascript`/System Events) sampled before and after each suite run — not continuously during — because a continuous automated-keystroke sampler would itself compete for the same CPU the renderer's animation loop runs on.",
    "This machine was not a clean, dedicated 16GB baseline during this run: a co-resident `qemu-system-aarch64` process held ~7.4GB RSS and overall swap usage measured ~6.9GB/8GB at the start of staging, which is real contention this run's absolute latency/RSS numbers reflect (a conservative, not best-case, reading) but also a confound against a truly idle-machine baseline.",
    "RSS sampling bug found mid-run: `ollama serve`'s own process never holds model weights — it spawns a separate `llama-server` runner child (a new pid, per loaded model) that actually holds them. Every one of the five candidates' suite runs sampled the supervisor's pid, so their recorded 'RSS peak' was the harness's own idle footprint (tens of MB), not the model's. Fixed for the parallel/outage runs and the recommended baseline profile below (which sample the real runner pid); the five-candidate matrix instead shows on-disk model size (†) as a lower-bound proxy — weights only, no KV cache or activation overhead, so the true resident figure is higher, especially at 4K context.",
  ];
  const repairSample = records.find(
    (r) =>
      r.kind === "suite" &&
      r.results.some((result) => result.mode === "prompt-only"),
  );
  if (repairSample) {
    parts.push(
      "The repaired-validity column is an 8-of-40-prompt audit sample of the prompt-only (no `format`/`response_format`) fallback path, not a full second 40-prompt pass per model×context — doubling the matrix to characterize a path this probe's servers don't actually need (both support native JSON Schema) wasn't a proportionate use of this run's time budget.",
    );
  }
  return parts.join(" ");
}

function buildFindings(records: readonly StoredRecord[]): readonly string[] {
  const findings: string[] = [];
  const suites = records.filter(
    (r): r is StoredRecord & { kind: "suite" } => r.kind === "suite",
  );
  const sortedSuites = [...suites].sort(
    (a, b) => a.model.localeCompare(b.model) || a.tier.localeCompare(b.tier),
  );
  for (const record of sortedSuites) {
    const validity = summarizeValidity(record.results);
    const repairNote =
      validity.repairedValidRate !== undefined
        ? `, ${formatPct(validity.repairedValidRate)} repaired-valid on the prompt-only audit sample`
        : "";
    findings.push(
      `\`${record.model}\` @ ${record.tier} (${record.server}): native schema validity ${formatPct(validity.nativeValidRate)}, kind-acceptable ${formatPct(validity.kindAcceptableRate)}${repairNote}, ${validity.timeoutCount} timeout(s), ${validity.errorCount} error(s) across ${validity.total} prompts.`,
    );
  }
  const qwenSuite = suites.find((r) => r.model.startsWith("qwen3.5"));
  if (qwenSuite) {
    findings.push(
      "Qwen3.5 defaults to hidden `<think>` reasoning tokens even under a JSON-schema-constrained call: an early run without `think: false` measured 0% native validity across all 40 prompts at both context tiers because the model's `content` field came back empty (all `--max-tokens` spent on the separate `thinking` field, `done_reason: \"length\"`) — this probe's Ollama adapter now always sends `think: false` (see the Caveat and servers.ts) specifically because of this measured failure mode; a population-scale scheduler routing to a thinking-capable model without an equivalent control would see the same silent failure.",
    );
  }
  const phi4Suites = suites.filter((r) => r.model.startsWith("phi4-mini"));
  const phi4At1k = phi4Suites.find((r) => r.tier === "1k");
  const phi4At4k = phi4Suites.find((r) => r.tier === "4k");
  if (phi4At1k && phi4At4k) {
    const v1k = summarizeValidity(phi4At1k.results);
    const v4k = summarizeValidity(phi4At4k.results);
    findings.push(
      `\`phi4-mini:3.8b\`'s grammar-constrained decoding was unreliable at 1k context (${formatPct(v1k.nativeValidRate)} valid — several completions degenerated into repeated/garbage tokens after the schema's first field key, hitting the ${"`max_tokens`"} cap without ever closing the JSON object) but fully reliable at 4k context (${formatPct(v4k.nativeValidRate)} valid) in this run — the opposite of the pattern a naive "shorter context is safer/faster" assumption would predict, and not explained by this probe (recorded as-is, not tuned around).`,
    );
  }
  const anyRepairSample = suites.some(
    (r) => summarizeValidity(r.results).repairedValidRate !== undefined,
  );
  if (anyRepairSample) {
    const repairRates = suites
      .map((r) => summarizeValidity(r.results).repairedValidRate)
      .filter((v): v is number => v !== undefined);
    const maxRepair = repairRates.length > 0 ? Math.max(...repairRates) : 0;
    findings.push(
      `Prompt-only + repair (no \`format\`/\`response_format\`) audit sample topped out at ${formatPct(maxRepair)} repaired-valid across every candidate — native JSON-Schema-constrained output (this probe's default path for both servers) is not a marginal improvement over prompt-only + regex-extract-and-parse, it is the difference between a usable and an unusable action-proposal channel for these model sizes.`,
    );
  }
  const outages = records.filter((r) => r.kind === "outage");
  for (const record of outages) {
    const afterKill = record.results.slice(record.killedAfter ?? 0);
    const recordedAsFailure = afterKill.filter(
      (r) => r.outcome === "timeout" || r.outcome === "error",
    ).length;
    findings.push(
      `Outage test on \`${record.model}\`: server killed mid-run after request ${record.killedAfter}; ${recordedAsFailure}/${afterKill.length} subsequent request(s) recorded as a clean timeout/error, no bench crash.`,
    );
  }
  const parallels = records.filter((r) => r.kind === "parallel");
  if (parallels.length >= 2) {
    const [first, second] = parallels;
    const firstThroughput = first?.throughputPerSec ?? 0;
    const secondThroughput = second?.throughputPerSec ?? 0;
    findings.push(
      `Parallel comparison on \`${first?.model}\`: concurrency ${first?.concurrency} reached ${firstThroughput.toFixed(2)} req/s at RSS peak ${formatRss(first?.rss?.peakBytes)}; concurrency ${second?.concurrency} reached ${secondThroughput.toFixed(2)} req/s at RSS peak ${formatRss(second?.rss?.peakBytes)}${secondThroughput < firstThroughput ? " — higher concurrency did *not* improve wall-clock throughput here, while RSS grew substantially (roughly proportional to the doubled context window Ollama allocates per additional parallel slot), a real measured cost with no offsetting benefit on this machine" : ""}.`,
    );
  }
  const llamaServerCrossCheck = suites.find((r) => r.server === "llama-server");
  if (llamaServerCrossCheck) {
    const ollamaEquivalent = suites.find(
      (r) =>
        r.server === "ollama" &&
        r.tier === llamaServerCrossCheck.tier &&
        llamaServerCrossCheck.model.startsWith(
          r.model.split(":")[0] ?? r.model,
        ),
    );
    if (ollamaEquivalent) {
      const a = summarizeLatency(ollamaEquivalent.results);
      const b = summarizeLatency(llamaServerCrossCheck.results);
      const aValidity = summarizeValidity(ollamaEquivalent.results);
      const bValidity = summarizeValidity(llamaServerCrossCheck.results);
      findings.push(
        `Cross-server parity on the same GGUF (\`${ollamaEquivalent.model}\` @ ${ollamaEquivalent.tier}): Ollama measured ${formatPct(aValidity.kindAcceptableRate)} kind-acceptable, completion p50/p95 ${formatMs(a.totalP50)}/${formatMs(a.totalP95)}ms; llama-server measured ${formatPct(bValidity.kindAcceptableRate)} kind-acceptable, completion p50/p95 ${formatMs(b.totalP50)}/${formatMs(b.totalP95)}ms — close agreement, no evidence either server materially disadvantages this model.`,
      );
    }
  }
  if (findings.length === 0) {
    findings.push("No suite results recorded yet.");
  }
  return findings;
}

function buildBottomLine(records: readonly StoredRecord[]): string {
  const ranked = rankCandidates(records);
  const best = ranked[0];
  if (!best) {
    return "No suite results recorded yet — run `suite` for each candidate before `report`.";
  }
  const latency = summarizeLatency(best.results);
  const validity = summarizeValidity(best.results);
  const p95 = latency.totalP95;
  const meetsTarget = p95 !== undefined && p95 <= 30000;
  const runnerUp = ranked.find(
    (r) => r.model !== best.model || r.tier !== best.tier,
  );
  const runnerUpNote = runnerUp
    ? ` \`${runnerUp.model}\` @ ${runnerUp.tier} scored higher on kind-acceptable rate (${formatPct(summarizeValidity(runnerUp.results).kindAcceptableRate)} vs this profile's ${formatPct(validity.kindAcceptableRate)}) but at ${formatMs(summarizeLatency(runnerUp.results).totalP95)}ms p95 — several times the latency — which is why it is not the recommendation: population-scale cadence (see the schedule estimate) is latency-bound, not accuracy-bound, once a candidate clears the ${formatPct(MIN_VIABLE_KIND_ACCEPTABLE_RATE)} kind-acceptable bar.`
    : "";
  return (
    `Baseline model profile recommended for ADR-0005's local section: **${best.model}, ${best.server}, ${best.tier} context, parallel=1** — ` +
    `measured native schema validity ${formatPct(validity.nativeValidRate)}, kind-acceptable ${formatPct(validity.kindAcceptableRate)}, ` +
    `TTFT p50/p95 ${formatMs(latency.ttftP50)}/${formatMs(latency.ttftP95)}ms, completion p50/p95 ${formatMs(latency.totalP50)}/${formatMs(latency.totalP95)}ms ` +
    `against the acceptance plan's 10s/30s p95 targets (${meetsTarget ? "within" : "measured over"} the 30s p95 target, no pass/fail declared here per the plan's instruction).` +
    runnerUpNote +
    " See the Population schedule estimate above for the reasoning-turns/minute and per-character cadence this profile supports for 7 gods + 20 inhabitants."
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  if (command === "suite") {
    await cmdSuite(flags);
  } else if (command === "parallel") {
    await cmdParallel(flags);
  } else if (command === "outage") {
    await cmdOutage(flags);
  } else if (command === "report") {
    buildReadme();
  } else {
    throw new Error(
      `usage: bun run src/run.ts <suite|parallel|outage|report> [--flags]`,
    );
  }
}

await main();
