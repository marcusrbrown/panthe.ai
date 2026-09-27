import { afterEach, describe, expect, test } from "bun:test";
import { APICallError } from "ai";
import anthropicFencedAction from "./fixtures/anthropic/messages-fenced-action.json";
import anthropicNoAction from "./fixtures/anthropic/messages-no-action.json";
import openaiFencedAction from "./fixtures/openai/responses-fenced-action.json";
import openaiNoAction from "./fixtures/openai/responses-no-action.json";
import {
  classifyError,
  createProviderModel,
  isOllamaReachable,
  requestStructuredAction,
  requestToolCall,
} from "./providers";

type FixtureServer = { readonly url: string; stop(): void };

function serveFixture(body: unknown, status = 200): FixtureServer {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop() };
}

const servers: FixtureServer[] = [];
function track(server: FixtureServer): FixtureServer {
  servers.push(server);
  return server;
}

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.stop();
  }
});

describe("requestStructuredAction (contract fixtures)", () => {
  test("OpenAI /responses and Anthropic /messages repair to the same action", async () => {
    const openaiServer = track(serveFixture(openaiFencedAction));
    const openaiModel = createProviderModel({
      family: "responses",
      baseURL: openaiServer.url,
      apiKey: "test-key",
      modelId: "gpt-5-nano",
    });
    const anthropicServer = track(serveFixture(anthropicFencedAction));
    const anthropicModel = createProviderModel({
      family: "messages",
      baseURL: anthropicServer.url,
      apiKey: "test-key",
      modelId: "claude-haiku-4-5",
    });

    const openaiResult = await requestStructuredAction(openaiModel, "decide");
    const anthropicResult = await requestStructuredAction(
      anthropicModel,
      "decide",
    );

    expect(openaiResult.action).toEqual(anthropicResult.action);
    expect(openaiResult.action).toEqual({
      kind: "say",
      to: "zeus",
      text: "hail, thunderer",
    });
  });

  test("a reply with no valid action fails identically across adapters", async () => {
    const openaiServer = track(serveFixture(openaiNoAction));
    const openaiModel = createProviderModel({
      family: "responses",
      baseURL: openaiServer.url,
      apiKey: "test-key",
      modelId: "gpt-5-nano",
    });
    const anthropicServer = track(serveFixture(anthropicNoAction));
    const anthropicModel = createProviderModel({
      family: "messages",
      baseURL: anthropicServer.url,
      apiKey: "test-key",
      modelId: "claude-haiku-4-5",
    });

    const openaiResult = await requestStructuredAction(openaiModel, "decide");
    const anthropicResult = await requestStructuredAction(
      anthropicModel,
      "decide",
    );

    expect(openaiResult.mode).toBe("failed");
    expect(anthropicResult.mode).toBe("failed");
    expect(openaiResult.action).toBeUndefined();
    expect(anthropicResult.action).toBeUndefined();
  });

  test("never surfaces a secret in a failure's rawText/error even if the fixture body echoed one", async () => {
    const leaking = {
      ...openaiNoAction,
      output: [
        {
          ...openaiNoAction.output[0],
          content: [
            {
              type: "output_text",
              text: "auth failed: Bearer sk-not-a-real-secret-value12345",
              annotations: [],
            },
          ],
        },
      ],
    };
    const server = track(serveFixture(leaking));
    const model = createProviderModel({
      family: "responses",
      baseURL: server.url,
      apiKey: "test-key",
      modelId: "gpt-5-nano",
    });
    const result = await requestStructuredAction(model, "decide");
    expect(result.rawText).not.toContain("sk-not-a-real-secret-value12345");
  });
});

describe("requestToolCall", () => {
  test("reports unsupported (not a throw) when the fixture server never returns a tool call", async () => {
    const server = track(serveFixture(openaiNoAction));
    const model = createProviderModel({
      family: "responses",
      baseURL: server.url,
      apiKey: "test-key",
      modelId: "gpt-5-nano",
    });
    const result = await requestToolCall(model, "decide");
    expect(result.supported).toBe(false);
  });
});

describe("isOllamaReachable", () => {
  test("returns true when the endpoint answers 200", async () => {
    const server = track(serveFixture({ models: [] }));
    expect(await isOllamaReachable(server.url)).toBe(true);
  });

  test("returns false (never throws) when nothing is listening", async () => {
    await expect(isOllamaReachable("http://127.0.0.1:1")).resolves.toBe(false);
  });
});

describe("classifyError", () => {
  test("classifies a 429 APICallError as rate-limit", () => {
    const error = new APICallError({
      message: "Too Many Requests",
      url: "https://example.test/v1/responses",
      requestBodyValues: {},
      statusCode: 429,
    });
    expect(classifyError(error)).toBe("rate-limit");
  });

  test("classifies a 503 APICallError as http-5xx", () => {
    const error = new APICallError({
      message: "Service Unavailable",
      url: "https://example.test/v1/responses",
      requestBodyValues: {},
      statusCode: 503,
    });
    expect(classifyError(error)).toBe("http-5xx");
  });

  test("classifies a connection-refused error as network", () => {
    expect(classifyError(new Error("fetch failed: ECONNREFUSED"))).toBe(
      "network",
    );
  });

  test("classifies an unrecognized error as unknown", () => {
    expect(classifyError(new Error("something odd happened"))).toBe("unknown");
  });
});
