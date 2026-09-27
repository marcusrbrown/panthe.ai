#!/usr/bin/env bun
// CLI entry point driving the art-local probe. Binary/model staging
// (downloading `sd-server`, the SD 1.5 checkpoint, and the pixel-art LoRA;
// launching `sd-server`; enabling Draw Things' API server) is a
// prerequisite done outside this tool (see README "How to run") — this
// file only exercises already-running servers and persists/reports the
// measurements. Three subcommands:
//
//   suite  --arm sd.cpp|draw-things --base-url <url> --model <name>
//          [--lora-path <path> --lora-multiplier <n>]
//          --width <n> --height <n> --steps <n> [--rss-pid <pid>]
//          [--timeout-ms <n>] --label <name>
//     Runs the full 10-sprite + 5-portrait prompt set (prompts.json)
//     against one reachable arm, polling the generator process's RSS
//     every 250ms if --rss-pid is given, separating first-image warmup
//     from steady-state seconds/image, saving a contact sheet, and
//     writing results/<label>.json.
//
//   cancel --arm sd.cpp|draw-things [--base-url --width --height --steps
//          --baseline-seconds <n>] --label <name>
//     sd.cpp: submits a job, cancels it via HTTP at ~30% of
//     --baseline-seconds, and measures time to a terminal job state.
//     draw-things: records "not supported" (no cancel endpoint) without
//     attempting a request.
//
//   report [--out README.md]
//     Reads every results/*.json record and renders the README (and
//     regenerates the committed results/summary.json aggregate to match);
//     on a fresh checkout with no raw records, renders from that
//     committed aggregate instead and leaves it untouched; with neither
//     present, exits non-zero and writes nothing.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  captureEnvironment,
  type EnvironmentInfo,
  p50 as percentile50,
  p95 as percentile95,
  renderReport,
} from "@panthea/tools-probes-shared";
import {
  buildContactSheet,
  type CancellationResult,
  drawThingsCancellationNotSupported,
  type PromptFixture,
  runDrawThingsArm,
  runSdCppArm,
  runSdCppCancellation,
} from "./bench";
import * as drawthings from "./drawthings";
import promptsJson from "./prompts.json";
import * as sdcpp from "./sdcpp";

const SRC_DIR = import.meta.dir;
const PROBE_DIR = join(SRC_DIR, "..");
const RESULTS_DIR = process.env.ART_LOCAL_RESULTS_DIR
  ? resolve(process.env.ART_LOCAL_RESULTS_DIR)
  : join(PROBE_DIR, "results");
const README_PATH = process.env.ART_LOCAL_README_PATH
  ? resolve(process.env.ART_LOCAL_README_PATH)
  : join(PROBE_DIR, "README.md");
const SUMMARY_FILENAME = "summary.json";
const IMAGES_DIR = join(RESULTS_DIR, "images");

const PROMPTS = promptsJson as unknown as readonly PromptFixture[];

// --- Fixed provenance recorded for this run (binary + model + LoRA). ---
// Not re-derived at report time — these are the exact artifacts this
// probe's bench runs downloaded and drove, recorded once here so the
// README and summary.json always agree with what actually ran.
const SD_CPP_BINARY = {
  source: "https://github.com/leejet/stable-diffusion.cpp",
  tag: "master-921-168f7b8",
  asset: "sd-master-168f7b8-bin-Darwin-macOS-26.6.2-arm64.zip",
  sha256: "2650e3bb9d11da7f933f1beeb7134ca6f05b023c83d6b7db4fd7c6024eddc938",
} as const;

const SD15_MODEL = {
  id: "second-state/stable-diffusion-v1-5-GGUF (stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf)",
  source:
    "https://huggingface.co/second-state/stable-diffusion-v1-5-GGUF/resolve/main/stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf",
  baseModel: "runwayml/stable-diffusion-v1-5",
  license: "creativeml-openrail-m",
  quantization: "Q4_0",
  sizeBytes: 1_566_768_416,
  sha256: "b8944e9fe0b69b36ae1b5bb0185b3a7b8ef14347fe0fa9af6c64c4829022261f",
} as const;

