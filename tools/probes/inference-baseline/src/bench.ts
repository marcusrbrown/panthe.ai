// Core measurement library: the action JSON Schema, context-tier padding,
// per-prompt evaluation (native structured output, falling back to
// prompt-only + repair), and the population schedule estimate. `run.ts` is
// the CLI that drives this against real servers and renders the README;
// this module has no process-spawning of its own so it stays testable.

import {
  type Action,
  type ParseResult,
  parseAction,
} from "@panthea/tools-probes-shared";
import {
  type ChatMessage,
  type ChatServer,
  computeTokPerSec,
  extractFirstJsonObject,
} from "./servers";

export type ContextTier = "1k" | "4k";

export interface PromptFixture {
  readonly id: string;
  readonly speaker: string;
  readonly speakerRole: "god" | "inhabitant";
  readonly speakerOccupation?: string;
  readonly scene: string;
  readonly dialogueTurn: string;
}

export type ExpectedKinds = Readonly<Record<string, readonly string[]>>;

/** Hand-written JSON Schema for {@link Action} (shared `schema.ts`'s union),
 * used as the structured-output constraint for both servers. Kept in sync
 * with `parseAction`'s rules by hand — there are only five variants. */
export function actionJsonSchema(): unknown {
  return {
    oneOf: [
      {
        type: "object",
        properties: {
          kind: { const: "move" },
          target: {
            anyOf: [
              { type: "string", minLength: 1 },
              {
                type: "object",
                properties: { x: { type: "number" }, y: { type: "number" } },
                required: ["x", "y"],
                additionalProperties: false,
              },
            ],
          },
        },
        required: ["kind", "target"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          kind: { const: "say" },
          to: { type: "string", minLength: 1 },
          text: { type: "string", minLength: 1 },
        },
        required: ["kind", "to", "text"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          kind: { const: "trade" },
          with: { type: "string", minLength: 1 },
          give: {
            type: "array",
            items: {
              type: "object",
              properties: {
                item: { type: "string", minLength: 1 },
                qty: { type: "number" },
              },
              required: ["item", "qty"],
              additionalProperties: false,
            },
          },
          receive: {
            type: "array",
            items: {
              type: "object",
              properties: {
                item: { type: "string", minLength: 1 },
                qty: { type: "number" },
              },
              required: ["item", "qty"],
              additionalProperties: false,
            },
          },
        },
        required: ["kind", "with", "give", "receive"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          kind: { const: "strike" },
          target: { type: "string", minLength: 1 },
          power: { type: "number" },
        },
        required: ["kind", "target", "power"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          kind: { const: "idle" },
          reason: { type: "string" },
        },
        required: ["kind"],
        additionalProperties: false,
      },
    ],
  };
}

// Deterministic filler standing in for prior world-log entries — repeated
// (not randomized) so token counts are reproducible across runs. ~4
// characters/token is the standard rough heuristic for English text; exact
// enough to hit the requested order of magnitude, not exact tokenizer
// parity (the servers report their own prompt_eval_count/prompt_tokens,
// which is the authoritative count recorded per result).
const WORLD_LOG_ENTRY =
  "The town crier noted that trade at the market held steady, the tide " +
  "along the harbor stayed calm, and no petitioner came before Olympus " +
  "with an urgent grievance. ";
const CHARS_PER_TOKEN = 4;
const CONTEXT_TARGET_TOKENS: Readonly<Record<ContextTier, number>> = {
  "1k": 1024,
  "4k": 4096,
};

/** Builds deterministic filler text sized (by the chars/token heuristic) to
 * the requested context tier, standing in for a longer-running world-event
 * log preceding the current turn. */
export function buildContextPadding(tier: ContextTier): string {
  const targetChars = CONTEXT_TARGET_TOKENS[tier] * CHARS_PER_TOKEN;
  let text = "";
  while (text.length < targetChars) {
    text += WORLD_LOG_ENTRY;
  }
  return text.slice(0, targetChars);
}

const SYSTEM_PREAMBLE =
  "You are the reasoning process for a character in Panthea, a Greek-myth " +
  "life simulation. Given the scene and the most recent line of dialogue, " +
  "propose exactly one next action for your character as a single JSON " +
  'object with a "kind" field: "move" (go somewhere), "say" (speak to ' +
  'someone), "trade" (exchange items), "strike" (a god\'s show of power), ' +
  'or "idle" (do nothing this turn). Reply with the JSON object only.';

