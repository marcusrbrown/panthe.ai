import { expect, test } from "bun:test";
import { homedir, userInfo } from "node:os";
import type { EnvironmentInfo } from "./env";
import { renderReport } from "./report";

function fixtureEnvironment(): EnvironmentInfo {
  return {
    hardware: { brand: "Apple M1 Pro", memoryBytes: "17179869184" },
    os: {
      productName: "macOS",
      productVersion: "15.7.9",
      buildVersion: "24G830",
    },
    bun: { version: "1.4.2" },
    pinned: {
      tauri: "2.12.0",
      three: "0.185.1",
      threeFlatland: "0.1.0-alpha.10",
    },
    extra: {},
  };
}

test("renderReport emits sections in the established order", () => {
  const markdown = renderReport({
    question: "Does X work?",
    howToRun: "bun run bench",
    caveat: "Ad-hoc signed only.",
    environment: fixtureEnvironment(),
    metrics: [{ name: "frame time", unit: "ms", samples: [10, 12, 14] }],
    findings: ["Works as expected."],
    bottomLine: "Ship it.",
  });

  const order = [
    "## Question",
    "## How to run",
    "## Caveat",
    "## Environment",
    "## Results",
    "## Findings",
    "## Bottom line",
  ];
  const indices = order.map((heading) => markdown.indexOf(heading));
  expect(indices.every((index) => index >= 0)).toBe(true);
  for (let i = 1; i < indices.length; i += 1) {
    expect(indices[i]).toBeGreaterThan(indices[i - 1] as number);
  }
});

test("a section is omitted when its input is absent (no caveat)", () => {
  const markdown = renderReport({
    question: "q",
    howToRun: "run",
    environment: fixtureEnvironment(),
    metrics: [],
    findings: [],
    bottomLine: "n/a",
  });
  expect(markdown).not.toContain("## Caveat");
});

test("renderReport replaces the home directory and username with placeholders", () => {
  const home = homedir();
  const username = userInfo().username;
  const markdown = renderReport({
    question: "test",
    howToRun: `run from ${home}`,
    environment: fixtureEnvironment(),
    metrics: [],
    findings: [`ran as ${username}`],
    bottomLine: "done",
  });

  expect(markdown).not.toContain(home);
  expect(markdown).not.toContain(username);
  expect(markdown).toContain("<HOME>");
  expect(markdown).toContain("<USER>");
});

test("empty metric samples render 'no samples' rather than NaN", () => {
  const markdown = renderReport({
    question: "q",
    howToRun: "run",
    environment: fixtureEnvironment(),
    metrics: [{ name: "latency", unit: "ms", samples: [] }],
    findings: [],
    bottomLine: "n/a",
  });
  expect(markdown).toContain("no samples");
  expect(markdown).not.toContain("NaN");
});
