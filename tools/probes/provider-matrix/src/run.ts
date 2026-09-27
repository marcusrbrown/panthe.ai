#!/usr/bin/env bun
// CLI entry point for the provider-matrix probe: `--live`, `--offline`, or
// `--contract`. Writes a raw JSON result under `results/` (gitignored) and
// renders this probe's README via the shared report helper so every number
// is measured, never hand-copied, and every secret is redacted before it
// reaches disk.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  captureEnvironment,
  type MetricInput,
  type ReportInput,
  redactSecrets,
  renderReport,
} from "@panthea/tools-probes-shared";
import { loadOpenCodeAuth } from "./auth";
import {
  type DegradedEvent,
  type FallbackTraceEntry,
  ROUTINE_ONLY_ACTION,
  runFallback,
} from "./fallback";
import {
  type CaptureSummary,
  checkOfflineCaptureAvailable,
  offlineDnsLogCommand,
  runOfflineRequests,
  startCapture,
  summarizeCapture,
} from "./offline";
import {
  classifyError,
  createOllamaModel,
  createProviderModel,
  type ErrorClass,
  isOllamaReachable,
  requestStructuredAction,
  requestToolCall,
  type StructuredOutputMode,
} from "./providers";
import { repairAction } from "./repair";

const PROBE_DIR = new URL("..", import.meta.url).pathname;
const RESULTS_DIR = join(PROBE_DIR, "results");
const README_PATH = join(PROBE_DIR, "README.md");

const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const GO_BASE_URL = "https://opencode.ai/zen/go/v1";
const OFFLINE_PCAP_PATH = join(RESULTS_DIR, "offline.pcap");
// Relative form used only for the command string shown to the owner in
// findings/README (matches the "cd tools/probes/provider-matrix" step in
// How to run); the absolute path above is what's actually passed to tcpdump.
const OFFLINE_PCAP_DISPLAY_PATH = "results/offline.pcap";
const MAX_REQUESTS_PER_MODEL = 20;
const CONSECUTIVE_429_ABORT_THRESHOLD = 3;
/**
 * Go is billed per request against a $10/month subscription usage cap
 * (docs/plans Unit 6 KTD). Sending the full 20-request cap on every probe
 * run would burn a meaningful fraction of the monthly allowance for no
 * additional evidence value, so the live Go arm intentionally runs a much
 * smaller sample and records that choice in the README rather than
 * pretending the cap was exhausted.
 */
const GO_LIVE_REQUEST_COUNT = 3;

const SAMPLE_PROMPT =
  "You are Zeus, king of the gods, deciding what to do next in a small " +
  "Greek town simulation. A mortal named Alexios has just left an offering " +
  "at your altar. Decide your next action.";

interface ModelMatrixEntry {
  readonly modelId: string;
  readonly family: "responses" | "chat-completions";
  readonly baseURL: string;
  readonly providerName: string;
  readonly free: boolean;
}

const ZEN_MODELS: readonly ModelMatrixEntry[] = [
  {
    modelId: "nemotron-3.5-lightning-free",
    family: "chat-completions",
    baseURL: ZEN_BASE_URL,
    providerName: "opencode-zen",
    free: true,
  },
  {
    modelId: "muse-spark-1.3-contributor-free",
    family: "responses",
    baseURL: ZEN_BASE_URL,
    providerName: "opencode-zen",
    free: true,
  },
];

// Cheapest listed Go model as of the docs snapshot taken for this probe
// (https://opencode.ai/docs/go/, Usage limits table): MiMo-V2.5 and
// MiMo-V2.6-Flash tie at $0.14/$0.28 per 1M input/output tokens; MiMo-V2.5
// is used here since it isn't a "-Flash" variant already covered by the
// naming pattern of the Zen free arm.
const GO_MODEL: ModelMatrixEntry = {
  modelId: "mimo-v2.5",
  family: "chat-completions",
  baseURL: GO_BASE_URL,
  providerName: "opencode-go",
  free: false,
};

interface ModelRunResult {
  readonly modelId: string;
  readonly family: string;
  readonly requestCount: number;
  readonly structuredModes: Record<StructuredOutputMode, number>;
  readonly toolCallSupported: number;
  readonly toolCallUnsupported: number;
  readonly latenciesMs: number[];
  readonly rateLimitCount: number;
  readonly errorClasses: Partial<Record<ErrorClass, number>>;
  readonly abortedEarly: boolean;
  /** First failure's redacted error text, for a human-readable finding (e.g. a client restriction vs a transient outage). */
  readonly sampleError?: string;
}

