// Server adapters for the two local inference backends this probe measures:
//
// - Ollama: native `/api/chat` (NOT the OpenAI-compatible `/v1/chat/completions`).
//   This is a deliberate deviation from "use the OpenAI-compatible endpoint" —
//   Ollama's own docs state the OpenAI-compatible endpoint has no way to set
//   context size per request (it requires baking `num_ctx` into a Modelfile
//   derived model). The native endpoint accepts `options.num_ctx` per request
//   and the identical JSON Schema object via its `format` field that
//   `response_format.json_schema.schema` would carry on the OpenAI-compatible
//   endpoint (verified against ollama/ollama's openai.go conversion: `case
//   "json_schema": format = r.ResponseFormat.JsonSchema.Schema`), so schema
//   comparability with llama-server and, later, Unit 6's provider adapters is
//   unaffected — only the transport differs.
// - llama-server: OpenAI-compatible `/v1/chat/completions` with
//   `response_format: {type: "json_schema", ...}` (its only interface;
//   context size is fixed at process startup via `-c`).
//
// Both stream the response to measure time-to-first-token (TTFT) alongside
// total completion latency, and never throw: connection failure, non-2xx,
// and timeout all resolve to a typed `ChatFailure` so a mid-run server outage
// is a recorded result, not a crashed process.

export interface ChatMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  /** JSON Schema for structured output; omitted for the prompt-only fallback path. */
  readonly jsonSchema?: unknown;
  /** Ollama-only: per-request context window (`options.num_ctx`). */
  readonly contextTokens?: number;
  readonly maxTokens: number;
  readonly timeoutMs: number;
}

export interface ChatSuccess {
  readonly ok: true;
  readonly content: string;
  readonly ttftMs: number;
  readonly totalMs: number;
  readonly promptTokens: number | undefined;
  readonly completionTokens: number | undefined;
  /** Server-reported tokens/sec when the wire format includes it (Ollama's
   * `eval_count`/`eval_duration`); undefined for llama-server, which doesn't
   * expose this via the OpenAI-compatible SSE stream used here. */
  readonly serverTokPerSec: number | undefined;
}

export interface ChatFailure {
  readonly ok: false;
  readonly kind: "timeout" | "network-error" | "http-error";
  readonly message: string;
  readonly totalMs: number;
}

export type ChatResult = ChatSuccess | ChatFailure;

export interface ChatServer {
  readonly name: string;
  readonly baseUrl: string;
  readonly supportsNativeSchema: boolean;
  chat(request: ChatRequest): Promise<ChatResult>;
}

function computeTokPerSec(
  tokens: number | undefined,
  durationMs: number,
): number | undefined {
  if (tokens === undefined || durationMs <= 0) {
    return undefined;
  }
  return tokens / (durationMs / 1000);
}

async function withTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Reads newline-delimited JSON (Ollama native stream) line by line. */
async function* readNdjsonLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          yield line;
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }
    if (buffer.trim().length > 0) {
      yield buffer.trim();
    }
  } finally {
    reader.releaseLock();
  }
}

/** Reads Server-Sent Events `data: ...` lines (OpenAI-compatible stream). */
async function* readSseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  for await (const line of readNdjsonLines(body)) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const payload = line.slice("data:".length).trim();
    if (payload === "[DONE]") {
      return;
    }
    if (payload.length > 0) {
      yield payload;
    }
  }
}

interface OllamaNativeChunk {
  readonly message?: { readonly content?: string };
  readonly done?: boolean;
  readonly prompt_eval_count?: number;
  readonly eval_count?: number;
  readonly eval_duration?: number;
}

/** Ollama's native `/api/chat` — see module doc comment for why this is
 * used instead of the OpenAI-compatible endpoint. */
