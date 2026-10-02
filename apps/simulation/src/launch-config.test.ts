import { expect, test } from "bun:test";
import { parseLaunchConfig } from "./launch-config";

const SENTINEL = "sk-sentinel-DO-NOT-LEAK-0123456789";

const MODELS = {
  endpoints: [
    {
      id: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3.2-3b-4k",
    },
  ],
  roles: { zeus: { endpoint: "ollama" } },
};

test("an empty config object means no settings: no routing, online, no keys, no problem", () => {
  const launch = parseLaunchConfig("{}");
  expect(launch.routing).toBeUndefined();
  expect(launch.offline).toBe(false);
  expect([...launch.keys]).toEqual([]);
  expect(launch.problem).toBeUndefined();
});

test("null models is the shell's no-settings line", () => {
  const launch = parseLaunchConfig('{"models":null,"offline":false,"keys":{}}');
  expect(launch.routing).toBeUndefined();
  expect(launch.problem).toBeUndefined();
});

test("a valid models object parses into a routing config, with the offline flag and keys carried", () => {
  const launch = parseLaunchConfig(
    JSON.stringify({
      models: MODELS,
      offline: true,
      keys: { "hosted-key": SENTINEL },
    }),
  );
  expect([...(launch.routing?.endpoints.keys() ?? [])]).toEqual(["ollama"]);
  expect(launch.routing?.roles.get("zeus")?.endpoint).toBe("ollama");
  expect(launch.offline).toBe(true);
  expect(launch.keys.get("hosted-key")).toBe(SENTINEL);
  expect(launch.problem).toBeUndefined();
});

test("models that do not parse turn god turns off and name the parse error", () => {
  const launch = parseLaunchConfig(
    JSON.stringify({ models: { endpoints: 3 }, offline: false, keys: {} }),
  );
  expect(launch.routing).toBeUndefined();
  expect(launch.problem).toMatch(/model settings are not valid: .*endpoints/);
});

test("a settings value that is not an object is a problem, not a crash", () => {
  const launch = parseLaunchConfig(
    JSON.stringify({ models: "unreadable", keys: {} }),
  );
  expect(launch.routing).toBeUndefined();
  expect(launch.problem).toMatch(/model settings are not valid/);
});

test("a non-boolean offline flag is a problem and leaves the world online with god turns off", () => {
  const launch = parseLaunchConfig(
    JSON.stringify({ models: MODELS, offline: "yes", keys: {} }),
  );
  expect(launch.routing).toBeUndefined();
  expect(launch.offline).toBe(false);
  expect(launch.problem).toMatch(/offline/);
});

test("keys that are not a string map are a problem", () => {
  const launch = parseLaunchConfig(
    JSON.stringify({ models: MODELS, keys: { a: 1 } }),
  );
  expect(launch.routing).toBeUndefined();
  expect(launch.problem).toMatch(/keys/);
});

test("a line that is not JSON or not an object is a problem that does not echo the line", () => {
  for (const line of [
    `not json ${SENTINEL}`,
    `"${SENTINEL}"`,
    `[${JSON.stringify(SENTINEL)}]`,
  ]) {
    const launch = parseLaunchConfig(line);
    expect(launch.routing).toBeUndefined();
    expect(launch.problem).toBeDefined();
    expect(launch.problem).not.toContain(SENTINEL);
  }
});

test("no problem message ever contains a key, even when the models are invalid", () => {
  const launch = parseLaunchConfig(
    JSON.stringify({
      models: { endpoints: 3 },
      offline: "nope",
      keys: { k: SENTINEL, bad: 7 },
    }),
  );
  expect(launch.problem).toBeDefined();
  expect(launch.problem).not.toContain(SENTINEL);
});
