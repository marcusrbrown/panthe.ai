import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SampleRow } from "./db";
import {
  chooseSample,
  renderSamplePrompt,
  type SampleSource,
  writeSamplePrompt,
} from "./sample-prompt";

const KEY = "sk-live-0123456789abcdef";

const row = (over: Partial<SampleRow> = {}): SampleRow => ({
  role: "zeus",
  outcome: "intent",
  promptPayload: "You are Zeus.\n\nYou are at the hall.\nWhat do you do?",
  outputPayload: '{"action":"wait"}',
  steps: [{ mode: "native" }],
  elapsedMs: 5400,
  ...over,
});

const WITH_PRACTICES = [
  "You are Zeus.",
  "",
  "Your open practices:",
  "- You may begin a bargain if you wish (nothing requires it); each of these is legal as written:",
  '  demand of hera (hera told you of it [evt-9-12]): {"action":"practice","move":"demand","cause":"evt-9-12","term":{"kind":"be-at","party":"hera","place":"great-hall","deadlineTicks":90}}',
  "You are at the hall.",
  "Prayers to you:",
  "- [evt-5-22] farmer asks for help with food (its food spoiled).",
  "  Your choices:",
  "  - or let it be: waiting is always allowed.",
  "What do you do?",
].join("\n");

const source = (
  rows: readonly SampleRow[],
  schema: unknown = { type: "object" },
): SampleSource => ({ rows, schemaFor: () => schema });

test("the sample is the first turn whose prompt carried a practices section, else the last answered turn", () => {
  const rows = [
    row({ role: "hera" }),
    row({ promptPayload: WITH_PRACTICES }),
    row({ role: "hera", promptPayload: WITH_PRACTICES }),
  ];
  expect(chooseSample(rows)).toMatchObject({ position: 1 });
  expect(chooseSample(rows)?.why).toContain("first prompt");
  const none = [row(), row({ role: "hera", promptPayload: "later" })];
  expect(chooseSample(none)).toMatchObject({ position: 1 });
  expect(chooseSample(none)?.why).toContain("none carried");
  // A turn that recorded no prompt is never the sample.
  expect(chooseSample([row({ promptPayload: undefined })])).toBeUndefined();
  expect(chooseSample([])).toBeUndefined();
});

test("the document holds the practices and prayers sections, the model's output, the schema, and the whole prompt", () => {
  const text = renderSamplePrompt(
    source([
      row({
        promptPayload: WITH_PRACTICES,
        outputPayload: '{"action":"practice"}',
      }),
    ]),
    { index: 2, total: 3 },
    [],
  );
  expect(text).toContain("# Episode 2 of 3: one zeus turn as the model saw it");
  const practices =
    text.split("## The practices section")[1]?.split("## ")[0] ?? "";
  expect(practices).toContain("Your open practices:");
  expect(practices).toContain('"move":"demand"');
  expect(practices).not.toContain("You are at the hall");
  const prayers =
    text.split("## The prayers section")[1]?.split("## ")[0] ?? "";
  expect(prayers).toContain("[evt-5-22] farmer asks for help");
  expect(prayers).toContain("let it be");
  expect(text).toContain('{"action":"practice"}');
  expect(text).toContain("as of the end of the run: the trace keeps no schema");
  expect(text).toContain('"type": "object"');
  expect(text.split("## The whole prompt")[1]).toContain(
    "You are at the hall.",
  );
});

test("a prompt with no practices or prayers says so rather than showing nothing, and a turn with no output says why", () => {
  const text = renderSamplePrompt(
    {
      rows: [row({ outputPayload: undefined })],
      schemaFor: () => undefined,
    },
    { index: 1, total: 1 },
    [],
  );
  expect(text).toContain('(no "Your open practices:" section in this prompt)');
  expect(text).toContain('(no "Prayers to you:" section in this prompt)');
  expect(text).toContain("(none: no endpoint gave a valid intent)");
  expect(text).toContain("(could not be drawn)");
  expect(renderSamplePrompt(source([]), { index: 1, total: 1 }, [])).toContain(
    "no sample",
  );
});

test("every key the run held is redacted wherever it appears: the prompt, the output, the schema, and a JSON-escaped form", () => {
  const dirty = row({
    promptPayload: `${WITH_PRACTICES}\nan echoed key ${KEY} here`,
    outputPayload: `{"action":"wait","note":"${KEY}"}`,
  });
  const text = renderSamplePrompt(
    source([dirty], {
      description: `uses ${KEY}`,
      quoted: JSON.stringify(KEY),
    }),
    { index: 1, total: 1 },
    [KEY],
  );
  expect(text).not.toContain(KEY);
  expect(text).toContain("[redacted]");
  // Control: with no key given, the same data shows the key (so the check above is the redaction's doing).
  expect(
    renderSamplePrompt(source([dirty]), { index: 1, total: 1 }, []),
  ).toContain(KEY);
});

test("the sample is written beside the episode as episode-N-sample-prompt.md, without the key", () => {
  const dir = mkdtempSync(join(tmpdir(), "panthea-sample-"));
  try {
    const file = writeSamplePrompt(
      dir,
      source([row({ promptPayload: `${WITH_PRACTICES}\n${KEY}` })]),
      { index: 3, total: 3 },
      [KEY],
    );
    expect(readdirSync(dir)).toEqual(["episode-3-sample-prompt.md"]);
    expect(file).toBe(join(dir, "episode-3-sample-prompt.md"));
    const written = readFileSync(file, "utf8");
    expect(written).toContain("Your open practices:");
    expect(written).not.toContain(KEY);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const REFUSED = row({
  outcome: "exhausted",
  outputPayload: undefined,
  promptPayload: WITH_PRACTICES,
  steps: [
    {
      reason: "invalid-output",
      detail: "move: move is missing; legal here: accept",
      attempts: 2,
      output: '{"action":"practice","thread":"evt-1-5"}',
      schema: '{"type":"object","title":"as asked"}',
    },
  ],
});

test("an exhausted request is sampled too, with what the model sent, how many attempts it had, and the schema it was asked under, not the end-of-run schema", () => {
  const text = renderSamplePrompt(
    source([row(), REFUSED], { type: "object", title: "end of run" }),
    { index: 1, total: 3 },
    [],
  );
  const refused = text.split("## A refused turn")[1] ?? "";
  expect(refused).toContain("zeus");
  expect(refused).toContain("2 attempts");
  expect(refused).toContain("move: move is missing; legal here: accept");
  expect(refused).toContain('{"action":"practice","thread":"evt-1-5"}');
  expect(refused).toContain('"title":"as asked"');
  expect(refused).not.toContain("end of run");
  expect(refused).toContain("as it was when the request was made");
});

test("the refused turn's reply and schema are redacted like the rest", () => {
  const leaky = {
    ...REFUSED,
    steps: [
      {
        reason: "invalid-output",
        detail: "no",
        attempts: 2,
        output: `echo ${KEY}`,
        schema: `{"d":"${KEY}"}`,
      },
    ],
  };
  const text = renderSamplePrompt(source([leaky]), { index: 1, total: 1 }, [
    KEY,
  ]);
  expect(text).not.toContain(KEY);
  expect(text).toContain("[redacted]");
});

test("with no refused request there is no refused section", () => {
  expect(
    renderSamplePrompt(source([row()]), { index: 1, total: 1 }, []),
  ).not.toContain("## A refused turn");
});