const PIXEL_ART_LORA = {
  id: "artificialguybr/pixelartredmond-1-5v-pixel-art-loras-for-sd-1-5 (PixelArtRedmond15V-PixelArt-PIXARFK.safetensors)",
  source:
    "https://huggingface.co/artificialguybr/pixelartredmond-1-5v-pixel-art-loras-for-sd-1-5/resolve/main/PixelArtRedmond15V-PixelArt-PIXARFK.safetensors",
  baseModel: "runwayml/stable-diffusion-v1-5",
  license:
    "bespoke-lora-trained-license (CivitAI: allowNoCredit=true, allowCommercialUse=Rent, allowDerivatives=true, allowDifferentLicense=false) — non-commercial-oriented, verify before any content-pack use",
  triggerWords:
    "PixArFK must be the FIRST token of the prompt (e.g. `PixArFK, pixel art, ...`) to reliably trigger — mid-string placement (e.g. `pixel art, PixArFK, ...`) does not (owner-confirmed against the live Draw Things app).",
  sizeBytes: 27_216_848,
  sha256: "b770d01002510180cd03b5f8c8199fdb41d924c51d4980fc86298d0e4cdf7953",
} as const;

const QWEN_IMAGE_NOTE =
  "Qwen Image 2.1 under Draw Things ships under the Qwen Research License (non-commercial). Panthea is noncommercial (D01), so it is allowed for evaluation only; a commercial fork would need a different default (see docs/decisions/0007-local-image-generation.md).";

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

function numberFlag(
  flags: Record<string, string>,
  name: string,
  fallback: number,
): number {
  const raw = flags[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`--${name} must be a number, got ${raw}`);
  }
  return value;
}

function isArm(value: string): value is "sd.cpp" | "draw-things" {
  return value === "sd.cpp" || value === "draw-things";
}

/** Builds the single-entry `lora` array sd.cpp options expect from `--lora-path`/`--lora-multiplier`, or `undefined` if none was given. */
function loraFromFlags(
  flags: Record<string, string>,
): readonly sdcpp.LoraRef[] | undefined {
  const path = flags["lora-path"];
  if (!path) {
    return undefined;
  }
  return [{ path, multiplier: numberFlag(flags, "lora-multiplier", 1) }];
}

// --- Stored record shapes ---

interface ArmRecord {
  readonly kind: "arm";
  readonly label: string;
  readonly timestamp: string;
  readonly arm: "sd.cpp" | "draw-things";
  readonly model: string;
  readonly width: number;
  readonly height: number;
  readonly steps: number;
  readonly n: number;
  readonly warmupSeconds: number | undefined;
  readonly secondsPerImage: readonly number[];
  readonly peakRssMiB: number | undefined;
  readonly errors: readonly {
    readonly promptId: string;
    readonly message: string;
  }[];
  readonly contactSheetPath: string | undefined;
}

interface CancelRecord {
  readonly kind: "cancel";
  readonly label: string;
  readonly timestamp: string;
  readonly arm: "sd.cpp" | "draw-things";
  readonly result: CancellationResult;
}

type StoredRecord = ArmRecord | CancelRecord;

