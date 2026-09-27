// Adapter tests against a local `Bun.serve` stub — no network, everything is
// loopback on a random free port (`port: 0`). These exercise the streaming
// wire paths `parity.test.ts`'s hand-written outputs never touch: real TTFT
// measured at the first content chunk of a real stream, a request timeout
// via AbortController, and a mid-stream connection failure — for both the
// Ollama native adapter (NDJSON) and the llama-server OpenAI-compatible
// adapter (SSE).

import { afterEach, describe, expect, test } from "bun:test";
import { createLlamaServerServer, createOllamaServer } from "./servers";

type Stub = ReturnType<typeof Bun.serve>;

let activeStub: Stub | undefined;

afterEach(() => {
  activeStub?.stop(true);
  activeStub = undefined;
});

function ndjsonLine(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

function sseData(value: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
}

function sseDone(): Uint8Array {
  return new TextEncoder().encode("data: [DONE]\n\n");
}

describe("createOllamaServer (native /api/chat, NDJSON stream stub)", () => {
  test("streamed success measures TTFT at the first content chunk and aggregates usage", async () => {
    activeStub = Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            // Realistic shape: an initial empty-content chunk (role
            // announce), then real content, split across chunks so a naive
            // "first chunk = TTFT" implementation would be wrong.
            controller.enqueue(ndjsonLine({ message: { content: "" } }));
            await Bun.sleep(30);
            controller.enqueue(
              ndjsonLine({ message: { content: '{"kind":' } }),
            );
            await Bun.sleep(15);
            controller.enqueue(ndjsonLine({ message: { content: '"idle"}' } }));
            controller.enqueue(
              ndjsonLine({
                done: true,
                prompt_eval_count: 12,
                eval_count: 6,
                eval_duration: 120_000_000, // 6 tokens / 0.12s = 50 tok/s
              }),
            );
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "content-type": "application/x-ndjson" },
        });
      },
    });

    const client = createOllamaServer(`http://localhost:${activeStub.port}`);
    const result = await client.chat({
      model: "stub",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 50,
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.content).toBe('{"kind":"idle"}');
    // TTFT must be measured at the first *non-empty* content chunk (after
    // the ~30ms delay), not the immediate empty-content chunk at t=0.
    expect(result.ttftMs).toBeGreaterThanOrEqual(25);
    expect(result.ttftMs).toBeLessThanOrEqual(result.totalMs);
    expect(result.promptTokens).toBe(12);
    expect(result.completionTokens).toBe(6);
    expect(result.serverTokPerSec).toBeCloseTo(50, 0);
  });

  test("a request that never responds within timeoutMs resolves to a typed timeout, not a throw", async () => {
    activeStub = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(2000);
        return new Response("");
      },
    });

    const client = createOllamaServer(`http://localhost:${activeStub.port}`);
    const result = await client.chat({
      model: "stub",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 50,
      timeoutMs: 100,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.kind).toBe("timeout");
  });

  test("a stream that errors mid-flight resolves to a network-error failure, not a throw", async () => {
    activeStub = Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(ndjsonLine({ message: { content: "partial" } }));
            controller.error(new Error("simulated mid-stream failure"));
          },
        });
        return new Response(stream, {
          headers: { "content-type": "application/x-ndjson" },
        });
      },
    });

    const client = createOllamaServer(`http://localhost:${activeStub.port}`);
    const result = await client.chat({
      model: "stub",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 50,
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.kind).toBe("network-error");
  });
});

describe("createLlamaServerServer (OpenAI-compatible /v1/chat/completions, SSE stub)", () => {
  test("streamed success measures TTFT at the first delta chunk and aggregates usage", async () => {
    activeStub = Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            // OpenAI-compatible streams commonly send a role-only first
            // chunk with an empty/absent delta.content before real content.
            controller.enqueue(
              sseData({ choices: [{ delta: { content: "" } }] }),
            );
            await Bun.sleep(30);
            controller.enqueue(
              sseData({ choices: [{ delta: { content: '{"kind":' } }] }),
            );
            await Bun.sleep(15);
            controller.enqueue(
              sseData({ choices: [{ delta: { content: '"idle"}' } }] }),
            );
            controller.enqueue(
              sseData({
                choices: [],
                usage: { prompt_tokens: 12, completion_tokens: 6 },
              }),
            );
            controller.enqueue(sseDone());
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const client = createLlamaServerServer(
      `http://localhost:${activeStub.port}`,
    );
    const result = await client.chat({
      model: "stub",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 50,
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.content).toBe('{"kind":"idle"}');
    expect(result.ttftMs).toBeGreaterThanOrEqual(25);
    expect(result.ttftMs).toBeLessThanOrEqual(result.totalMs);
    expect(result.promptTokens).toBe(12);
    expect(result.completionTokens).toBe(6);
    // llama-server's SSE stream doesn't expose a server-reported tok/s in
    // this adapter (see servers.ts's doc comment on `serverTokPerSec`).
    expect(result.serverTokPerSec).toBeUndefined();
  });

  test("a request that never responds within timeoutMs resolves to a typed timeout, not a throw", async () => {
    activeStub = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(2000);
        return new Response("");
      },
    });

    const client = createLlamaServerServer(
      `http://localhost:${activeStub.port}`,
    );
    const result = await client.chat({
      model: "stub",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 50,
      timeoutMs: 100,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.kind).toBe("timeout");
  });

  test("a stream that errors mid-flight resolves to a network-error failure, not a throw", async () => {
    activeStub = Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              sseData({ choices: [{ delta: { content: "partial" } }] }),
            );
            controller.error(new Error("simulated mid-stream failure"));
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const client = createLlamaServerServer(
      `http://localhost:${activeStub.port}`,
    );
    const result = await client.chat({
      model: "stub",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 50,
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.kind).toBe("network-error");
  });
});
