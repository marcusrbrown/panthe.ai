import { expect, test } from "bun:test";
import {
  KeyMissing,
  launchConfigFor,
  OllamaUnreachable,
  prepareOllama,
  readKeychainKey,
  routingConfigFor,
} from "./real";

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

const SENTINEL = "sk-sentinel-DO-NOT-LEAK-0123456789";
const hosted = {
  ...options,
  baseUrl: "https://hosted.example.com/v1",
  keyRef: "hosted-key",
};

test("a hosted base URL is the endpoint's base URL as given, with the key reference and no key", () => {
  const config = routingConfigFor({
    ...hosted,
    keys: { "hosted-key": SENTINEL },
  }) as {
    endpoints: Record<string, unknown>[];
    roles: Record<string, { endpoint: string }>;
  };
  expect(config.endpoints[0]).toEqual({
    id: "hosted",
    baseUrl: "https://hosted.example.com/v1",
    model: "gemma4-e4b-4k",
    keyRef: "hosted-key",
  });
  expect(config.roles.zeus?.endpoint).toBe("hosted");
  expect(config.roles.hera?.endpoint).toBe("hosted");
  expect(JSON.stringify(config)).not.toContain(SENTINEL);
  // Control: no key reference given, none in the endpoint.
  const keyless = routingConfigFor({ ...options, baseUrl: hosted.baseUrl }) as {
    endpoints: Record<string, unknown>[];
  };
  expect(keyless.endpoints[0]).not.toHaveProperty("keyRef");
});

test("the launch line carries the key under its key reference, online, and nowhere else", () => {
  const launch = launchConfigFor({
    ...hosted,
    keys: { "hosted-key": SENTINEL },
  });
  expect(launch.keys).toEqual({ "hosted-key": SENTINEL });
  expect(launch.offline).toBe(false);
  expect(JSON.stringify(launch.models)).not.toContain(SENTINEL);
  // Control: the local default sends no keys.
  expect(launchConfigFor(options).keys).toEqual({});
});

test("a non-local base URL skips the Ollama model check, and a local one still makes it", async () => {
  // Nothing listens on port 1: a check would throw OllamaUnreachable.
  const unreachable = { ...options, ollama: "http://127.0.0.1:1" };
  await expect(
    prepareOllama({
      ...unreachable,
      baseUrl: "https://hosted.example.com/v1",
    }),
  ).resolves.toBeUndefined();
  // Controls: no base URL, and a local one, are still checked.
  await expect(prepareOllama(unreachable)).rejects.toBeInstanceOf(
    OllamaUnreachable,
  );
  await expect(
    prepareOllama({ ...unreachable, baseUrl: "http://127.0.0.1:8080/v1" }),
  ).rejects.toBeInstanceOf(OllamaUnreachable);
});

test("the key is read from the Keychain entry the shell writes, through an argv array, and one trailing newline is trimmed", async () => {
  const calls: (readonly string[])[] = [];
  const key = await readKeychainKey("hosted-key", async (argv) => {
    calls.push(argv);
    return { exitCode: 0, stdout: `${SENTINEL}\n` };
  });
  expect(key).toBe(SENTINEL);
  expect(calls).toEqual([
    [
      "security",
      "find-generic-password",
      "-s",
      "ai.panthe.desktop.endpoint-keys",
      "-a",
      "hosted-key",
      "-w",
    ],
  ]);
  // Only one newline goes; the key keeps any other whitespace.
  expect(
    await readKeychainKey("k", async () => ({
      exitCode: 0,
      stdout: " a b \n\n",
    })),
  ).toBe(" a b \n");
});

test("a missing or empty Keychain entry fails naming only the key reference", async () => {
  for (const result of [
    { exitCode: 44, stdout: `partial ${SENTINEL}` },
    { exitCode: 0, stdout: "\n" },
  ]) {
    const failure = await readKeychainKey(
      "hosted-key",
      async () => result,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KeyMissing);
    const message = (failure as Error).message;
    expect(message).toContain("hosted-key");
    expect(message).not.toContain(SENTINEL);
  }
});
