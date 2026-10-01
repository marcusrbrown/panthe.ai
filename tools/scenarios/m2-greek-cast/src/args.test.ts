import { expect, test } from "bun:test";
import { parseArgs } from "./args";

test("the model defaults to llama3.2 3B at 4K and reasoning is unset", () => {
  const args = parseArgs(["--real"]);
  expect(args.model).toBe("llama3.2-3b-4k");
  expect(args.reasoningEffort).toBeUndefined();
});

test("--model and --reasoning-effort=none apply to both the real run and the episodes", () => {
  const real = parseArgs([
    "--real",
    "--model=gemma4-e4b-4k",
    "--reasoning-effort=none",
  ]);
  expect(real).toMatchObject({
    real: true,
    model: "gemma4-e4b-4k",
    reasoningEffort: "none",
  });
  const episodes = parseArgs([
    "--episodes=1",
    "--episode-seconds=60",
    "--model=gemma4-e4b-4k",
    "--reasoning-effort=none",
  ]);
  expect(episodes).toMatchObject({
    episodes: 1,
    episodeSeconds: 60,
    model: "gemma4-e4b-4k",
    reasoningEffort: "none",
  });
});

test("a reasoning effort other than none, and an empty model, are refused", () => {
  expect(() => parseArgs(["--reasoning-effort=high"])).toThrow(
    /reasoning-effort/,
  );
  expect(() => parseArgs(["--reasoning-effort="])).toThrow(/reasoning-effort/);
  expect(() => parseArgs(["--model="])).toThrow(/--model/);
});

test("the existing flags still parse: episodes, seconds, out, skip-build, and a positive control", () => {
  expect(
    parseArgs([
      "--skip-build",
      "--episodes=3",
      "--out=/tmp/x",
      "--positive-control=chain",
    ]),
  ).toMatchObject({
    skipBuild: true,
    episodes: 3,
    episodeSeconds: 300,
    out: "/tmp/x",
    control: "chain",
  });
  expect(() => parseArgs(["--nonsense"])).toThrow(/unknown argument/);
  expect(() => parseArgs(["--episodes=0"])).toThrow(/positive/);
});