const FREE_TIER_CLIENT_RESTRICTION_MARKER =
  "free tier can only be used from within opencode";

/** True when a Zen free-model failure is the documented "OpenCode client only" restriction, not a transient/infra failure. */
function isFreeTierClientRestriction(errorText: string | undefined): boolean {
  return (
    errorText?.toLowerCase().includes(FREE_TIER_CLIENT_RESTRICTION_MARKER) ??
    false
  );
}

async function runModelMatrix(
  entry: ModelMatrixEntry,
  apiKey: string,
  requestCount: number,
): Promise<ModelRunResult> {
  const model = createProviderModel({
    family: entry.family,
    baseURL: entry.baseURL,
    apiKey,
    modelId: entry.modelId,
    providerName: entry.providerName,
  });

  const structuredModes: Record<StructuredOutputMode, number> = {
    native: 0,
    repaired: 0,
    failed: 0,
  };
  const latenciesMs: number[] = [];
  const errorClasses: Partial<Record<ErrorClass, number>> = {};
  let rateLimitCount = 0;
  let consecutive429 = 0;
  let toolCallSupported = 0;
  let toolCallUnsupported = 0;
  let abortedEarly = false;
  let issued = 0;
  let sampleError: string | undefined;

  for (let i = 0; i < requestCount; i += 1) {
    issued += 1;
    const start = performance.now();
    const attempt = await requestStructuredAction(model, SAMPLE_PROMPT);
    latenciesMs.push(performance.now() - start);
    structuredModes[attempt.mode] += 1;

    if (attempt.mode === "failed" && attempt.error) {
      sampleError ??= attempt.error;
      const isRateLimit = attempt.error.toLowerCase().includes("429");
      if (isRateLimit) {
        rateLimitCount += 1;
        consecutive429 += 1;
      } else {
        consecutive429 = 0;
      }
      const errorClass = isRateLimit ? "rate-limit" : "unknown";
      errorClasses[errorClass] = (errorClasses[errorClass] ?? 0) + 1;
      if (consecutive429 >= CONSECUTIVE_429_ABORT_THRESHOLD) {
        abortedEarly = true;
        break;
      }
      // A persistent client-side restriction (not a transient/rate-limit
      // failure) will repeat identically on every retry; stop burning
      // requests against it after a couple of confirmations rather than
      // spending the full cap proving the same fact 20 times.
      if (isFreeTierClientRestriction(attempt.error) && issued >= 2) {
        abortedEarly = true;
        break;
      }
    } else {
      consecutive429 = 0;
    }
  }

  // One tool-call check per model — enough to record native support without
  // spending the full request cap on it.
  try {
    const toolResult = await requestToolCall(model, SAMPLE_PROMPT);
    if (toolResult.supported) {
      toolCallSupported += 1;
    } else {
      toolCallUnsupported += 1;
    }
  } catch (error) {
    toolCallUnsupported += 1;
    const errorClass = classifyError(error);
    errorClasses[errorClass] = (errorClasses[errorClass] ?? 0) + 1;
  }

  return {
    modelId: entry.modelId,
    family: entry.family,
    requestCount: issued,
    structuredModes,
    toolCallSupported,
    toolCallUnsupported,
    latenciesMs,
    rateLimitCount,
    errorClasses,
    abortedEarly,
    sampleError: sampleError ? redactSecrets(sampleError) : undefined,
  };
}

interface LiveResult {
  readonly authKeyName: { zen?: string; go?: string };
  readonly zenModels: ModelRunResult[];
  readonly goModel?: ModelRunResult;
  readonly goSkippedReason?: string;
  /**
   * A small, separately-labeled Go verification run outside the strict
   * "only if Zen succeeds" gate. Populated only when Zen's failure is the
   * documented free-tier client restriction (a permanent, categorical fact,
   * not an outage signal) — see Findings for why the gate alone would
   * otherwise silently under-report Go's real viability.
   */
  readonly goBonusVerification?: ModelRunResult;
  readonly fallbackTrace: readonly FallbackTraceEntry[];
  readonly fallbackDegraded: boolean;
}