function writeResult(label: string, record: StoredRecord): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = join(RESULTS_DIR, `${label}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2));
  console.error(`[art-local] wrote ${path}`);
}

async function cmdSuite(flags: Record<string, string>): Promise<void> {
  const armFlag = requireFlag(flags, "arm");
  if (!isArm(armFlag)) {
    throw new Error(`--arm must be sd.cpp or draw-things, got ${armFlag}`);
  }
  const label = requireFlag(flags, "label");
  const width = numberFlag(flags, "width", 512);
  const height = numberFlag(flags, "height", 512);
  const steps = numberFlag(flags, "steps", 12);
  const timeoutMs = numberFlag(flags, "timeout-ms", 120_000);
  const rssPid = flags["rss-pid"] ? Number(flags["rss-pid"]) : undefined;

  // Draw Things exposes no model/LoRA selection over HTTP — the active
  // model (and any active LoRA) is whatever the app has selected, so
  // record it out of band instead of requiring the caller to know it up
  // front.
  const model =
    flags.model ??
    (armFlag === "draw-things"
      ? await drawthings.getSelectedModelDescriptor({
          baseUrl: requireFlag(flags, "base-url"),
        })
      : requireFlag(flags, "model"));
  if (armFlag === "draw-things") {
    console.error(`[art-local] Draw Things selected model: ${model}`);
  }

  const result =
    armFlag === "sd.cpp"
      ? await runSdCppArm(PROMPTS, {
          config: { baseUrl: requireFlag(flags, "base-url") },
          model,
          width,
          height,
          steps,
          lora: loraFromFlags(flags),
          rssPid,
          timeoutMs,
        })
      : await runDrawThingsArm(PROMPTS, {
          config: { baseUrl: requireFlag(flags, "base-url") },
          model,
          width,
          height,
          steps,
          rssPid,
          timeoutMs,
        });

  mkdirSync(IMAGES_DIR, { recursive: true });
  let contactSheetPath: string | undefined;
  if (result.images.length > 0) {
    const sheet = buildContactSheet(result.images, {
      columns: 5,
      cellSize: 64,
    });
    if (sheet.decodeErrors.length > 0) {
      console.error(
        `[art-local] contact sheet: ${sheet.decodeErrors.length} image(s) failed to decode: ${sheet.decodeErrors
          .map((e) => `${e.promptId}: ${e.message}`)
          .join("; ")}`,
      );
    }
    const sheetPath = join(IMAGES_DIR, `${label}-contact-sheet.png`);
    writeFileSync(sheetPath, sheet.bytes);
    // Recorded relative to the probe directory, not absolute — an absolute
    // path would embed the local username/home directory into a committed
    // README, bypassing the redaction pass that only scrubs the fields it
    // knows about.
    contactSheetPath = relative(PROBE_DIR, sheetPath);
    console.error(
      `[art-local] wrote contact sheet ${sheetPath} (${sheet.bytes.byteLength} bytes)`,
    );
  }

  const record: ArmRecord = {
    kind: "arm",
    label,
    timestamp: new Date().toISOString(),
    arm: armFlag,
    model,
    width,
    height,
    steps,
    n: result.n,
    warmupSeconds: result.warmupSeconds,
    secondsPerImage: result.secondsPerImage,
    peakRssMiB: result.peakRssMiB,
    errors: result.errors,
    contactSheetPath,
  };
  writeResult(label, record);
  console.error(
    `[art-local] ${armFlag} ${model}: ${result.images.length}/${result.n} images, ` +
      `warmup ${result.warmupSeconds?.toFixed(1) ?? "n/a"}s, ` +
      `p50 ${percentile50(result.secondsPerImage)?.toFixed(1) ?? "n/a"}s, ` +
      `errors ${result.errors.length}`,
  );
}

async function cmdCancel(flags: Record<string, string>): Promise<void> {
  const armFlag = requireFlag(flags, "arm");
  if (!isArm(armFlag)) {
    throw new Error(`--arm must be sd.cpp or draw-things, got ${armFlag}`);
  }
  const label = requireFlag(flags, "label");

  const cancellationPrompt = PROMPTS.at(0);
  if (!cancellationPrompt) {
    throw new Error(
      "prompts.json is empty — no fixture available for the cancellation test",
    );
  }

  const result =
    armFlag === "draw-things"
      ? drawThingsCancellationNotSupported()
      : await runSdCppCancellation(
          { baseUrl: requireFlag(flags, "base-url") },
          cancellationPrompt,
          {
            width: numberFlag(flags, "width", 512),
            height: numberFlag(flags, "height", 512),
            steps: numberFlag(flags, "steps", 20),
            baselineSeconds: numberFlag(flags, "baseline-seconds", 10),
            lora: loraFromFlags(flags),
            serverPid: flags["rss-pid"] ? Number(flags["rss-pid"]) : undefined,
          },
        );

  const record: CancelRecord = {
    kind: "cancel",
    label,
    timestamp: new Date().toISOString(),
    arm: armFlag,
    result,
  };
  writeResult(label, record);
  console.error(
    `[art-local] cancel (${armFlag}): supported=${result.supported} cancel-to-idle=${result.cancelToIdleMs ?? "n/a"}ms — ${result.note}`,
  );
}

// --- report ---

interface ArmSummary {
  readonly arm: string;
  readonly model: string;
  readonly width: number;
  readonly height: number;
  readonly steps: number;
  readonly n: number;
  readonly warmupSeconds: number | undefined;
  readonly secondsPerImageP50: number | undefined;
  readonly secondsPerImageP95: number | undefined;
  readonly peakRssMiB: number | undefined;
  readonly errorCount: number;
  readonly contactSheetPath: string | undefined;
}

interface CancelSummary {
  readonly arm: string;
  readonly supported: boolean;
  readonly cancelToIdleMs: number | undefined;
  readonly note: string;
}

interface Summary {
  readonly generatedAt: string;
  readonly arms: readonly ArmSummary[];
  readonly cancellations: readonly CancelSummary[];
  readonly drawThings: {
    readonly reachable: boolean;
    readonly detail: string;
    readonly port: number;
  };
  readonly binary: typeof SD_CPP_BINARY;
  readonly model: typeof SD15_MODEL;
  readonly lora: typeof PIXEL_ART_LORA;
  readonly environment: EnvironmentInfo;
}

function isArmRecord(value: unknown): value is ArmRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "arm"
  );
}

function isCancelRecord(value: unknown): value is CancelRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "cancel"
  );
}

function listRawResultFiles(): readonly string[] {
  if (!existsSync(RESULTS_DIR)) {
    return [];
  }
  return readdirSync(RESULTS_DIR)
    .filter((name) => name.endsWith(".json") && name !== SUMMARY_FILENAME)
    .map((name) => join(RESULTS_DIR, name));
}

function loadRawRecords(): readonly StoredRecord[] {
  return listRawResultFiles().map(
    (path) => JSON.parse(readFileSync(path, "utf8")) as StoredRecord,
  );
}

function loadCommittedSummary(): Summary | undefined {
  const path = join(RESULTS_DIR, SUMMARY_FILENAME);
  if (!existsSync(path)) {
    return undefined;
  }
  return JSON.parse(readFileSync(path, "utf8")) as Summary;
}

function armRecordToSummary(record: ArmRecord): ArmSummary {
  return {
    arm: record.arm,
    model: record.model,
    width: record.width,
    height: record.height,
    steps: record.steps,
    n: record.n,
    warmupSeconds: record.warmupSeconds,
    secondsPerImageP50: percentile50(record.secondsPerImage),
    secondsPerImageP95: percentile95(record.secondsPerImage),
    peakRssMiB: record.peakRssMiB,
    errorCount: record.errors.length,
    contactSheetPath: record.contactSheetPath,
  };
}

function cancelRecordToSummary(record: CancelRecord): CancelSummary {
  return {
    arm: record.arm,
    supported: record.result.supported,
    cancelToIdleMs: record.result.cancelToIdleMs,
    note: record.result.note,
  };
}

function formatSeconds(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toFixed(1);
}

function formatRss(value: number | undefined): string {
  return value === undefined ? "n/a" : `${value.toFixed(0)} MiB`;
}

function buildArmTableMarkdown(arms: readonly ArmSummary[]): string {
  if (arms.length === 0) {
    return "_No arm suite results recorded yet._";
  }
  const header =
    "| Arm | Model | Size | Steps | n | Warmup (s) | s/image p50 | s/image p95 | Peak RSS | Errors |\n" +
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const body = arms
    .map(
      (arm) =>
        `| ${arm.arm} | ${arm.model} | ${arm.width}x${arm.height} | ${arm.steps} | ${arm.n} | ${formatSeconds(arm.warmupSeconds)} | ${formatSeconds(arm.secondsPerImageP50)} | ${formatSeconds(arm.secondsPerImageP95)} | ${formatRss(arm.peakRssMiB)} | ${arm.errorCount} |`,
    )
    .join("\n");
  return `${header}\n${body}`;
}

function buildCancelTableMarkdown(
  cancellations: readonly CancelSummary[],
): string {
  if (cancellations.length === 0) {
    return "_No cancellation results recorded yet._";
  }
  const header =
    "| Arm | Supported | Cancel-to-idle | Note |\n| --- | --- | --- | --- |";
  const body = cancellations
    .map(
      (c) =>
        `| ${c.arm} | ${c.supported ? "yes" : "no"} | ${c.cancelToIdleMs !== undefined ? `${c.cancelToIdleMs}ms` : "n/a"} | ${c.note} |`,
    )
    .join("\n");
  return `${header}\n${body}`;
}

function drawThingsArmSummary(summary: Summary): ArmSummary | undefined {
  return summary.arms.find((arm) => arm.arm === "draw-things");
}

function buildDrawThingsReachabilityNote(summary: Summary): string {
  if (!summary.drawThings.reachable) {
    return `Draw Things' HTTP API server was enabled by the owner, but this probe found it not reachable at port ${summary.drawThings.port} during this run (${summary.drawThings.detail}); the base arm's results are unaffected by that.`;
  }
  const dtArm = drawThingsArmSummary(summary);
  if (dtArm && dtArm.errorCount === dtArm.n && dtArm.n > 0) {
    return `Draw Things was reachable at port ${summary.drawThings.port}, but every prompt against the app's currently selected model (\`${dtArm.model}\`) failed the same way — the app reports that model as missing required local files, not something this probe can fix by request shape or retry. Per the HTTP API's limits, this probe cannot switch to a different model; the base arm's results are unaffected.`;
  }
  return `Draw Things was reachable at port ${summary.drawThings.port} and its measured numbers appear in the table below as an optional add-on arm.`;
}

