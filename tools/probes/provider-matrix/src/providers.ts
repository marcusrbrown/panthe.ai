// Vercel AI SDK 7 adapters parameterized by base URL and API key, so Zen,
// Go, Ollama, and the OpenAI/Anthropic contract-fixture servers all share
// one factory path (Unit 6 approach). Structured output is attempted
// natively first (`generateText` with `output: Output.object(...)`, the
// v7-recommended replacement for the deprecated `generateObject`); a model
// that can't honor the schema falls back to a plain-text request repaired
// by the single shared `repair.ts` path, so "native vs repaired" is
// measured per model rather than assumed.

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import {
  createOpenAICompatible,
  type OpenAICompatibleChatLanguageModel,
} from "@ai-sdk/openai-compatible";
import {
  type Action,
  parseAction,
  redactSecrets,
} from "@panthea/tools-probes-shared";
import {
  APICallError,
  generateText,
  jsonSchema,
  type LanguageModel,
  Output,
  tool,
} from "ai";
import { repairAction } from "./repair";

export const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
export const OLLAMA_REACHABILITY_TIMEOUT_MS = 750;

// Zen/Go's documented third-party integration contract (docs/zen, docs/go):
// identify the client with its own User-Agent and send a stable session ID
// in `x-opencode-session` per conversation so requests route correctly.
// This is not a bypass of anything — it's the header shape the docs ask
// every non-OpenCode client to send, and Go actively rejects a request that
// omits it ("missing x-opencode-session"). One session ID per probe process
// run stands in for "one conversation".
const PROBE_SESSION_ID = crypto.randomUUID();
const PROBE_USER_AGENT = "panthea-provider-matrix-probe/0.1.0";

function defaultProviderHeaders(): Record<string, string> {
  return {
    "x-opencode-session": PROBE_SESSION_ID,
    "User-Agent": PROBE_USER_AGENT,
  };
}

export type ProviderFamily = "responses" | "chat-completions" | "messages";

export interface ProviderConfig {
  readonly family: ProviderFamily;
  readonly baseURL: string;
  readonly apiKey: string;
  readonly modelId: string;
  /** Label used only for the openai-compatible provider's internal `name` (never sent as a secret). */
  readonly providerName?: string;
  /** Extra headers merged over the default session/User-Agent headers (fixture/contract tests can override or omit). */
  readonly headers?: Record<string, string>;
}

/** Builds a `LanguageModel` for one of the three endpoint families this probe exercises. */
export function createProviderModel(config: ProviderConfig): LanguageModel {
  const headers = { ...defaultProviderHeaders(), ...config.headers };
  switch (config.family) {
    case "responses": {
      const provider = createOpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        headers,
      });
      return provider.responses(config.modelId);
    }
    case "chat-completions": {
      const provider = createOpenAICompatible({
        name: config.providerName ?? "openai-compatible",
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        headers,
      });
      return provider.chatModel(
        config.modelId,
      ) as OpenAICompatibleChatLanguageModel;
    }
    case "messages": {
      const provider = createAnthropic({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        headers,
      });
      return provider.messages(config.modelId);
    }
    default: {
      // Exhaustiveness guard — `config.family` is a closed union.
      const neverFamily: never = config.family;
      throw new Error(`unhandled provider family: ${String(neverFamily)}`);
    }
  }
}

/** Builds an Ollama-backed model via the openai-compatible adapter, if Ollama is reachable. */
export function createOllamaModel(modelId: string): LanguageModel {
  return createProviderModel({
    family: "chat-completions",
    baseURL: OLLAMA_BASE_URL,
    apiKey: "ollama",
    modelId,
    providerName: "ollama",
  });
}

/** Probes whether a local Ollama server answers on the loopback endpoint. Never throws. */
export async function isOllamaReachable(
  baseURL: string = OLLAMA_BASE_URL,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    OLLAMA_REACHABILITY_TIMEOUT_MS,
  );
  try {
    const response = await fetch(`${baseURL}/models`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// A JSON-schema mirror of the shared `Action` discriminated union
// (tools/probes/shared/src/schema.ts), used only as the structured-output
// target sent to a provider. The result is still re-validated through
// `parseAction` — this is guidance for the model, not the source of truth.
export const ACTION_JSON_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: { kind: { const: "move" }, target: {} },
      required: ["kind", "target"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "say" },
        to: { type: "string" },
        text: { type: "string" },
      },
      required: ["kind", "to", "text"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "trade" },
        with: { type: "string" },
        give: { type: "array" },
        receive: { type: "array" },
      },
      required: ["kind", "with", "give", "receive"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "strike" },
        target: { type: "string" },
        power: { type: "number" },
      },
      required: ["kind", "target", "power"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "idle" }, reason: { type: "string" } },
      required: ["kind"],
      additionalProperties: false,
    },
  ],
} as const;

