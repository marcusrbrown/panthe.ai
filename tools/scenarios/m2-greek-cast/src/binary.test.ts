import { expect, test } from "bun:test";
import { resolveSidecarBinary } from "./binary";

const fakes = () => {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      build: () => {
        calls.push("build");
        return "/built/sidecar";
      },
      existing: () => {
        calls.push("existing");
        return "/existing/sidecar";
      },
    },
  };
};

test("without --skip-build the sidecar is rebuilt and the built binary is used", () => {
  const { calls, deps } = fakes();
  expect(resolveSidecarBinary(false, deps)).toBe("/built/sidecar");
  expect(calls).toEqual(["build"]);
});

test("with --skip-build the existing binary is used and nothing is built", () => {
  const { calls, deps } = fakes();
  expect(resolveSidecarBinary(true, deps)).toBe("/existing/sidecar");
  expect(calls).toEqual(["existing"]);
});