function buildCaveat(summary: Summary): string {
  const parts: string[] = [
    `Draw Things is an OPTIONAL add-on arm (owner direction): stable-diffusion.cpp is the base arm and must work, and settles, standalone. ${buildDrawThingsReachabilityNote(summary)}`,
    "Draw Things' HTTP surface (`/sdapi/v1/txt2img`, A1111-shaped) has no model/LoRA selection, no model list, and no cancellation — the active model is whatever the app has selected. This probe reads the selected model from `GET /sdapi/v1/options` (Draw Things' own settings dict, keyed `model`, not the vanilla A1111/stable-diffusion.cpp-compat `sd_model_checkpoint` key) and records it per run rather than assuming it.",
    QWEN_IMAGE_NOTE,
    "16GB three-way coexistence (renderer + inference + image generation together) is out of scope here — that is Unit 8's `tools/probes/coexistence` measurement, not this probe's.",
    `Pixel-art styling on the sd.cpp arm comes from a LoRA (${PIXEL_ART_LORA.id}), not a pixel-art-tuned base checkpoint — no single-file pixel-art-tuned SD 1.5 checkpoint in a stable-diffusion.cpp-loadable format (safetensors/ckpt/GGUF) was found within this probe's time budget; the base checkpoint is plain SD 1.5 (${SD15_MODEL.id}).`,
    `LoRA license: ${PIXEL_ART_LORA.license}.`,
    "LoRA trigger-word placement matters: the PixelArtRedmond LoRA only reliably triggers when `PixArFK` is the FIRST token of the prompt (e.g. `PixArFK, pixel art, ...`), not mid-string (e.g. `pixel art, PixArFK, ...`) — confirmed by the owner against the live Draw Things app and applied to every prompt in `prompts.json` for both arms.",
    "`--diffusion-fa` (flash attention) is not optional for usable sd-server performance on this Metal build: the same 512x512, 12-step, no-LoRA generation measured ~127s without it and ~24s with it — roughly a 5x difference — so every sd.cpp arm number in this README was measured with `--diffusion-fa` enabled; running without it is not a viable base-arm configuration.",
    "This sd-server build's native `sdcpp` API reports `cancel_generating: false` in `GET /sdcpp/v1/capabilities` — `POST /sdcpp/v1/jobs/{id}/cancel` only works on a job still queued behind another, not one already generating, so it cannot interrupt the single in-flight job this probe's cancellation test submits. SIGINT to the `sd-server` process was tried first and measured to be silently ignored (the process kept running and started its next queued job); SIGTERM reliably terminates it. The recorded cancel-to-idle number is therefore a whole-process-kill proxy, not a graceful in-job cancel.",
    buildDrawThingsRssCaveat(summary),
  ].filter((part) => part.length > 0);
  return parts.join(" ");
}