export function createOllamaServer(baseUrl: string): ChatServer {
  return {
    name: "ollama",
    baseUrl,
    supportsNativeSchema: true,
    async chat(request: ChatRequest): Promise<ChatResult> {
      const startedAt = performance.now();
      try {
        return await withTimeout(request.timeoutMs, async (signal) => {
          const response = await fetch(`${baseUrl}/api/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal,
            body: JSON.stringify({
              model: request.model,
              messages: request.messages,
              stream: true,
              // Reasoning-capable models (e.g. Qwen3.5) default to emitting
              // hidden <think> tokens in a separate `thinking` field before
              // `content` — with a short `num_predict` budget those tokens
              // can consume the whole budget and leave `content` empty
              // (measured directly during this probe's development; see the
              // README's Findings). This bench measures action-proposal
              // latency, not chain-of-thought quality, so thinking is off.
              think: false,
              format: request.jsonSchema,
              options: {
                num_ctx: request.contextTokens,
                num_predict: request.maxTokens,
              },
            }),
          });
          if (!response.ok || !response.body) {
            return {
              ok: false,
              kind: "http-error",
              message: `HTTP ${response.status}`,
              totalMs: performance.now() - startedAt,
            };
          }
          let content = "";
          let ttftMs: number | undefined;
          let promptTokens: number | undefined;
          let completionTokens: number | undefined;
          let evalDurationNs: number | undefined;
          for await (const line of readNdjsonLines(response.body)) {
            const chunk = JSON.parse(line) as OllamaNativeChunk;
            const delta = chunk.message?.content ?? "";
            if (delta.length > 0 && ttftMs === undefined) {
              ttftMs = performance.now() - startedAt;
            }
            content += delta;
            if (chunk.done) {
              promptTokens = chunk.prompt_eval_count;
              completionTokens = chunk.eval_count;
              evalDurationNs = chunk.eval_duration;
            }
          }
          const totalMs = performance.now() - startedAt;
          const serverTokPerSec =
            completionTokens !== undefined &&
            evalDurationNs !== undefined &&
            evalDurationNs > 0
              ? completionTokens / (evalDurationNs / 1e9)
              : undefined;
          return {
            ok: true,
            content,
            ttftMs: ttftMs ?? totalMs,
            totalMs,
            promptTokens,
            completionTokens,
            serverTokPerSec,
          };
        });
      } catch (error) {
        const totalMs = performance.now() - startedAt;
        if (isAbortError(error)) {
          return {
            ok: false,
            kind: "timeout",
            message: "request timed out",
            totalMs,
          };
        }
        return {
          ok: false,
          kind: "network-error",
          message: error instanceof Error ? error.message : String(error),
          totalMs,
        };
      }
    },
  };
}

interface OpenAiSseChunk {
  readonly choices?: ReadonlyArray<{
    readonly delta?: { readonly content?: string };
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
}

/** llama-server's OpenAI-compatible `/v1/chat/completions`. */
export function createLlamaServerServer(baseUrl: string): ChatServer {
  return {
    name: "llama-server",
    baseUrl,
    supportsNativeSchema: true,
    async chat(request: ChatRequest): Promise<ChatResult> {
      const startedAt = performance.now();
      try {
        return await withTimeout(request.timeoutMs, async (signal) => {
          const response = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal,
            body: JSON.stringify({
              model: request.model,
              messages: request.messages,
              stream: true,
              stream_options: { include_usage: true },
              max_tokens: request.maxTokens,
              response_format: request.jsonSchema
                ? {
                    type: "json_schema",
                    json_schema: { name: "action", schema: request.jsonSchema },
                  }
                : undefined,
            }),
          });
          if (!response.ok || !response.body) {
            return {
              ok: false,
              kind: "http-error",
              message: `HTTP ${response.status}`,
              totalMs: performance.now() - startedAt,
            };
          }
          let content = "";
          let ttftMs: number | undefined;
          let promptTokens: number | undefined;
          let completionTokens: number | undefined;
          for await (const data of readSseData(response.body)) {
            const chunk = JSON.parse(data) as OpenAiSseChunk;
            const delta = chunk.choices?.[0]?.delta?.content ?? "";
            if (delta.length > 0 && ttftMs === undefined) {
              ttftMs = performance.now() - startedAt;
            }
            content += delta;
            if (chunk.usage) {
              promptTokens = chunk.usage.prompt_tokens;
              completionTokens = chunk.usage.completion_tokens;
            }
          }
          const totalMs = performance.now() - startedAt;
          return {
            ok: true,
            content,
            ttftMs: ttftMs ?? totalMs,
            totalMs,
            promptTokens,
            completionTokens,
            serverTokPerSec: undefined,
          };
        });
      } catch (error) {
        const totalMs = performance.now() - startedAt;
        if (isAbortError(error)) {
          return {
            ok: false,
            kind: "timeout",
            message: "request timed out",
            totalMs,
          };
        }
        return {
          ok: false,
          kind: "network-error",
          message: error instanceof Error ? error.message : String(error),
          totalMs,
        };
      }
    },
  };
}

/**
 * Extracts the first balanced JSON object substring from arbitrary model
 * output — handling a fenced ```json block or prose wrapping around the
 * object — for the prompt-only fallback path. Returns `undefined` if no
 * balanced object is found. This is the same extract-then-parse repair rule
 * Unit 6's provider-matrix probe applies to hosted-adapter output, so a
 * repaired result is comparable across local and hosted paths.
 */
export function extractFirstJsonObject(text: string): string | undefined {
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const source = fenceMatch ? fenceMatch[1] : text;
  const start = source.indexOf("{");
  if (start === -1) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === "\\") {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

export { computeTokPerSec };