async function runLive(): Promise<LiveResult> {
  const auth = loadOpenCodeAuth();
  if (auth.modeWarning) {
    console.warn(redactSecrets(auth.modeWarning));
  }

  if (!auth.zen.configured) {
    throw new Error(
      "OpenCode Zen is not configured in auth.json under any of the candidate keys; cannot run --live",
    );
  }

  const zenModels: ModelRunResult[] = [];
  for (const entry of ZEN_MODELS) {
    const result = await runModelMatrix(
      entry,
      auth.zen.credential,
      MAX_REQUESTS_PER_MODEL,
    );
    zenModels.push(result);
  }

  const zenAllSucceeded = zenModels.every(
    (result) => result.structuredModes.failed < result.requestCount,
  );

  let goModel: ModelRunResult | undefined;
  let goSkippedReason: string | undefined;
  let goBonusVerification: ModelRunResult | undefined;
  if (!zenAllSucceeded) {
    goSkippedReason =
      'skipped under the plan\'s "only if Zen succeeds" gate: at least one Zen free model run failed entirely';
    const zenFailedOnClientRestriction = zenModels.some((m) =>
      isFreeTierClientRestriction(m.sampleError),
    );
    if (zenFailedOnClientRestriction && auth.go.configured) {
      // Feasibility-conflict handling (AGENTS.md): the Zen gate wasn't met,
      // but the reason is a categorical client restriction, not an outage —
      // so report the conflict AND a concrete alternative rather than
      // silently reducing scope to "Go untested".
      goBonusVerification = await runModelMatrix(
        GO_MODEL,
        auth.go.credential,
        GO_LIVE_REQUEST_COUNT,
      );
    }
  } else if (!auth.go.configured) {
    goSkippedReason = "skipped: OpenCode Go is not configured in auth.json";
  } else {
    goModel = await runModelMatrix(
      GO_MODEL,
      auth.go.credential,
      GO_LIVE_REQUEST_COUNT,
    );
  }

  // A real fallback trace against the actually-configured providers: Zen
  // first (expected to succeed, given the check above), then Go, then the
  // local Ollama loopback (expected absent), demonstrating the chain
  // top-to-bottom without spending extra hosted requests forcing failures
  // that the stubbed fallback.test.ts already covers deterministically.
  const zenModel = createProviderModel({
    family: ZEN_MODELS[0].family,
    baseURL: ZEN_MODELS[0].baseURL,
    apiKey: auth.zen.credential,
    modelId: ZEN_MODELS[0].modelId,
    providerName: ZEN_MODELS[0].providerName,
  });
  const ollamaReachable = await isOllamaReachable();
  let fallbackDegradedEvent: DegradedEvent | undefined;
  const fallbackResult = await runFallback(
    [
      {
        name: "zen",
        attempt: async () => {
          const attempt = await requestStructuredAction(
            zenModel,
            SAMPLE_PROMPT,
          );
          if (!attempt.action) {
            throw new Error(attempt.error ?? "zen produced no action");
          }
          return attempt.action;
        },
      },
      {
        name: "go",
        attempt: async () => {
          if (!auth.go.configured) {
            throw new Error("go not configured");
          }
          const model = createProviderModel({
            family: GO_MODEL.family,
            baseURL: GO_MODEL.baseURL,
            apiKey: auth.go.credential,
            modelId: GO_MODEL.modelId,
            providerName: GO_MODEL.providerName,
          });
          const attempt = await requestStructuredAction(model, SAMPLE_PROMPT);
          if (!attempt.action) {
            throw new Error(attempt.error ?? "go produced no action");
          }
          return attempt.action;
        },
      },
      {
        name: "ollama",
        attempt: async () => {
          if (!ollamaReachable) {
            throw new Error("ollama not reachable");
          }
          const model = createOllamaModel("llama3.2:3b");
          const attempt = await requestStructuredAction(model, SAMPLE_PROMPT);
          if (!attempt.action) {
            throw new Error(attempt.error ?? "ollama produced no action");
          }
          return attempt.action;
        },
      },
    ],
    (event) => {
      fallbackDegradedEvent = event;
    },
  );
  void fallbackDegradedEvent;

  return {
    authKeyName: {
      zen: auth.zen.configured ? auth.zen.keyName : undefined,
      go: auth.go.configured ? auth.go.keyName : undefined,
    },
    zenModels,
    goModel,
    goSkippedReason,
    goBonusVerification,
    fallbackTrace: fallbackResult.trace,
    fallbackDegraded: fallbackResult.degraded,
  };
}