const STRUCTURED_PROMPT_SUFFIX =
  "\n\nRespond with a single JSON object only, no prose, matching one of: " +
  '{"kind":"move","target":<entity id or {x,y}>}, ' +
  '{"kind":"say","to":<entity id>,"text":<string>}, ' +
  '{"kind":"trade","with":<entity id>,"give":[{"item":<string>,"qty":<number>}],"receive":[...]}, ' +
  '{"kind":"strike","target":<entity id>,"power":<number>}, ' +
  '{"kind":"idle","reason":<string>}.';

export type StructuredOutputMode = "native" | "repaired" | "failed";

export interface StructuredAttempt {
  readonly mode: StructuredOutputMode;
  readonly action?: Action;
  readonly rawText?: string;
  /** Always redacted before being stored. */
  readonly error?: string;
}

/**
 * Requests a validated {@link Action} from `model`: tries the native
 * structured-output path first, then falls back to a plain-text request
 * repaired by the shared `repair.ts`. Every error is redacted before it is
 * returned or stored.
 */
export async function requestStructuredAction(
  model: LanguageModel,
  prompt: string,
): Promise<StructuredAttempt> {
  try {
    const result = await generateText({
      model,
      prompt,
      output: Output.object({ schema: jsonSchema(ACTION_JSON_SCHEMA) }),
    });
    const parsed = parseAction(result.output);
    if (parsed.ok) {
      return { mode: "native", action: parsed.action };
    }
    // The provider honored the JSON schema shape but produced something
    // parseAction still rejects (e.g. an out-of-range field); fall through
    // to the repair path on the raw text below rather than failing outright.
  } catch {
    // Native structured output unsupported or rejected by this
    // provider/model; fall through to the text + repair path.
  }

  try {
    const textResult = await generateText({
      model,
      prompt: `${prompt}${STRUCTURED_PROMPT_SUFFIX}`,
    });
    const repaired = repairAction(textResult.text);
    if (repaired.ok) {
      return {
        mode: "repaired",
        action: repaired.action,
        rawText: textResult.text,
      };
    }
    return {
      mode: "failed",
      rawText: redactSecrets(textResult.text),
      error: redactSecrets(repaired.message),
    };
  } catch (error) {
    return { mode: "failed", error: redactSecrets(describeError(error)) };
  }
}

export interface ToolCallAttempt {
  readonly supported: boolean;
  readonly toolName?: string;
  readonly error?: string;
}

const PROPOSE_ACTION_TOOL_NAME = "propose_action";

/**
 * Requests one tool call from `model` using the same action schema as a
 * tool's input schema, and reports whether the model actually invoked it.
 */
export async function requestToolCall(
  model: LanguageModel,
  prompt: string,
): Promise<ToolCallAttempt> {
  try {
    const result = await generateText({
      model,
      prompt: `${prompt}\n\nCall the ${PROPOSE_ACTION_TOOL_NAME} tool with your decision.`,
      tools: {
        [PROPOSE_ACTION_TOOL_NAME]: tool({
          description: "Propose the next game action for this character.",
          inputSchema: jsonSchema(ACTION_JSON_SCHEMA),
          execute: async (input) => input,
        }),
      },
      toolChoice: "required",
    });
    if (result.toolCalls.length > 0) {
      return { supported: true, toolName: result.toolCalls[0]?.toolName };
    }
    return { supported: false, error: "model returned no tool call" };
  } catch (error) {
    return { supported: false, error: redactSecrets(describeError(error)) };
  }
}

export type ErrorClass =
  | "rate-limit"
  | "http-4xx"
  | "http-5xx"
  | "network"
  | "unknown";

/** Coarse, redacted classification of a provider error for matrix/fallback reporting. */
export function classifyError(error: unknown): ErrorClass {
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    if (status === 429) {
      return "rate-limit";
    }
    if (typeof status === "number" && status >= 500) {
      return "http-5xx";
    }
    if (typeof status === "number" && status >= 400) {
      return "http-4xx";
    }
  }
  const message = describeError(error).toLowerCase();
  if (message.includes("429") || message.includes("rate limit")) {
    return "rate-limit";
  }
  if (
    message.includes("econnrefused") ||
    message.includes("fetch failed") ||
    message.includes("network")
  ) {
    return "network";
  }
  return "unknown";
}

export function isRateLimitError(error: unknown): boolean {
  return classifyError(error) === "rate-limit";
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
