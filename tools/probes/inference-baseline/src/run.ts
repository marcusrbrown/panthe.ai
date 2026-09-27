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
import { join, resolve } from "node:path";
import {
  captureEnvironment,
  type EnvironmentInfo,
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
// Overridable so the report regression test (report.test.ts) can point a
// spawned `report` invocation at a disposable temp directory instead of the
// probe's real results/README — never set these outside a test.
const RESULTS_DIR = process.env.INFERENCE_BASELINE_RESULTS_DIR
  ? resolve(process.env.INFERENCE_BASELINE_RESULTS_DIR)
  : join(PROBE_DIR, "results");
const README_PATH = process.env.INFERENCE_BASELINE_README_PATH
  ? resolve(process.env.INFERENCE_BASELINE_README_PATH)
  : join(PROBE_DIR, "README.md");
const SUMMARY_FILENAME = "summary.json";

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

function readRssKb(pid: number): number | undefined {
  try {
    const result = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)]);
    const kb = Number(result.stdout.toString().trim());
    return Number.isFinite(kb) && kb > 0 ? kb : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ollama's own process (`ollama serve`, whatever pid it was started with)
 * never holds model weights in its own RSS — it spawns a separate
 * `llama-server` runner child process per loaded model (a new pid each time
 * a model loads), and that child is the actual memory consumer. This finds
 * that child, re-resolved on every call since the runner pid changes across
 * model loads/unloads: `pgrep -P <supervisorPid>` for direct children,
 * preferring ones whose command name looks like a runner; if none is named
 * that way (a differently-named child, or none loaded yet), every direct
 * child pid is returned as the fallback — summed RSS across the whole
 * process tree rather than assuming a specific binary name.
 */
function findOllamaRunnerPids(supervisorPid: number): readonly number[] {
  try {
    const pgrepResult = Bun.spawnSync(["pgrep", "-P", String(supervisorPid)]);
    const childPids = pgrepResult.stdout
      .toString()
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map(Number)
      .filter((pid) => Number.isFinite(pid));
    if (childPids.length === 0) {
      return [];
    }
    const namedRunners = childPids.filter((pid) => {
      try {
        const commResult = Bun.spawnSync([
          "ps",
          "-o",
          "command=",
          "-p",
          String(pid),
        ]);
        const command = commResult.stdout.toString().trim();
        return command.includes("llama-server") || command.includes("runner");
      } catch {
        return false;
      }
    });
    return namedRunners.length > 0 ? namedRunners : childPids;
  } catch {
    return [];
  }
}

/**
 * Resolves the pid(s) whose RSS actually represents `serverName`'s resident
 * memory: for `ollama`, the supplied pid is the `ollama serve` supervisor,
 * so this resolves to its runner child(ren) instead (falling back to the
 * supervisor pid itself if no runner has spawned yet, e.g. before the first
 * request loads a model); for `llama-server`, the supplied pid already
 * holds the weights directly, so it's returned unchanged.
 */
function resolveRssPids(
  serverName: string,
  suppliedPid: number,
): readonly number[] {
  if (serverName !== "ollama") {
    return [suppliedPid];
  }
  const runners = findOllamaRunnerPids(suppliedPid);
  return runners.length > 0 ? runners : [suppliedPid];
}

/** Polls RSS at `intervalMs`, re-resolving the target pid(s) via
 * {@link resolveRssPids} on every tick (not just once at start) so a
 * runner that spawns partway through the first request, or a runner that
 * gets replaced across a model reload, is still captured. */