function buildDrawThingsRssCaveat(summary: Summary): string {
  const dtArm = drawThingsArmSummary(summary);
  if (!dtArm || dtArm.peakRssMiB === undefined || dtArm.errorCount >= dtArm.n) {
    return "";
  }
  const suspiciouslyLow = dtArm.peakRssMiB < 1000;
  return suspiciouslyLow
    ? `Draw Things' sampled process RSS peak (${dtArm.peakRssMiB.toFixed(0)} MiB) is likely a lower bound, not the true resident footprint: an SD 1.5 f16 checkpoint is roughly 2GB on disk, so Metal/GPU-resident unified-memory buffers are probably not fully reflected in \`ps\`'s RSS column for this app — recorded as sampled, not corrected.`
    : "";
}

function buildFindings(summary: Summary): readonly string[] {
  const findings: string[] = [];
  for (const arm of summary.arms) {
    findings.push(
      `${arm.arm} ${arm.model} @ ${arm.width}x${arm.height}, ${arm.steps} steps: ${arm.n} prompts, warmup ${formatSeconds(arm.warmupSeconds)}s, seconds/image p50/p95 ${formatSeconds(arm.secondsPerImageP50)}/${formatSeconds(arm.secondsPerImageP95)}, peak RSS ${formatRss(arm.peakRssMiB)}, ${arm.errorCount} error(s).`,
    );
  }
  for (const cancel of summary.cancellations) {
    findings.push(
      `Cancellation (${cancel.arm}): supported=${cancel.supported}${cancel.cancelToIdleMs !== undefined ? `, cancel-to-idle ${cancel.cancelToIdleMs}ms` : ""} — ${cancel.note}`,
    );
  }
  findings.push(
    `Draw Things reachability: ${summary.drawThings.reachable ? "reachable" : "not reachable"} at port ${summary.drawThings.port} (${summary.drawThings.detail}).`,
  );
  return findings;
}