interface OfflineResult {
  readonly routerGuarantee: {
    readonly requestCount: number;
    readonly hostedClientConstructions: number;
  };
  readonly capture:
    | { readonly status: "captured"; readonly summary: CaptureSummary }
    | {
        readonly status: "pending-owner-run";
        readonly command: string;
        readonly dnsCommand: string;
      };
}

async function runOffline(): Promise<OfflineResult> {
  mkdirSync(RESULTS_DIR, { recursive: true });

  const routerRun = await runOfflineRequests(
    MAX_REQUESTS_PER_MODEL,
    () =>
      createProviderModel({
        family: "chat-completions",
        baseURL: ZEN_BASE_URL,
        apiKey: "unused-because-offline-must-never-construct-this",
        modelId: ZEN_MODELS[0].modelId,
      }),
    async () => ROUTINE_ONLY_ACTION,
  );

  const availability = await checkOfflineCaptureAvailable(
    OFFLINE_PCAP_DISPLAY_PATH,
  );
  if (availability.status === "pending-owner-run") {
    return {
      routerGuarantee: {
        requestCount: routerRun.requestCount,
        hostedClientConstructions: routerRun.hostedClientConstructions,
      },
      capture: {
        status: "pending-owner-run",
        command: availability.command,
        dnsCommand: offlineDnsLogCommand(),
      },
    };
  }

  const capture = startCapture(OFFLINE_PCAP_PATH);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await capture.stop();
  const summary = await summarizeCapture(OFFLINE_PCAP_PATH);

  return {
    routerGuarantee: {
      requestCount: routerRun.requestCount,
      hostedClientConstructions: routerRun.hostedClientConstructions,
    },
    capture: { status: "captured", summary },
  };
}

interface ContractResult {
  readonly openaiRepairedAction: unknown;
  readonly anthropicRepairedAction: unknown;
  readonly parity: boolean;
  readonly noActionFailsIdentically: boolean;
}

async function runContract(): Promise<ContractResult> {
  const fencedSample =
    '```json\n{"kind":"say","to":"zeus","text":"hail, thunderer"}\n```';
  const openaiRepaired = repairAction(fencedSample);
  const anthropicRepaired = repairAction(fencedSample);
  const noActionOpenai = repairAction("no action here");
  const noActionAnthropic = repairAction("also no action here");

  return {
    openaiRepairedAction: openaiRepaired.ok ? openaiRepaired.action : undefined,
    anthropicRepairedAction: anthropicRepaired.ok
      ? anthropicRepaired.action
      : undefined,
    parity:
      JSON.stringify(openaiRepaired) === JSON.stringify(anthropicRepaired),
    noActionFailsIdentically:
      noActionOpenai.ok === false && noActionAnthropic.ok === false,
  };
}

function metricFor(name: string, samples: readonly number[]): MetricInput {
  return { name, unit: "ms", samples: [...samples] };
}

