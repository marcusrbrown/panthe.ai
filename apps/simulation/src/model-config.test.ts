import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoutingConfig } from "./model-config";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "panthea-sim-model-config-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (contents: string) => {
  const path = join(dir, "models.json");
  writeFileSync(path, contents);
  return path;
};

test("with no PANTHEA_MODEL_CONFIG there is no routing config, so no god takes a turn", () => {
  expect(loadRoutingConfig({})).toBeUndefined();
  expect(loadRoutingConfig({ PANTHEA_MODEL_CONFIG: "" })).toBeUndefined();
});

test("a config file the operator points at is parsed into a routing config", () => {
  const path = write(
    JSON.stringify({
      endpoints: [
        {
          id: "ollama",
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "llama3.2-3b-4k",
        },
      ],
      roles: { zeus: { endpoint: "ollama" } },
    }),
  );
  const config = loadRoutingConfig({ PANTHEA_MODEL_CONFIG: path });
  expect([...(config?.endpoints.keys() ?? [])]).toEqual(["ollama"]);
  expect(config?.roles.get("zeus")?.endpoint).toBe("ollama");
});

test("a config that is missing, not JSON, or not a valid routing config stops startup with the reason, never silently idles the gods", () => {
  const missing = { PANTHEA_MODEL_CONFIG: join(dir, "nope.json") };
  expect(() => loadRoutingConfig(missing)).toThrow(/nope\.json/);
  expect(() =>
    loadRoutingConfig({ PANTHEA_MODEL_CONFIG: write("not json") }),
  ).toThrow(/JSON/);
  expect(() =>
    loadRoutingConfig({ PANTHEA_MODEL_CONFIG: write('{"endpoints": 3}') }),
  ).toThrow(/endpoints/);
});