export function buildMessages(
  fixture: PromptFixture,
  tier: ContextTier,
): readonly ChatMessage[] {
  const role = fixture.speakerOccupation
    ? `${fixture.speakerRole} (${fixture.speakerOccupation})`
    : fixture.speakerRole;
  const system = [
    SYSTEM_PREAMBLE,
    `Recent world log:\n${buildContextPadding(tier)}`,
    `You are ${fixture.speaker}, a ${role}.`,
  ].join("\n\n");
  const user = `Scene: ${fixture.scene}\n\n${fixture.dialogueTurn}\n\nPropose your next action.`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export type ValidityOutcome =
  | "native-valid"
  | "repaired-valid"
  | "schema-invalid"
  | "timeout"
  | "error";

export interface PromptResult {
  readonly promptId: string;
  readonly contextTier: ContextTier;
  readonly mode: "native" | "prompt-only";
  readonly outcome: ValidityOutcome;
  readonly kind: string | undefined;
  readonly kindAcceptable: boolean | undefined;
  readonly ttftMs: number | undefined;
  readonly totalMs: number | undefined;
  readonly tokPerSec: number | undefined;
  readonly serverTokPerSec: number | undefined;
  readonly promptTokens: number | undefined;
  readonly completionTokens: number | undefined;
  readonly errorMessage: string | undefined;
}

function classifyParse(
  raw: string,
  mode: "native" | "prompt-only",
): {
  readonly outcome: ValidityOutcome;
  readonly parsed?: ParseResult<Action>;
} {
  const directAttempt = attemptParse(raw);
  if (directAttempt.ok) {
    return {
      outcome: mode === "native" ? "native-valid" : "repaired-valid",
      parsed: directAttempt,
    };
  }
  const extracted = extractFirstJsonObject(raw);
  if (extracted) {
    const repairedAttempt = attemptParse(extracted);
    if (repairedAttempt.ok) {
      return { outcome: "repaired-valid", parsed: repairedAttempt };
    }
  }
  return { outcome: "schema-invalid" };
}

function attemptParse(raw: string): ParseResult<Action> {
  try {
    return parseAction(JSON.parse(raw));
  } catch {
    return { ok: false, path: "", message: "not valid JSON" };
  }
}

export interface RunPromptOptions {
  readonly model: string;
  readonly contextTokens: number;
  readonly maxTokens: number;
  readonly timeoutMs: number;
  /** When false, omits the JSON Schema constraint (prompt-only fallback path). */
  readonly useNativeSchema: boolean;
}

export async function runPrompt(
  server: ChatServer,
  fixture: PromptFixture,
  tier: ContextTier,
  expected: ExpectedKinds,
  options: RunPromptOptions,
): Promise<PromptResult> {
  const mode = options.useNativeSchema ? "native" : "prompt-only";
  const messages = buildMessages(fixture, tier);
  const result = await server.chat({
    model: options.model,
    messages,
    jsonSchema: options.useNativeSchema ? actionJsonSchema() : undefined,
    contextTokens: options.contextTokens,
    maxTokens: options.maxTokens,
    timeoutMs: options.timeoutMs,
  });

  if (!result.ok) {
    return {
      promptId: fixture.id,
      contextTier: tier,
      mode,
      outcome: result.kind === "timeout" ? "timeout" : "error",
      kind: undefined,
      kindAcceptable: undefined,
      ttftMs: undefined,
      totalMs: result.totalMs,
      tokPerSec: undefined,
      serverTokPerSec: undefined,
      promptTokens: undefined,
      completionTokens: undefined,
      errorMessage: result.message,
    };
  }

  const { outcome, parsed } = classifyParse(result.content, mode);
  const kind = parsed?.ok ? parsed.action.kind : undefined;
  const acceptableKinds = expected[fixture.id] ?? [];
  const kindAcceptable =
    kind === undefined ? undefined : acceptableKinds.includes(kind);
  const generationMs =
    result.ttftMs !== undefined
      ? result.totalMs - result.ttftMs
      : result.totalMs;

  return {
    promptId: fixture.id,
    contextTier: tier,
    mode,
    outcome,
    kind,
    kindAcceptable,
    ttftMs: result.ttftMs,
    totalMs: result.totalMs,
    tokPerSec: computeTokPerSec(result.completionTokens, generationMs),
    serverTokPerSec: result.serverTokPerSec,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    errorMessage: undefined,
  };
}

export interface RunSuiteOptions
  extends Omit<RunPromptOptions, "useNativeSchema"> {
  /** IDs of prompts to also run through the prompt-only + repair path, as an
   * audit sample rather than a full second pass over all 40 prompts (kept
   * proportionate to a single probe run — see the README's Caveat section
   * for why). Omit or empty to skip the audit entirely. */
  readonly repairAuditPromptIds?: readonly string[];
}

export async function runSuite(
  server: ChatServer,
  prompts: readonly PromptFixture[],
  expected: ExpectedKinds,
  tier: ContextTier,
  options: RunSuiteOptions,
): Promise<readonly PromptResult[]> {
  const results: PromptResult[] = [];
  for (const fixture of prompts) {
    results.push(
      await runPrompt(server, fixture, tier, expected, {
        ...options,
        useNativeSchema: true,
      }),
    );
  }
  const auditIds = new Set(options.repairAuditPromptIds ?? []);
  if (auditIds.size > 0) {
    for (const fixture of prompts) {
      if (!auditIds.has(fixture.id)) {
        continue;
      }
      results.push(
        await runPrompt(server, fixture, tier, expected, {
          ...options,
          useNativeSchema: false,
        }),
      );
    }
  }
  return results;
}

export interface ValiditySummary {
  readonly total: number;
  readonly nativeValidRate: number;
  readonly repairedValidRate: number | undefined;
  readonly kindAcceptableRate: number;
  readonly timeoutCount: number;
  readonly errorCount: number;
}

export function summarizeValidity(
  results: readonly PromptResult[],
): ValiditySummary {
  const nativeResults = results.filter((r) => r.mode === "native");
  const repairResults = results.filter((r) => r.mode === "prompt-only");
  const nativeValid = nativeResults.filter(
    (r) => r.outcome === "native-valid" || r.outcome === "repaired-valid",
  ).length;
  const repairedValid = repairResults.filter(
    (r) => r.outcome === "repaired-valid",
  ).length;
  const kindAcceptable = nativeResults.filter((r) => r.kindAcceptable).length;
  const timeoutCount = nativeResults.filter(
    (r) => r.outcome === "timeout",
  ).length;
  const errorCount = nativeResults.filter((r) => r.outcome === "error").length;
  return {
    total: nativeResults.length,
    nativeValidRate:
      nativeResults.length > 0 ? nativeValid / nativeResults.length : 0,
    repairedValidRate:
      repairResults.length > 0
        ? repairedValid / repairResults.length
        : undefined,
    kindAcceptableRate:
      nativeResults.length > 0 ? kindAcceptable / nativeResults.length : 0,
    timeoutCount,
    errorCount,
  };
}

export interface ScheduleEstimate {
  readonly reasoningTurnsPerMinute: number;
  readonly castSize: number;
  readonly perCharacterCadenceSeconds: number;
  readonly starvationThresholdSeconds: number;
}

/**
 * From a measured p95 completion latency, estimates how often each of
 * `castSize` characters (default 27: 7 gods + 20 inhabitants) gets a
 * reasoning turn under a single-model bounded queue (`concurrency` slots,
 * default 1 — the measured `parallel=1` baseline), and the point at which a
 * character's wait for its next turn exceeds `starvationThresholdSeconds`
 * (default: the acceptance plan's 30 s p95 completion target).
 */
export function estimateSchedule(
  p95LatencyMs: number,
  castSize = 27,
  concurrency = 1,
  starvationThresholdSeconds = 30,
): ScheduleEstimate {
  const latencySeconds = p95LatencyMs / 1000;
  const reasoningTurnsPerMinute = (60 * concurrency) / latencySeconds;
  const perCharacterCadenceSeconds = (castSize * latencySeconds) / concurrency;
  return {
    reasoningTurnsPerMinute,
    castSize,
    perCharacterCadenceSeconds,
    starvationThresholdSeconds,
  };
}