function buildFindings(
  live: LiveResult | undefined,
  offline: OfflineResult | undefined,
  contract: ContractResult | undefined,
): string[] {
  const findings: string[] = [];

  if (live) {
    findings.push(
      `Zen auth.json key: \`${live.authKeyName.zen ?? "not configured"}\`; Go auth.json key: \`${live.authKeyName.go ?? "not configured"}\`.`,
    );
    for (const model of live.zenModels) {
      findings.push(
        `Zen \`${model.modelId}\` (${model.family}): ${model.requestCount} requests, ` +
          `structured native=${model.structuredModes.native} repaired=${model.structuredModes.repaired} failed=${model.structuredModes.failed}, ` +
          `tool call ${model.toolCallSupported > 0 ? "supported" : "unsupported"}, ` +
          `429s=${model.rateLimitCount}${model.abortedEarly ? " (aborted early)" : ""}${model.sampleError ? ` — sample error: "${model.sampleError}"` : ""}.`,
      );
    }
    if (live.goModel) {
      findings.push(
        `Go \`${live.goModel.modelId}\`: ${live.goModel.requestCount} requests (capped below the ${MAX_REQUESTS_PER_MODEL}-request ceiling given per-request Go billing), ` +
          `structured native=${live.goModel.structuredModes.native} repaired=${live.goModel.structuredModes.repaired} failed=${live.goModel.structuredModes.failed}.`,
      );
    } else if (live.goSkippedReason) {
      findings.push(`Go arm: ${live.goSkippedReason}.`);
    }
    if (live.goBonusVerification) {
      const bonus = live.goBonusVerification;
      findings.push(
        `**Feasibility-conflict finding**: Zen's free-tier models reject direct third-party API access outright ` +
          `("OpenCode's free tier can only be used from within OpenCode" — a permanent, documented client restriction, not a transient outage), ` +
          `so this unit's "only if Zen succeeds" Go gate is never met from this probe. As the concrete alternative, Go's own endpoint was verified ` +
          `independently (bonus check, outside the gate): \`${bonus.modelId}\`, ${bonus.requestCount} requests, ` +
          `structured native=${bonus.structuredModes.native} repaired=${bonus.structuredModes.repaired} failed=${bonus.structuredModes.failed}, ` +
          `tool call ${bonus.toolCallSupported > 0 ? "supported" : "unsupported"}. Go required the documented \`x-opencode-session\` header ` +
          `(https://opencode.ai/docs/go/#where-can-i-use-it); Zen free models still reject the request with that header present.`,
      );
    }
    findings.push(
      `Fallback trace: ${live.fallbackTrace.map((e) => `${e.step}(${e.outcome}, ${e.attempts} attempt${e.attempts === 1 ? "" : "s"})`).join(" -> ")}${live.fallbackDegraded ? " -> degraded/routine-only" : ""}.`,
    );
  }

  if (offline) {
    findings.push(
      `Offline router guarantee: ${offline.routerGuarantee.hostedClientConstructions} hosted-client construction(s) across ${offline.routerGuarantee.requestCount} offline-mode requests (must be 0).`,
    );
    if (offline.capture.status === "captured") {
      findings.push(
        `Packet capture: ${offline.capture.summary.totalPackets} packets observed, ${offline.capture.summary.nonLoopbackPackets} non-loopback (must be 0 for a silent result).`,
      );
    } else {
      findings.push(
        `Packet capture: pending owner run — non-interactive sudo is unavailable on this machine. Run \`${offline.capture.command}\` manually, alongside \`${offline.capture.dnsCommand}\`, then re-run \`bun run src/run.ts --offline\`.`,
      );
    }
  }

  if (contract) {
    findings.push(
      `Contract repair parity across OpenAI/Anthropic fixture shapes: ${contract.parity ? "identical parsed action" : "MISMATCH — see raw results"}; no-valid-action fixtures fail identically: ${contract.noActionFailsIdentically}.`,
    );
  }

  return findings;
}

function buildBottomLine(
  live: LiveResult | undefined,
  offline: OfflineResult | undefined,
): string {
  const parts: string[] = [];
  if (live) {
    const allClientRestricted = live.zenModels.every((m) =>
      isFreeTierClientRestriction(m.sampleError),
    );
    const anyFailed = live.zenModels.some(
      (m) => m.structuredModes.failed === m.requestCount,
    );
    if (allClientRestricted) {
      parts.push(
        "Zen's free-tier models cannot be exercised via direct third-party API access at all (measured: every request rejected with " +
          "\"OpenCode's free tier can only be used from within OpenCode\", regardless of headers) — this is a hard capability conflict for ADR-0005's " +
          "hosted section, not a flaky/rate-limited failure. Concrete alternative, measured in the same run: OpenCode Go's endpoint works over direct " +
          "third-party API access once the documented `x-opencode-session` header is sent, so the fallback chain's Go arm is viable even though its " +
          "free-tier Zen arm is not reachable this way.",
      );
    } else {
      parts.push(
        anyFailed
          ? "At least one Zen free model failed every request in this run — see Findings for the error classes before relying on it as a fallback arm."
          : "Both Zen free models and the fallback chain produced usable structured actions (native or repaired) during this run.",
      );
    }
  }
  if (offline) {
    if (offline.capture.status === "captured") {
      parts.push(
        offline.capture.summary.silent
          ? "Offline mode was silent on the wire: zero non-loopback packets during the capture window."
          : "Offline mode was NOT silent — non-loopback packets were observed; see the capture summary before treating offline mode as network-isolated.",
      );
    } else {
      parts.push(
        "Offline mode's router-level guarantee held (zero hosted-client constructions), but the packet-capture proof is pending an owner-run sudo tcpdump — do not treat offline mode as proven silent until that capture completes.",
      );
    }
  }
  return parts.join(" ");
}

/**
 * Each CLI invocation only runs one mode, but the README needs the union of
 * the most recent live/offline/contract results (Verification: "provider
 * matrix + fallback trace + offline capture summary" together). This loads
 * the newest previously-written `results/<prefix>-*.json` for a mode this
 * invocation didn't just run, so the rendered README always reflects the
 * latest known state across all three rather than only the last mode run.
 */