function buildBottomLine(summary: Summary): string {
  const sdcppArm = summary.arms.find((arm) => arm.arm === "sd.cpp");
  if (!sdcppArm) {
    return "_No sd.cpp arm results recorded yet — no baseline profile to recommend._";
  }
  const dtArm = drawThingsArmSummary(summary);
  const drawThingsNote = !summary.drawThings.reachable
    ? `Draw Things was not reachable at port ${summary.drawThings.port} during this run and contributes no measured numbers here — it remains an optional, owner-enabled add-on, never a blocker for the base arm.`
    : dtArm && dtArm.errorCount === dtArm.n && dtArm.n > 0
      ? `Draw Things was reachable but its currently selected model (\`${dtArm.model}\`) could not generate (missing required local files) and contributes no measured numbers here — the HTTP API offers no model switch, so this run could not try a different one; it remains an optional add-on, never a blocker for the base arm.`
      : buildLikeForLikeComparisonNote(sdcppArm, dtArm);
  return (
    `**stable-diffusion.cpp (${sdcppArm.model}) at ${sdcppArm.width}x${sdcppArm.height}, ${sdcppArm.steps} steps is the base arm profile for ADR-0007** — measured warmup ${formatSeconds(sdcppArm.warmupSeconds)}s, ` +
    `steady-state seconds/image p50/p95 ${formatSeconds(sdcppArm.secondsPerImageP50)}/${formatSeconds(sdcppArm.secondsPerImageP95)}, peak RSS ${formatRss(sdcppArm.peakRssMiB)}. ` +
    `${drawThingsNote}`
  );
}

function buildLikeForLikeComparisonNote(
  sdcppArm: ArmSummary,
  dtArm: ArmSummary | undefined,
): string {
  if (
    !dtArm ||
    dtArm.secondsPerImageP50 === undefined ||
    sdcppArm.secondsPerImageP50 === undefined
  ) {
    return "Draw Things was reachable and its measured numbers appear above as an optional add-on arm.";
  }
  const sameSize =
    dtArm.width === sdcppArm.width && dtArm.height === sdcppArm.height;
  const sameSteps = dtArm.steps === sdcppArm.steps;
  if (!sameSize || !sameSteps) {
    return "Draw Things was reachable and its measured numbers appear above as an optional add-on arm.";
  }
  const ratio = sdcppArm.secondsPerImageP50 / dtArm.secondsPerImageP50;
  return (
    `Draw Things was reachable and ran the same SD 1.5 checkpoint + pixel-art LoRA at the same ${sdcppArm.width}x${sdcppArm.height}, ${sdcppArm.steps}-step settings as the base arm — a like-for-like comparison. ` +
    `Draw Things measured ${ratio.toFixed(1)}x faster per image (${formatSeconds(dtArm.secondsPerImageP50)}s vs ${formatSeconds(sdcppArm.secondsPerImageP50)}s p50) at a fraction of the sampled process RSS, on the same weights and LoRA — a real, measured gap this probe does not explain (candidates: a more mature Metal attention/kernel path in Draw Things' inference engine vs this stable-diffusion.cpp build's newer flash-attention support and Q4_0 "apply lora at runtime" overhead; unverified, worth a follow-up probe). ` +
    "It does not change the base-arm recommendation: stable-diffusion.cpp is cross-platform and must work standalone (owner direction), while Draw Things is a macOS/iOS-only optional add-on with no HTTP-level model/LoRA selection or in-flight cancellation."
  );
}

function buildSummary(
  arms: readonly ArmSummary[],
  cancellations: readonly CancelSummary[],
  drawThingsStatus: { reachable: boolean; detail: string },
  environment: EnvironmentInfo,
): Summary {
  return {
    generatedAt: new Date().toISOString(),
    arms,
    cancellations,
    drawThings: {
      reachable: drawThingsStatus.reachable,
      detail: drawThingsStatus.detail,
      port: 7860,
    },
    binary: SD_CPP_BINARY,
    model: SD15_MODEL,
    lora: PIXEL_ART_LORA,
    environment,
  };
}