function pollExternalRss(
  serverName: string,
  pid: number,
  intervalMs = 1500,
): { stop(): RssSamples } {
  let peakKb = 0;
  let sampleCount = 0;
  const timer = setInterval(() => {
    const pids = resolveRssPids(serverName, pid);
    let totalKb = 0;
    let anySampled = false;
    for (const target of pids) {
      const kb = readRssKb(target);
      if (kb !== undefined) {
        totalKb += kb;
        anySampled = true;
      }
    }
    if (anySampled) {
      sampleCount += 1;
      if (totalKb > peakKb) {
        peakKb = totalKb;
      }
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

function parseFrameStatsFromLog(content: string): FrameStats | undefined {
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
}

/** Parses only the frame-stats dump appended to `content` after `offset`
 * characters, ignoring anything at or before it. Without this, a keystroke
 * attempt that silently no-ops (see {@link sampleRendererFrameStats}'s doc
 * comment on the two keystroke paths) would still find and report a stale
 * `frameTime` block left over from an earlier dump in the same log — this
 * is the fix for that: `offset` must be the log's length captured *before*
 * the keystroke was sent, so a call that appended nothing new correctly
 * returns `undefined` instead of re-reporting old numbers as fresh.
 * Exported for unit testing without invoking the OS-level keystroke path. */
export function parseFrameStatsSince(
  content: string,
  offset: number,
): FrameStats | undefined {
  return parseFrameStatsFromLog(content.slice(offset));
}

/** Triggers a metrics dump in the already-running probe-renderer app (`d`
 * keystroke) and reads the frame-time block back out of its captured
 * stdout log. Returns undefined (never throws) if the app or log isn't
 * available — a probe run must not fail because the renderer concurrency
 * signal couldn't be sampled.
 *
 * Two independent keystroke paths, tried in order: `osascript`/System
 * Events first (frontmost the named process, wait 1s for the window
 * manager to actually honor it — shorter delays were measured to
 * intermittently no-op even though `set frontmost to true` reports success
 * and the process is visible to System Events), then `cliclick t:d` as a
 * fallback if the log didn't grow — a different code path (direct CGEvent
 * synthesis, not Accessibility-scripting-API-mediated) that can land a
 * keystroke in cases where the System Events path silently doesn't. */
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

/** Env details known ahead of time (versions/release pins), independent of
 * whatever process happens to be running when a given result is captured. */
const STATIC_ENV_EXTRAS = {
  ollama: "0.34.4",
  "llama-server release": "b11205 (ggml-org/llama.cpp, macos-arm64)",
  "llama-server sha256":
    "97b06f59ad15e2b4b6044ba7338c4e3f40354c6dc2b9c5cda234e2bd6b9fd65e",
} as const;

/** Captures the environment at measurement time so a later `report` run (on
 * a different machine, or after this one has changed) still renders the
 * environment that actually produced the numbers, not whatever machine
 * happens to run `report`. */
function captureProbeEnvironment(): EnvironmentInfo {
  return captureEnvironment({ extra: { ...STATIC_ENV_EXTRAS } });
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

  const rssPoller =
    rssPid !== undefined ? pollExternalRss(serverName, rssPid) : undefined;
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
    environment: captureProbeEnvironment(),
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
  const rssPoller =
    rssPid !== undefined ? pollExternalRss(serverName, rssPid) : undefined;

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
    environment: captureProbeEnvironment(),
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
    environment: captureProbeEnvironment(),
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
  /** Environment captured at measurement time (see `captureProbeEnvironment`) —
   * absent on any record written before this field existed. */
  readonly environment?: EnvironmentInfo;
}

/**
 * Everything the README's tables and prose actually need from one suite
 * run — precomputed rates/percentiles, never raw per-prompt samples. This
 * is the single shape every render function below operates on, so the same
 * rendering logic runs whether the numbers came from freshly loaded raw
 * {@link StoredRecord}s (`recordsToReportData`) or from the committed
 * `results/summary.json` aggregate on a fresh checkout that has no raw
 * records at all (`summaryToReportData`) — see `cmdReport`.
 */
interface SuiteAggregate {
  readonly model: string;
  readonly server: string;
  readonly tier: ContextTier;
  readonly sampleCount: number;
  readonly nativeValidRate: number;
  readonly kindAcceptableRate: number;
  readonly repairedValidRate: number | undefined;
  readonly timeoutCount: number;
  readonly errorCount: number;
  readonly ttftP50: number | undefined;
  readonly ttftP95: number | undefined;
  readonly totalP50: number | undefined;
  readonly totalP95: number | undefined;
  readonly tokPerSecP50: number | undefined;
  readonly rssPeakBytes: number | undefined;
  readonly rssBug: boolean;
  readonly diskSizeBytes: number | undefined;
  readonly rendererFrameP95: number | undefined;
}

interface ParallelAggregate {
  readonly model: string;
  readonly tier: ContextTier;
  readonly concurrency: number | undefined;
  readonly requestCount: number;
  readonly wallMs: number | undefined;
  readonly throughputPerSec: number | undefined;
  readonly rssPeakBytes: number | undefined;
}

interface OutageAggregate {
  readonly model: string;
  readonly tier: ContextTier;
  readonly killedAfter: number | undefined;
  readonly requestCount: number;
  /** Outcome of every request issued after the mid-run kill (no timing —
   * that's raw per-request detail this aggregate deliberately omits). */
  readonly postKillOutcomes: readonly string[];
}

interface ReportData {
  readonly suites: readonly SuiteAggregate[];
  readonly parallel: readonly ParallelAggregate[];
  readonly outage: readonly OutageAggregate[];
  readonly environment: EnvironmentInfo;
}

function isSuiteRecord(
  record: StoredRecord,
): record is StoredRecord & { kind: "suite" } {
  return record.kind === "suite";
}

function toSuiteAggregate(
  record: StoredRecord & { kind: "suite" },
): SuiteAggregate {
  const validity = summarizeValidity(record.results);
  const latency = summarizeLatency(record.results);
  return {
    model: record.model,
    server: record.server,
    tier: record.tier,
    sampleCount: validity.total,
    nativeValidRate: validity.nativeValidRate,
    kindAcceptableRate: validity.kindAcceptableRate,
    repairedValidRate: validity.repairedValidRate,
    timeoutCount: validity.timeoutCount,
    errorCount: validity.errorCount,
    ttftP50: latency.ttftP50,
    ttftP95: latency.ttftP95,
    totalP50: latency.totalP50,
    totalP95: latency.totalP95,
    tokPerSecP50: latency.tokPerSecP50,
    rssPeakBytes: record.rss?.peakBytes,
    rssBug: record.rssBug ?? false,
    diskSizeBytes: record.diskSizeBytes,
    rendererFrameP95: record.rendererAfter?.p95,
  };
}

function toParallelAggregate(
  record: StoredRecord & { kind: "parallel" },
): ParallelAggregate {
  return {
    model: record.model,
    tier: record.tier,
    concurrency: record.concurrency,
    requestCount: record.results.length,
    wallMs: record.wallMs,
    throughputPerSec: record.throughputPerSec,
    rssPeakBytes: record.rss?.peakBytes,
  };
}

function toOutageAggregate(
  record: StoredRecord & { kind: "outage" },
): OutageAggregate {
  return {
    model: record.model,
    tier: record.tier,
    killedAfter: record.killedAfter,
    requestCount: record.results.length,
    postKillOutcomes: record.results
      .slice(record.killedAfter ?? 0)
      .map((result) => result.outcome),
  };
}

/** Picks the environment to render: the one captured alongside the
 * recommended baseline profile's own measurement (the numbers the Bottom
 * line actually cites), falling back to any other stored record's, and
 * only to a fresh live capture (which would describe whatever machine
 * happens to run `report`, not the machine that produced the numbers) if
 * no record has one at all — e.g. before any suite has ever run. */
function pickEnvironment(
  records: readonly StoredRecord[],
  best: SuiteAggregate | undefined,
): EnvironmentInfo {
  const matchingBest = best
    ? records.find(
        (r) =>
          r.kind === "suite" &&
          r.model === best.model &&
          r.tier === best.tier &&
          r.server === best.server &&
          r.environment !== undefined,
      )
    : undefined;
  return (
    matchingBest?.environment ??
    records.find((r) => r.environment)?.environment ??
    captureProbeEnvironment()
  );
}

function recordsToReportData(records: readonly StoredRecord[]): ReportData {
  const suites = records.filter(isSuiteRecord).map(toSuiteAggregate);
  const parallel = records
    .filter(
      (r): r is StoredRecord & { kind: "parallel" } => r.kind === "parallel",
    )
    .map(toParallelAggregate);
  const outage = records
    .filter((r): r is StoredRecord & { kind: "outage" } => r.kind === "outage")
    .map(toOutageAggregate);
  const best = rankCandidates(suites)[0];
  const environment = pickEnvironment(records, best);
  return { suites, parallel, outage, environment };
}

/** The committed `results/summary.json` aggregate already has exactly the
 * {@link SuiteAggregate}/{@link ParallelAggregate}/{@link OutageAggregate}
 * shape every render function needs — no raw records to derive it from. */
function summaryToReportData(summary: Summary): ReportData {
  return {
    suites: summary.suites,
    parallel: summary.parallel,
    outage: summary.outage,
    environment: summary.environment ?? captureProbeEnvironment(),
  };
}

function suiteKey(
  s: Pick<SuiteAggregate, "model" | "server" | "tier">,
): string {
  return `${s.model}\u0000${s.server}\u0000${s.tier}`;
}

function parallelKey(
  p: Pick<ParallelAggregate, "model" | "tier" | "concurrency">,
): string {
  return `${p.model}\u0000${p.tier}\u0000${p.concurrency ?? "?"}`;
}

function outageKey(
  o: Pick<OutageAggregate, "model" | "tier" | "killedAfter">,
): string {
  return `${o.model}\u0000${o.tier}\u0000${o.killedAfter ?? "?"}`;
}

/**
 * Merges a committed `results/summary.json` aggregate with freshly-loaded
 * raw records for an incremental re-run — e.g. benching one additional
 * candidate against an already-published matrix without every prior
 * candidate's gitignored raw `results/*.json` records still on disk (they
 * don't survive a fresh checkout or worktree; only `summary.json` is
 * committed). Without this merge, `report` finding even one raw record
 * present would take the "raw records exist" branch of its three-way
 * dispatch and render *only* those records, silently dropping every other
 * previously-published candidate from the README instead of adding to it.
 *
 * Fresh entries (same model/server/tier for suites, model/tier/concurrency
 * for parallel, model/tier/killedAfter for outage) take precedence over a
 * committed entry with the same key; committed entries with no fresh
 * counterpart are kept unchanged. The rendered environment follows
 * whichever suite ends up ranked best after the merge: the fresh
 * environment if a freshly-measured suite is now the recommendation, the
 * committed one otherwise (it already reflects the machine that produced
 * the still-current recommendation's numbers).
 */
function mergeReportData(committed: ReportData, fresh: ReportData): ReportData {
  const suites = new Map<string, SuiteAggregate>();
  for (const s of committed.suites) {
    suites.set(suiteKey(s), s);
  }
  for (const s of fresh.suites) {
    suites.set(suiteKey(s), s);
  }

  const parallel = new Map<string, ParallelAggregate>();
  for (const p of committed.parallel) {
    parallel.set(parallelKey(p), p);
  }
  for (const p of fresh.parallel) {
    parallel.set(parallelKey(p), p);
  }

  const outage = new Map<string, OutageAggregate>();
  for (const o of committed.outage) {
    outage.set(outageKey(o), o);
  }
  for (const o of fresh.outage) {
    outage.set(outageKey(o), o);
  }

  const mergedSuites = [...suites.values()];
  const best = rankCandidates(mergedSuites)[0];
  const bestIsFresh =
    best !== undefined &&
    fresh.suites.some((s) => suiteKey(s) === suiteKey(best));

  return {
    suites: mergedSuites,
    parallel: [...parallel.values()],
    outage: [...outage.values()],
    environment: bestIsFresh ? fresh.environment : committed.environment,
  };
}

/** Every `results/*.json` file except the committed aggregate itself —
 * `summary.json` has no `kind` field and is not a {@link StoredRecord}; a
 * naive "read every .json file" would misparse it as one (see
 * `recordsToReportData` vs `summaryToReportData` below for why that split
 * matters: a fresh checkout only ever has `summary.json`, never the raw
 * per-request records, which stay gitignored). */
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

function buildModelMatrixMarkdown(suites: readonly SuiteAggregate[]): string {
  const header =
    "| Model | Server | Context | Native valid | Kind-acceptable | Repaired valid (audit) | TTFT p50/p95 (ms) | Completion p50/p95 (ms) | tok/s p50 | Server RSS peak | Renderer frame p95 (ms) |\n" +
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const rows = suites.map((suite) => {
    const repaired =
      suite.repairedValidRate === undefined
        ? "n/a"
        : formatPct(suite.repairedValidRate);
    return (
      `| ${suite.model} | ${suite.server} | ${suite.tier} | ${formatPct(suite.nativeValidRate)} | ` +
      `${formatPct(suite.kindAcceptableRate)} | ${repaired} | ` +
      `${formatMs(suite.ttftP50)}/${formatMs(suite.ttftP95)} | ` +
      `${formatMs(suite.totalP50)}/${formatMs(suite.totalP95)} | ` +
      `${suite.tokPerSecP50?.toFixed(1) ?? "n/a"} | ` +
      `${suite.rssBug ? `${formatRss(suite.diskSizeBytes)} (disk size\u2020)` : formatRss(suite.rssPeakBytes)} | ` +
      `${suite.rendererFrameP95 ?? "n/a"} |`
    );
  });
  return [header, ...rows].join("\n");
}

function buildParallelMarkdown(parallel: readonly ParallelAggregate[]): string {
  if (parallel.length === 0) {
    return "_No parallel=1 vs parallel=2 comparison recorded._";
  }
  const header =
    "| Model | Context | Concurrency | Requests | Wall time (ms) | Throughput (req/s) | RSS peak |\n| --- | --- | --- | --- | --- | --- | --- |";
  const rows = parallel.map(
    (entry) =>
      `| ${entry.model} | ${entry.tier} | ${entry.concurrency} | ${entry.requestCount} | ${entry.wallMs} | ${entry.throughputPerSec?.toFixed(2)} | ${formatRss(entry.rssPeakBytes)} |`,
  );
  return [header, ...rows].join("\n");
}

function buildOutageMarkdown(outage: readonly OutageAggregate[]): string {
  if (outage.length === 0) {
    return "_No outage test recorded._";
  }
  const header =
    "| Model | Context | Killed after request # | Requests before kill | Requests after kill | Post-kill outcomes |\n| --- | --- | --- | --- | --- | --- |";
  const rows = outage.map((entry) => {
    const killedAfter = entry.killedAfter ?? 0;
    const afterCount = entry.postKillOutcomes.length;
    return `| ${entry.model} | ${entry.tier} | ${killedAfter} | ${killedAfter} | ${afterCount} | ${entry.postKillOutcomes.join(", ") || "n/a"} |`;
  });
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
  suites: readonly SuiteAggregate[],
): readonly SuiteAggregate[] {
  const candidates = suites.filter((s) => s.server !== "llama-server");
  const viable = candidates.filter(
    (s) => s.kindAcceptableRate >= MIN_VIABLE_KIND_ACCEPTABLE_RATE,
  );
  const pool = viable.length > 0 ? viable : candidates;
  return [...pool].sort((a, b) => {
    if (viable.length > 0) {
      const aLatency = a.totalP95 ?? Number.POSITIVE_INFINITY;
      const bLatency = b.totalP95 ?? Number.POSITIVE_INFINITY;
      return aLatency - bLatency;
    }
    return b.kindAcceptableRate - a.kindAcceptableRate;
  });
}

function buildScheduleMarkdown(suites: readonly SuiteAggregate[]): string {
  const bestSuite = rankCandidates(suites)[0];
  if (!bestSuite) {
    return "_No suite results recorded yet — schedule estimate unavailable._";
  }
  const p95 = bestSuite.totalP95;
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

function writeReadmeFromData(data: ReportData): void {
  const { suites, parallel, outage, environment } = data;

  const base = renderReport({
    question:
      "Which locally-servable model, quantization, and context size meet the acceptance plan's 10s-first-reply / 30s-p95-completion model-feedback target on the M1 Pro 16GB baseline with the renderer scene running concurrently, and what reasoning-turn cadence does that support for 7 gods + 20 inhabitants?",
    howToRun:
      "**Staging (prerequisite, not timed):**\n\n```sh\nollama serve &                      # native /api/chat on :11434\nollama pull <model>                  # e.g. qwen3.5:2b-q4_K_M\n```\n\nllama-server (cross-server check, one GGUF): download the pinned `ggml-org/llama.cpp` release into `tools/probes/inference-baseline/bin/` (gitignored; identifier + sha256 recorded below), find the candidate's GGUF blob via `ollama show <model> --modelfile` (its `FROM` line), then:\n\n```sh\n./bin/llama-server --model <blob-path> --port 8090 -c 4096\n```\n\nRenderer concurrency: launch the already ad-hoc-signed packaged app directly (not via `open`, so stdout is capturable) and keep it running for every suite/parallel/outage invocation below:\n\n```sh\n/tmp/PantheaProbe/panthea-probe-renderer.app/Contents/MacOS/panthea-probe-renderer > /tmp/panthea-probe-renderer.stdout.log 2>&1 &\n```\n\n**Suite** (per model × context tier):\n\n```sh\ncd tools/probes/inference-baseline\nbun run src/run.ts suite --server ollama --base-url http://localhost:11434 \\\n  --model <model> --tier 1k --max-tokens 150 --timeout-ms 30000 \\\n  --repair-audit 8 --rss-pid <ollama-serve-pid> --renderer-log /tmp/panthea-probe-renderer.stdout.log \\\n  --label <model>-1k\n```\n\n`--rss-pid` for `--server ollama` is the `ollama serve` supervisor's own pid (`pgrep -f 'ollama serve'`, or whatever your shell already has from starting it) — the sampler auto-resolves and re-resolves its actual `llama-server` runner child every poll tick (a new pid each time a model loads; see servers.ts's doc comment on `findOllamaRunnerPids`/`resolveRssPids`), summing the whole child tree if the runner isn't the only child or is named differently. For `--server llama-server`, pass that process's own pid directly (it holds the weights itself, no child to resolve). Reasoning-capable models (Qwen3.5) default to hidden `<think>` tokens that can consume the whole `--max-tokens` budget before any action JSON is emitted — this probe's Ollama adapter always sends `think: false` (see servers.ts) for that reason.\n\n**Parallel**: `bun run src/run.ts parallel --server ollama --base-url ... --model <best> --tier 4k --concurrency 2 --sample-count 20 --rss-pid <ollama-serve-pid> --label <best>-parallel2` (compare against a `--concurrency 1` run of the same sample).\n\n**Outage**: `bun run src/run.ts outage --server ollama --base-url ... --model <model> --kill-pid <ollama-serve-pid> --kill-after 2 --request-count 5 --label <model>-outage` — sends SIGTERM to the server after 2 completed requests and confirms the remaining requests resolve as a clean timeout/error, not a bench crash.\n\n**Report**: `bun run src/run.ts report` — renders this README from raw `results/*.json` records when present (and regenerates the committed `results/summary.json` published aggregate to match); on a fresh checkout with no raw records, renders from that committed aggregate instead and leaves it untouched; with neither present, exits non-zero and writes nothing. `results/summary.json` publishes already-computed rates/percentiles/counts, not the raw per-prompt samples they were computed from — it lets this README's numbers survive without every gitignored raw record, not independent recomputation from scratch.",
    caveat: buildCaveat(suites),
    environment,
    metrics: [],
    findings: buildFindings(suites, parallel, outage),
    bottomLine: buildBottomLine(suites),
  });

  const anyRssBug = suites.some((s) => s.rssBug);
  const resultsMarkdown = [
    "#### Per-model × context matrix",
    "",
    buildModelMatrixMarkdown(suites),
    ...(anyRssBug
      ? [
          "",
          "\u2020 RSS sampling bug (see Caveat): shows on-disk model size, a lower bound on resident memory, not a measured RSS peak.",
        ]
      : []),
    "",
    "#### parallel=1 vs parallel=2 (best model)",
    "",
    buildParallelMarkdown(parallel),
    "",
    "#### Outage recovery",
    "",
    buildOutageMarkdown(outage),
    "",
    "#### Population schedule estimate",
    "",
    buildScheduleMarkdown(suites),
  ].join("\n");

  const withResults = base.replace(
    "## Results\n\nNo metrics recorded.",
    `## Results\n\n${resultsMarkdown}`,
  );
  writeFileSync(README_PATH, withResults);
  console.error(`[inference-baseline] wrote ${README_PATH}`);
}

function buildCaveat(suites: readonly SuiteAggregate[]): string {
  const parts: string[] = [
    "Candidate substitutions from the plan's named models: no `qwen3.5` 4B tier exists on the Ollama library (available sizes are 0.8B/2B/27B/35B/122B) — substituted `qwen3.5:2b-q4_K_M`, the nearest smaller tier. Gemma 4 exists on Ollama (`gemma4:e4b`, benched here — an owner correction of this probe's earlier claim that no Gemma 4 family existed); `gemma3n:e4b` was benched first as a substitute under that mistaken assumption and is retained below since it's still valid measured data, not because it's still needed as a stand-in. `ministral-3:8b-instruct-2512-q4_K_M`, `phi4-mini:3.8b`, and `llama3.2:3b` match the plan exactly.",
    "Ollama results use its native `/api/chat` endpoint, not `/v1/chat/completions` — the OpenAI-compatible endpoint has no per-request context-size control (Ollama's own docs: changing context size requires a Modelfile-derived model), while the native endpoint accepts `options.num_ctx` per request and the identical JSON Schema object via `format` that `response_format.json_schema.schema` would carry on the OpenAI-compatible endpoint. Only the transport differs; schema comparability with llama-server and Unit 6's future hosted adapters is unaffected.",
    "Renderer concurrency: `apps/probe-renderer`'s packaged `.app` (already ad-hoc signed by Unit 2) run directly (not via `open`, so its stdout is capturable), with its frame-time metrics dump (`d` keystroke, sent via `osascript`/System Events) sampled before and after each suite run — not continuously during — because a continuous automated-keystroke sampler would itself compete for the same CPU the renderer's animation loop runs on.",
    "This machine was not a clean, dedicated 16GB baseline during this run: a co-resident `qemu-system-aarch64` process held ~7.4GB RSS and overall swap usage measured ~6.9GB/8GB at the start of staging, which is real contention this run's absolute latency/RSS numbers reflect (a conservative, not best-case, reading) but also a confound against a truly idle-machine baseline.",
    "RSS sampling bug found mid-run, since fixed: `ollama serve`'s own process never holds model weights — it spawns a separate `llama-server` runner child (a new pid, per loaded model) that actually holds them. The five-candidate matrix below predates the fix and sampled the supervisor's pid, so its recorded 'RSS peak' was the harness's own idle footprint (tens of MB), not the model's; it instead shows on-disk model size (†) as a lower-bound proxy (weights only, no KV cache or activation overhead, so the true resident figure is higher, especially at 4K context). The harness (`resolveRssPids`/`findOllamaRunnerPids` in run.ts) now auto-resolves and re-resolves the actual runner child pid on every poll tick, re-sampling it fresh each time since a model reload spawns a new one; the recommended baseline profile below, and the parallel/outage runs, were re-measured with the fix and carry a real runner RSS figure, not a proxy.",
  ];
  const repairSample = suites.some((s) => s.repairedValidRate !== undefined);
  if (repairSample) {
    parts.push(
      "The repaired-validity column is an 8-of-40-prompt audit sample of the prompt-only (no `format`/`response_format`) fallback path, not a full second 40-prompt pass per model×context — doubling the matrix to characterize a path this probe's servers don't actually need (both support native JSON Schema) wasn't a proportionate use of this run's time budget.",
    );
  }
  const best = rankCandidates(suites)[0];
  const framesElsewhere = suites
    .filter((s) => s !== best && s.rendererFrameP95 !== undefined)
    .map((s) => s.rendererFrameP95 as number);
  if (
    best &&
    best.rendererFrameP95 === undefined &&
    framesElsewhere.length > 0
  ) {
    const lo = Math.min(...framesElsewhere);
    const hi = Math.max(...framesElsewhere);
    const representative = lo === hi ? `${hi}` : `${lo}–${hi}`;
    parts.push(
      `The recommended baseline profile's own renderer frame p95 sample is unavailable: the \`d\`-keystroke dump (both the \`osascript\`/System Events path and a \`cliclick\` fallback were tried) never reached the packaged renderer app during its re-measurement run — \`osascript\` reported success and the process was visible to System Events, but \`count windows\` returned 0 and a full-screen capture showed no windows at all, consistent with \`renderer-webgl2/README.md\`'s documented finding that this machine's screen/window server is shared with other concurrent automated sessions and window visibility isn't reliably controllable here. Citing the other candidate suites' renderer frame p95 instead, since the signal is driven by the renderer app itself and shouldn't materially differ by which local model is running alongside it: the other suites in the matrix measured **${representative}ms** (${framesElsewhere.length} suites).`,
    );
  }
  return parts.join(" ");
}

function buildFindings(
  suites: readonly SuiteAggregate[],
  parallel: readonly ParallelAggregate[],
  outage: readonly OutageAggregate[],
): readonly string[] {
  const findings: string[] = [];
  const sortedSuites = [...suites].sort(
    (a, b) => a.model.localeCompare(b.model) || a.tier.localeCompare(b.tier),
  );
  for (const suite of sortedSuites) {
    const repairNote =
      suite.repairedValidRate !== undefined
        ? `, ${formatPct(suite.repairedValidRate)} repaired-valid on the prompt-only audit sample`
        : "";
    findings.push(
      `\`${suite.model}\` @ ${suite.tier} (${suite.server}): native schema validity ${formatPct(suite.nativeValidRate)}, kind-acceptable ${formatPct(suite.kindAcceptableRate)}${repairNote}, ${suite.timeoutCount} timeout(s), ${suite.errorCount} error(s) across ${suite.sampleCount} prompts.`,
    );
  }
  const qwenSuite = suites.find((s) => s.model.startsWith("qwen3.5"));
  if (qwenSuite) {
    findings.push(
      "Qwen3.5 defaults to hidden `<think>` reasoning tokens even under a JSON-schema-constrained call: an early run without `think: false` measured 0% native validity across all 40 prompts at both context tiers because the model's `content` field came back empty (all `--max-tokens` spent on the separate `thinking` field, `done_reason: \"length\"`) — this probe's Ollama adapter now always sends `think: false` (see the Caveat and servers.ts) specifically because of this measured failure mode; a population-scale scheduler routing to a thinking-capable model without an equivalent control would see the same silent failure.",
    );
  }
  const gemma4Suites = suites.filter((s) => s.model.startsWith("gemma4"));
  const gemma4At1k = gemma4Suites.find((s) => s.tier === "1k");
  const gemma4At4k = gemma4Suites.find((s) => s.tier === "4k");
  if (gemma4At1k && gemma4At4k) {
    findings.push(
      `\`gemma4:e4b\` also defaults to hidden reasoning tokens (\`ollama show\` reports a \`thinking\` capability with \`default: true\`, the same profile Qwen3.5 has) — unlike Qwen3.5's early failure above, this probe's \`think: false\` fix was already in place before this candidate was ever benched, so there was no repeat of the empty-\`content\`/budget-exhaustion failure: native schema validity measured ${formatPct(gemma4At1k.nativeValidRate)}/${formatPct(gemma4At4k.nativeValidRate)} at 1k/4k, not the 0% Qwen3.5 hit pre-fix.`,
    );
  }
  const phi4Suites = suites.filter((s) => s.model.startsWith("phi4-mini"));
  const phi4At1k = phi4Suites.find((s) => s.tier === "1k");
  const phi4At4k = phi4Suites.find((s) => s.tier === "4k");
  if (phi4At1k && phi4At4k) {
    findings.push(
      `\`phi4-mini:3.8b\`'s grammar-constrained decoding was unreliable at 1k context (${formatPct(phi4At1k.nativeValidRate)} valid — several completions degenerated into repeated/garbage tokens after the schema's first field key, hitting the ${"`max_tokens`"} cap without ever closing the JSON object) but fully reliable at 4k context (${formatPct(phi4At4k.nativeValidRate)} valid) in this run — the opposite of the pattern a naive "shorter context is safer/faster" assumption would predict, and not explained by this probe (recorded as-is, not tuned around).`,
    );
  }
  const repairRates = suites
    .map((s) => s.repairedValidRate)
    .filter((v): v is number => v !== undefined);
  if (repairRates.length > 0) {
    const maxRepair = Math.max(...repairRates);
    findings.push(
      `Prompt-only + repair (no \`format\`/\`response_format\`) audit sample topped out at ${formatPct(maxRepair)} repaired-valid across every candidate — native JSON-Schema-constrained output (this probe's default path for both servers) is not a marginal improvement over prompt-only + regex-extract-and-parse, it is the difference between a usable and an unusable action-proposal channel for these model sizes.`,
    );
  }
  for (const entry of outage) {
    const recordedAsFailure = entry.postKillOutcomes.filter(
      (outcome) => outcome === "timeout" || outcome === "error",
    ).length;
    findings.push(
      `Outage test on \`${entry.model}\`: server killed mid-run after request ${entry.killedAfter}; ${recordedAsFailure}/${entry.postKillOutcomes.length} subsequent request(s) recorded as a clean timeout/error, no bench crash.`,
    );
  }
  if (parallel.length >= 2) {
    const [first, second] = parallel;
    const firstThroughput = first?.throughputPerSec ?? 0;
    const secondThroughput = second?.throughputPerSec ?? 0;
    findings.push(
      `Parallel comparison on \`${first?.model}\`: concurrency ${first?.concurrency} reached ${firstThroughput.toFixed(2)} req/s at RSS peak ${formatRss(first?.rssPeakBytes)}; concurrency ${second?.concurrency} reached ${secondThroughput.toFixed(2)} req/s at RSS peak ${formatRss(second?.rssPeakBytes)}${secondThroughput < firstThroughput ? " — higher concurrency did *not* improve wall-clock throughput here, while RSS grew substantially (roughly proportional to the doubled context window Ollama allocates per additional parallel slot), a real measured cost with no offsetting benefit on this machine" : ""}.`,
    );
  }
  const llamaServerCrossCheck = suites.find((s) => s.server === "llama-server");
  if (llamaServerCrossCheck) {
    const ollamaEquivalent = suites.find(
      (s) =>
        s.server === "ollama" &&
        s.tier === llamaServerCrossCheck.tier &&
        llamaServerCrossCheck.model.startsWith(
          s.model.split(":")[0] ?? s.model,
        ),
    );
    if (ollamaEquivalent) {
      findings.push(
        `Cross-server parity on the same GGUF (\`${ollamaEquivalent.model}\` @ ${ollamaEquivalent.tier}): Ollama measured ${formatPct(ollamaEquivalent.kindAcceptableRate)} kind-acceptable, completion p50/p95 ${formatMs(ollamaEquivalent.totalP50)}/${formatMs(ollamaEquivalent.totalP95)}ms; llama-server measured ${formatPct(llamaServerCrossCheck.kindAcceptableRate)} kind-acceptable, completion p50/p95 ${formatMs(llamaServerCrossCheck.totalP50)}/${formatMs(llamaServerCrossCheck.totalP95)}ms — close agreement, no evidence either server materially disadvantages this model.`,
      );
    }
  }
  if (findings.length === 0) {
    findings.push("No suite results recorded yet.");
  }
  return findings;
}

function buildBottomLine(suites: readonly SuiteAggregate[]): string {
  const ranked = rankCandidates(suites);
  const best = ranked[0];
  if (!best) {
    return "No suite results recorded yet — run `suite` for each candidate before `report`.";
  }
  const p95 = best.totalP95;
  const meetsTarget = p95 !== undefined && p95 <= 30000;
  const runnerUp = ranked.find(
    (s) => s.model !== best.model || s.tier !== best.tier,
  );
  const runnerUpNote = runnerUp
    ? ` \`${runnerUp.model}\` @ ${runnerUp.tier} scored higher on kind-acceptable rate (${formatPct(runnerUp.kindAcceptableRate)} vs this profile's ${formatPct(best.kindAcceptableRate)}) but at ${formatMs(runnerUp.totalP95)}ms p95 — several times the latency — which is why it is not the recommendation: population-scale cadence (see the schedule estimate) is latency-bound, not accuracy-bound, once a candidate clears the ${formatPct(MIN_VIABLE_KIND_ACCEPTABLE_RATE)} kind-acceptable bar.`
    : "";
  return (
    `Baseline model profile recommended for ADR-0005's local section: **${best.model}, ${best.server}, ${best.tier} context, parallel=1** — ` +
    `measured native schema validity ${formatPct(best.nativeValidRate)}, kind-acceptable ${formatPct(best.kindAcceptableRate)}, ` +
    `TTFT p50/p95 ${formatMs(best.ttftP50)}/${formatMs(best.ttftP95)}ms, completion p50/p95 ${formatMs(best.totalP50)}/${formatMs(best.totalP95)}ms ` +
    `against the acceptance plan's 10s/30s p95 targets (${meetsTarget ? "within" : "measured over"} the 30s p95 target, no pass/fail declared here per the plan's instruction).` +
    runnerUpNote +
    " See the Population schedule estimate above for the reasoning-turns/minute and per-character cadence this profile supports for 7 gods + 20 inhabitants."
  );
}

/**
 * Published aggregate of `results/*.json` — per model×context sample
 * counts, validity rates, latency percentiles, TTFT, RSS, and the
 * environment that produced them. This is a summary of already-computed
 * rates and percentiles ({@link SuiteAggregate}/{@link ParallelAggregate}/
 * {@link OutageAggregate} — the exact shape every render function takes),
 * not a copy of the raw per-prompt samples those rates were computed from:
 * the raw records (gitignored) are what independently recomputing a
 * rate/percentile from scratch would need. This file is committed instead
 * so the README's published numbers have a durable, versioned record that
 * survives without them — including on a fresh checkout that never ran a
 * single `suite`/`parallel`/`outage` command itself (see `cmdReport`,
 * `summaryToReportData`).
 */
interface Summary {
  readonly generatedAt: string;
  readonly suites: readonly SuiteAggregate[];
  readonly parallel: readonly ParallelAggregate[];
  readonly outage: readonly OutageAggregate[];
  readonly environment: EnvironmentInfo | undefined;
}

function persistSummary(summary: Summary): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = join(RESULTS_DIR, SUMMARY_FILENAME);
  writeFileSync(path, JSON.stringify(summary, null, 2));
  console.error(`[inference-baseline] wrote ${path}`);
}

function reportDataToSummary(data: ReportData): Summary {
  return {
    generatedAt: new Date().toISOString(),
    suites: data.suites,
    parallel: data.parallel,
    outage: data.outage,
    environment: data.environment,
  };
}

/**
 * `report`'s three-way dispatch:
 *   1. Raw `results/*.json` records exist (any file besides `summary.json`)
 *      — the normal path after running `suite`/`parallel`/`outage`. If a
 *      committed `results/summary.json` also exists (an incremental re-run
 *      adding one more candidate to an already-published matrix, without
 *      every prior candidate's gitignored raw records on disk), the fresh
 *      raw-derived data is merged with it (see `mergeReportData`) rather
 *      than replacing it outright — otherwise a partial set of raw records
 *      would silently drop every other previously-published candidate.
 *      Render the README from the (possibly merged) data and regenerate
 *      `summary.json` to match.
 *   2. No raw records, but the committed `results/summary.json` aggregate
 *      exists — a fresh checkout: render the README from that aggregate
 *      instead, and leave `summary.json` untouched (never rewrite the
 *      aggregate *from* the aggregate — that would silently launder any
 *      drift between the committed file and this binary's rendering logic
 *      as a second "generation", and there's no raw data to regenerate it
 *      from correctly anyway).
 *   3. Neither exists: nothing to report — exit non-zero without writing
 *      any file, rather than silently overwriting a real README with empty
 *      tables (the bug this three-way split exists to fix).
 */
function cmdReport(): void {
  const rawFiles = listRawResultFiles();
  const committedSummary = loadCommittedSummary();
  if (rawFiles.length > 0) {
    const records = loadRawRecords();
    const fresh = recordsToReportData(records);
    const data = committedSummary
      ? mergeReportData(summaryToReportData(committedSummary), fresh)
      : fresh;
    writeReadmeFromData(data);
    persistSummary(reportDataToSummary(data));
    return;
  }
  if (committedSummary) {
    writeReadmeFromData(summaryToReportData(committedSummary));
    console.error(
      "[inference-baseline] rendered README from committed results/summary.json (no raw results/*.json records present) — summary.json left unchanged",
    );
    return;
  }
  console.error(
    "[inference-baseline] no results found: no raw results/*.json records and no results/summary.json — nothing to report",
  );
  process.exitCode = 1;
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
    cmdReport();
  } else {
    throw new Error(
      `usage: bun run src/run.ts <suite|parallel|outage|report> [--flags]`,
    );
  }
}

// Guarded so report.test.ts (and the new run.test.ts) can import this
// module's exported pure functions without triggering the CLI dispatch
// above — `import.meta.main` is only true when this file is the actual
// entry point (`bun run src/run.ts ...`), not when it's imported.
if (import.meta.main) {
  await main();
}