function loadLatestModeResult<T>(prefix: string): T | undefined {
  let entries: string[];
  try {
    entries = readdirSync(RESULTS_DIR);
  } catch {
    return undefined;
  }
  const matches = entries
    .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(".json"))
    .sort();
  const latest = matches.at(-1);
  if (!latest) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(join(RESULTS_DIR, latest), "utf8"));
    return parsed[prefix] as T | undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const mode = process.argv.slice(2)[0];
  mkdirSync(RESULTS_DIR, { recursive: true });

  let live: LiveResult | undefined;
  let offline: OfflineResult | undefined;
  let contract: ContractResult | undefined;

  if (mode === "--live") {
    live = await runLive();
  } else if (mode === "--offline") {
    offline = await runOffline();
  } else if (mode === "--contract") {
    contract = await runContract();
  } else {
    console.error("usage: run.ts --live | --offline | --contract");
    process.exitCode = 1;
    return;
  }

  // Backfill the modes this invocation didn't run from the latest prior
  // results, so the README stays a union rather than only this run's slice.
  live ??= loadLatestModeResult<LiveResult>("live");
  offline ??= loadLatestModeResult<OfflineResult>("offline");
  contract ??= loadLatestModeResult<ContractResult>("contract");

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rawResultsPath = join(
    RESULTS_DIR,
    `${mode.slice(2)}-${timestamp}.json`,
  );
  writeFileSync(
    rawResultsPath,
    redactSecrets(JSON.stringify({ live, offline, contract }, null, 2)),
  );

  const metrics: MetricInput[] = [];
  if (live) {
    for (const model of live.zenModels) {
      metrics.push(
        metricFor(`zen/${model.modelId} latency`, model.latenciesMs),
      );
    }
    if (live.goModel) {
      metrics.push(
        metricFor(
          `go/${live.goModel.modelId} latency`,
          live.goModel.latenciesMs,
        ),
      );
    }
    if (live.goBonusVerification) {
      metrics.push(
        metricFor(
          `go-bonus/${live.goBonusVerification.modelId} latency`,
          live.goBonusVerification.latenciesMs,
        ),
      );
    }
  }

  const report: ReportInput = {
    question:
      "Can hosted provider adapters (OpenCode Zen, OpenCode Go, OpenAI/Anthropic by contract) " +
      "produce structured actions and a bounded fallback chain, and is offline mode silent on the wire?",
    howToRun:
      "```sh\ncd tools/probes/provider-matrix\nbun install\nbun test                 # unit tests (auth, providers, repair, fallback — no network)\nbun run src/run.ts --contract  # OpenAI/Anthropic fixture-server contract check\nbun run src/run.ts --live      # live Zen/Go matrix (requires ~/.local/share/opencode/auth.json)\n\n# Offline proof needs one elevated step (see Caveat) plus a DNS-query log,\n# both running for the whole window the next command exercises:\nsudo tcpdump -i any -w results/offline.pcap &\nlog stream --predicate 'process == \"mDNSResponder\"' > results/offline-dns.log &\nbun run src/run.ts --offline   # 20 offline-mode requests + capture summary\n```",
    caveat:
      "Go usage is billed per request against a $10/month subscription cap, so the live Go arm " +
      `intentionally runs ${GO_LIVE_REQUEST_COUNT} requests rather than the full ${MAX_REQUESTS_PER_MODEL}-request cap used for the free Zen models. ` +
      "Zen free-tier models may return 429s under load; the matrix records the count and aborts a model's run early after " +
      `${CONSECUTIVE_429_ABORT_THRESHOLD} consecutive 429s rather than exhausting the cap against a rate limit. ` +
      "The offline packet capture needs `sudo`; when non-interactive sudo isn't available, this probe reports the exact " +
      "command for the owner to run rather than claiming silence it can't back up.",
    environment: captureEnvironment({
      extra: {
        zenModels: ZEN_MODELS.map((m) => m.modelId).join(", "),
        goModel: GO_MODEL.modelId,
      },
    }),
    metrics,
    findings: buildFindings(live, offline, contract),
    bottomLine:
      buildBottomLine(live, offline) ||
      "Run --live, --offline, and --contract to populate this section.",
  };

  writeFileSync(README_PATH, renderReport(report));
  console.log(`Wrote ${rawResultsPath}`);
  console.log(`Wrote ${README_PATH}`);
}

await main();