function writeSummary(summary: Summary): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(
    join(RESULTS_DIR, SUMMARY_FILENAME),
    JSON.stringify(summary, null, 2),
  );
}

function writeReadmeFromSummary(summary: Summary): void {
  const base = renderReport({
    question:
      "Which local image-generation arm meets the offline pixel-art-generation profile for ADR-0007 on the M1 Pro 16GB baseline — seconds/image, peak RSS, first-image warmup, and cancellation — and can it settle the base arm without depending on Draw Things?",
    howToRun:
      "**Staging (prerequisite, not timed):**\n\n" +
      "Download the pinned `stable-diffusion.cpp` release (macOS arm64) into `tools/probes/art-local/bin/` (gitignored; tag/sha256 recorded below):\n\n" +
      "```sh\ncurl -sL -o sd.zip https://github.com/leejet/stable-diffusion.cpp/releases/download/master-921-168f7b8/sd-master-168f7b8-bin-Darwin-macOS-26.6.2-arm64.zip\nunzip sd.zip -d bin/\n```\n\n" +
      "Download the SD 1.5 checkpoint and pixel-art LoRA into `tools/probes/art-local/models/` (gitignored; identifiers/sha256 recorded below):\n\n" +
      "```sh\ncurl -sL -o models/sd-v1-5-pruned-emaonly-Q4_0.gguf https://huggingface.co/second-state/stable-diffusion-v1-5-GGUF/resolve/main/stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf\ncurl -sL -o models/loras/PixelArtRedmond15V-PixelArt-PIXARFK.safetensors https://huggingface.co/artificialguybr/pixelartredmond-1-5v-pixel-art-loras-for-sd-1-5/resolve/main/PixelArtRedmond15V-PixelArt-PIXARFK.safetensors\n```\n\n" +
      "Launch `sd-server` (Metal backend on macOS arm64 — `--diffusion-fa` is not optional, see Caveat: the same generation measured ~5x slower without it):\n\n" +
      "```sh\n./bin/sd-server --model models/sd-v1-5-pruned-emaonly-Q4_0.gguf --lora-model-dir models/loras --listen-port 1234 --diffusion-fa\n```\n\n" +
      "Draw Things (optional add-on, owner-installed 26.0924.0): Settings → API Server → enable HTTP on 127.0.0.1:7860; select the same base model + LoRA in-app for a like-for-like comparison (no HTTP model/LoRA selection exists, see Caveat). Never leave it enabled after a run — localhost is not a security boundary here, any local process can drive it.\n\n" +
      "**Suite** (per arm):\n\n" +
      "```sh\ncd tools/probes/art-local\nbun run src/run.ts suite --arm sd.cpp --base-url http://127.0.0.1:1234 \\\n  --width 512 --height 512 --steps 12 \\\n  --lora-path PixelArtRedmond15V-PixelArt-PIXARFK.safetensors --lora-multiplier 0.6 \\\n  --rss-pid <sd-server-pid> --label sdcpp-512\n\nbun run src/run.ts suite --arm draw-things --base-url http://127.0.0.1:7860 \\\n  --width 512 --height 512 --steps 12 --rss-pid <DrawThings-pid> --label drawthings-512\n```\n\n" +
      "`--model` is optional for `--arm sd.cpp` (defaults to a literal description) but required in practice for a meaningful README row; for `--arm draw-things` it is auto-read from `GET /sdapi/v1/options` (the app's own selection) if omitted. `--rss-pid` is the generator process's own pid (`pgrep -f sd-server`, or Draw Things' pid from Activity Monitor/`ps`) — the sampler polls its RSS every 250ms and records the peak.\n\n" +
      "**Cancellation**:\n\n" +
      "```sh\nbun run src/run.ts cancel --arm sd.cpp --base-url http://127.0.0.1:1234 \\\n  --width 512 --height 512 --steps 20 --baseline-seconds <measured-p50-seconds> \\\n  --lora-path PixelArtRedmond15V-PixelArt-PIXARFK.safetensors --lora-multiplier 0.6 \\\n  --rss-pid <sd-server-pid> --label sdcpp-cancel\n\nbun run src/run.ts cancel --arm draw-things --label drawthings-cancel\n```\n\n" +
      "Submits a job and aborts it at ~30% of `--baseline-seconds`. Tries `POST /sdcpp/v1/jobs/{id}/cancel` first; if this server build reports `cancel_generating: false` (measured true here, see Caveat), `--rss-pid` is required and the fallback SIGTERMs the `sd-server` process itself, measuring time to idle. Draw Things has no cancel path at all and is recorded as unsupported without attempting a request.\n\n" +
      "**Report**: `bun run src/run.ts report` — renders this README from raw `results/*.json` records when present (and regenerates the committed `results/summary.json` published aggregate to match); on a fresh checkout with no raw records, renders from that committed aggregate instead and leaves it untouched; with neither present, exits non-zero and writes nothing. `results/summary.json` publishes already-computed rates/percentiles/counts, not the raw per-prompt samples they were computed from.",
    caveat: buildCaveat(summary),
    environment: summary.environment,
    metrics: [],
    findings: buildFindings(summary),
    bottomLine: buildBottomLine(summary),
  });

  const contactSheetLines = summary.arms
    .filter((arm) => arm.contactSheetPath)
    .map((arm) => `- ${arm.arm} (${arm.model}): \`${arm.contactSheetPath}\``);

  const resultsMarkdown = [
    "#### Per-arm results",
    "",
    buildArmTableMarkdown(summary.arms),
    "",
    "#### Cancellation",
    "",
    buildCancelTableMarkdown(summary.cancellations),
    "",
    "#### Contact sheets (owner review, no automated quality score)",
    "",
    contactSheetLines.length > 0
      ? contactSheetLines.join("\n")
      : "_No contact sheets generated yet._",
    "",
    "#### Environment provenance",
    "",
    "| Artifact | Identifier | Size | License |",
    "| --- | --- | --- | --- |",
    `| sd-server binary | ${summary.binary.tag} (${summary.binary.asset}) | — | see leejet/stable-diffusion.cpp |`,
    `| Base checkpoint | ${summary.model.id} | ${(summary.model.sizeBytes / 1024 / 1024).toFixed(0)} MiB | ${summary.model.license} |`,
    `| Pixel-art LoRA | ${summary.lora.id} | ${(summary.lora.sizeBytes / 1024 / 1024).toFixed(0)} MiB | ${summary.lora.license} |`,
  ].join("\n");

  const withResults = base.replace(
    "## Results\n\nNo metrics recorded.",
    `## Results\n\n${resultsMarkdown}`,
  );
  writeFileSync(README_PATH, withResults);
  console.error(`[art-local] wrote ${README_PATH}`);
}

