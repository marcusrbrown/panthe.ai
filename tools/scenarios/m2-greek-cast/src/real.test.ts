import { expect, test } from "bun:test";
import { routingConfigFor } from "./real";

const options = {
  binary: "/b",
  durationMs: 1000,
  ollama: "http://127.0.0.1:11434",
  model: "gemma4-e4b-4k",
};

test("the endpoint config names the model, and carries reasoningEffort only when asked", () => {
  const without = routingConfigFor(options) as {
    endpoints: Record<string, unknown>[];
    roles: Record<string, { endpoint: string }>;
  };
  expect(without.endpoints[0]).toEqual({
    id: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "gemma4-e4b-4k",
  });
  expect(without.roles.zeus?.endpoint).toBe("ollama");
  expect(without.roles.hera?.endpoint).toBe("ollama");

  const withNone = routingConfigFor({
    ...options,
    reasoningEffort: "none",
  }) as { endpoints: Record<string, unknown>[] };
  expect(withNone.endpoints[0]).toEqual({
    id: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "gemma4-e4b-4k",
    reasoningEffort: "none",
  });
});
