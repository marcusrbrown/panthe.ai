import { afterEach, describe, expect, test } from "bun:test";
import type { Action } from "@panthea/tools-probes-shared";
import { APICallError } from "ai";
import {
  type DegradedEvent,
  MAX_ATTEMPTS_PER_STEP,
  RETRY_BACKOFF_MS,
  ROUTINE_ONLY_ACTION,
  runFallback,
} from "./fallback";

interface StubServer {
  readonly url: string;
  stop(): void;
}

interface CountingStub {
  readonly server: StubServer;
  readonly requestCount: () => number;
}

/** A Bun.serve stub that returns a fixed status/body on every request and counts requests. */
function serveStatus(
  status: number,
  body: unknown = { error: "stub" },
): CountingStub {
  let requestCount = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      requestCount += 1;
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    server: {
      url: `http://127.0.0.1:${server.port}`,
      stop: () => server.stop(),
    },
    requestCount: () => requestCount,
  };
}

const SUCCESS_ACTION: Action = { kind: "idle", reason: "observed" };

const servers: StubServer[] = [];
function track(server: StubServer): StubServer {
  servers.push(server);
  return server;
}

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.stop();
  }
});

/** Fetches a stub endpoint and throws an `APICallError` for a non-2xx response. */
async function attemptAgainstStub(url: string): Promise<Action> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new APICallError({
      message: `stub returned ${response.status}`,
      url,
      requestBodyValues: {},
      statusCode: response.status,
    });
  }
  return (await response.json()) as Action;
}

describe("runFallback", () => {
  test("primary 503 falls back to a succeeding secondary; chain order recorded", async () => {
    const failing = serveStatus(503);
    track(failing.server);
    const succeeding = serveStatus(200, SUCCESS_ACTION);
    track(succeeding.server);

    const result = await runFallback([
      { name: "zen", attempt: () => attemptAgainstStub(failing.server.url) },
      { name: "go", attempt: () => attemptAgainstStub(succeeding.server.url) },
    ]);

    expect(result.degraded).toBe(false);
    expect(result.action).toEqual(SUCCESS_ACTION);
    expect(result.trace.map((entry) => entry.step)).toEqual(["zen", "go"]);
    expect(result.trace[0]).toMatchObject({
      step: "zen",
      outcome: "failed",
      attempts: MAX_ATTEMPTS_PER_STEP,
      errorClass: "http-5xx",
    });
    expect(result.trace[1]).toMatchObject({
      step: "go",
      outcome: "success",
      attempts: 1,
    });
  });

  test("every step failing emits exactly one degraded event and returns routine-only", async () => {
    const zen = serveStatus(503);
    track(zen.server);
    const go = serveStatus(503);
    track(go.server);
    const ollama = serveStatus(503);
    track(ollama.server);

    let degradedCount = 0;
    let lastEvent: DegradedEvent | undefined;
    const result = await runFallback(
      [
        { name: "zen", attempt: () => attemptAgainstStub(zen.server.url) },
        { name: "go", attempt: () => attemptAgainstStub(go.server.url) },
        {
          name: "ollama",
          attempt: () => attemptAgainstStub(ollama.server.url),
        },
      ],
      (event) => {
        degradedCount += 1;
        lastEvent = event;
      },
    );

    expect(degradedCount).toBe(1);
    expect(lastEvent?.action).toEqual(ROUTINE_ONLY_ACTION);
    expect(result.degraded).toBe(true);
    expect(result.action).toEqual(ROUTINE_ONLY_ACTION);
    for (const entry of result.trace) {
      expect(entry.attempts).toBe(MAX_ATTEMPTS_PER_STEP);
      expect(entry.outcome).toBe("failed");
    }
    // Every step exhausted its bounded retries — none looped beyond the cap.
    expect(zen.requestCount()).toBe(MAX_ATTEMPTS_PER_STEP);
    expect(go.requestCount()).toBe(MAX_ATTEMPTS_PER_STEP);
    expect(ollama.requestCount()).toBe(MAX_ATTEMPTS_PER_STEP);
  });

  test("a 429 is classified and retried with the same flat backoff as any other failure", async () => {
    const rateLimited = serveStatus(429, { error: "rate limited" });
    track(rateLimited.server);

    const start = performance.now();
    const result = await runFallback(
      [
        {
          name: "zen",
          attempt: () => attemptAgainstStub(rateLimited.server.url),
        },
      ],
      undefined,
      { maxAttemptsPerStep: 4, retryBackoffMs: 20 },
    );
    const elapsedMs = performance.now() - start;

    expect(result.trace[0]).toMatchObject({
      step: "zen",
      outcome: "failed",
      attempts: 4,
      errorClass: "rate-limit",
    });
    // Flat backoff: 3 intervals of ~20ms each (~60ms), not exponential
    // growth (which would be well over 100ms for 3 doublings from 20ms).
    expect(elapsedMs).toBeGreaterThanOrEqual(3 * 20 - 10);
    expect(elapsedMs).toBeLessThan(3 * 20 * 3);
  });

  test("default production backoff is a small fixed constant, not a growing series", () => {
    expect(RETRY_BACKOFF_MS).toBeLessThan(1000);
    expect(MAX_ATTEMPTS_PER_STEP).toBeGreaterThanOrEqual(1);
  });
});