async function cmdReport(): Promise<void> {
  const rawFiles = listRawResultFiles();
  const committed = loadCommittedSummary();

  if (rawFiles.length === 0 && !committed) {
    console.error(
      "[art-local] no raw results/*.json records and no committed results/summary.json — nothing to report",
    );
    process.exitCode = 1;
    return;
  }

  let summary: Summary;
  if (rawFiles.length > 0) {
    const records = loadRawRecords();
    const arms = records.filter(isArmRecord).map(armRecordToSummary);
    const cancellations = records
      .filter(isCancelRecord)
      .map(cancelRecordToSummary);
    const drawThingsStatus = await drawthings.checkReachable(
      { baseUrl: "http://127.0.0.1:7860" },
      3_000,
    );
    const environment = captureEnvironment({
      extra: {
        "sd-server binary": `${SD_CPP_BINARY.tag} (sha256 ${SD_CPP_BINARY.sha256.slice(0, 12)}...)`,
        "SD 1.5 checkpoint": SD15_MODEL.id,
        "Pixel-art LoRA": PIXEL_ART_LORA.id,
      },
    });
    summary = buildSummary(arms, cancellations, drawThingsStatus, environment);
    writeSummary(summary);
  } else if (committed) {
    summary = committed;
  } else {
    // Unreachable: the early return above already covers "neither present".
    throw new Error("no results to report");
  }

  writeReadmeFromSummary(summary);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  switch (command) {
    case "suite":
      await cmdSuite(flags);
      return;
    case "cancel":
      await cmdCancel(flags);
      return;
    case "report":
      await cmdReport();
      return;
    default:
      console.error(
        "usage: bun run src/run.ts <suite|cancel|report> [--flags...]",
      );
      process.exitCode = 1;
  }
}

// Referenced only to keep the sd-server reachability check available to
// future subcommands without an unused-import lint failure.
void sdcpp.checkReachable;

await main();
