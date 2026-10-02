import { describe, expect, test } from "bun:test";
import { parseRoutingConfig } from "./config";
import { initialEndpointStatus, recordRouteOutcome } from "./status";

function config() {
  const parsed = parseRoutingConfig({
    endpoints: [
      { id: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "llama" },
      {
        id: "go",
        baseUrl: "https://hosted.example.com/v1",
        model: "big",
        keyRef: "go-key",
      },
    ],
    roles: { zeus: { endpoint: "ollama", fallback: ["go"] } },
  });
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

const failedStep = (endpoint: string, reason: string, detail: string) => ({
  endpoint,
  model: "m",
  attempts: 1,
  elapsedMs: 5,
  reason,
  detail,
});

describe("endpoint status", () => {
  test("every configured endpoint starts untried, in config order", () => {
    expect(initialEndpointStatus(config())).toEqual([
      { endpoint: "ollama", state: "untried" },
      { endpoint: "go", state: "untried" },
    ]);
  });

  test("an answered request marks the answering endpoint ok and each failed step failed with its reason", () => {
    const next = recordRouteOutcome(initialEndpointStatus(config()), {
      kind: "intent",
      step: {
        endpoint: "go",
        model: "big",
        attempts: 1,
        elapsedMs: 5,
        mode: "native",
      },
      failed: [failedStep("ollama", "network", "connection refused")],
      elapsedMs: 10,
    });
    expect(next).toEqual([
      {
        endpoint: "ollama",
        state: "failed",
        reason: "network",
        detail: "connection refused",
      },
      { endpoint: "go", state: "ok" },
    ]);
  });

  test("an exhausted chain marks every step it tried failed and leaves the rest as they were", () => {
    const before = recordRouteOutcome(initialEndpointStatus(config()), {
      kind: "intent",
      step: {
        endpoint: "go",
        model: "big",
        attempts: 1,
        elapsedMs: 1,
        mode: "native",
      },
      failed: [],
      elapsedMs: 1,
    });
    const next = recordRouteOutcome(before, {
      kind: "exhausted",
      steps: [failedStep("ollama", "timeout", "no reply within 15000 ms")],
      elapsedMs: 20,
    });
    expect(next).toEqual([
      {
        endpoint: "ollama",
        state: "failed",
        reason: "timeout",
        detail: "no reply within 15000 ms",
      },
      { endpoint: "go", state: "ok" },
    ]);
  });

  test("recovery: a later answer from a failed endpoint reports ok and drops the reason", () => {
    const failed = recordRouteOutcome(initialEndpointStatus(config()), {
      kind: "exhausted",
      steps: [failedStep("ollama", "network", "down")],
      elapsedMs: 1,
    });
    const recovered = recordRouteOutcome(failed, {
      kind: "intent",
      step: {
        endpoint: "ollama",
        model: "llama",
        attempts: 1,
        elapsedMs: 1,
        mode: "native",
      },
      failed: [],
      elapsedMs: 1,
    });
    expect(recovered[0]).toEqual({ endpoint: "ollama", state: "ok" });
  });

  test("does not mutate its input", () => {
    const before = initialEndpointStatus(config());
    const snapshot = JSON.stringify(before);
    recordRouteOutcome(before, {
      kind: "exhausted",
      steps: [failedStep("ollama", "network", "down")],
      elapsedMs: 1,
    });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  test("a step naming an endpoint that is not configured is ignored", () => {
    const next = recordRouteOutcome(initialEndpointStatus(config()), {
      kind: "exhausted",
      steps: [failedStep("ghost", "network", "down")],
      elapsedMs: 1,
    });
    expect(next.map((entry) => entry.endpoint)).toEqual(["ollama", "go"]);
  });
});
