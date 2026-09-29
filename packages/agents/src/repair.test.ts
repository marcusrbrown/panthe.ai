import { describe, expect, test } from "bun:test";
import type { ParseResult } from "./config";
import { extractJsonObjects, repairIntent } from "./repair";

interface Say {
  readonly kind: "say";
  readonly text: string;
}

function parseSay(candidate: unknown): ParseResult<Say> {
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    (candidate as { kind?: unknown }).kind === "say" &&
    typeof (candidate as { text?: unknown }).text === "string"
  ) {
    return {
      ok: true,
      value: { kind: "say", text: (candidate as { text: string }).text },
    };
  }
  return { ok: false, path: "", message: "not a say intent" };
}

const SAY = '{"kind":"say","text":"hail"}';

describe("extractJsonObjects", () => {
  test("takes the object from a fenced block, with or without a language tag", () => {
    expect(
      extractJsonObjects(`Here:\n\`\`\`json\n${SAY}\n\`\`\`\nDone.`),
    ).toEqual([SAY]);
    expect(extractJsonObjects(`\`\`\`\n${SAY}\n\`\`\``)).toEqual([SAY]);
  });

  test("takes a balanced object out of prose", () => {
    expect(extractJsonObjects(`My decision is ${SAY} -- thanks.`)).toEqual([
      SAY,
    ]);
  });

  test("returns nothing when there is no object", () => {
    expect(extractJsonObjects("no json here")).toEqual([]);
    expect(extractJsonObjects("an unclosed { brace")).toEqual([]);
  });

  test("does not close an object early on a brace inside a string, or on an escaped quote", () => {
    const tricky = '{"kind":"say","text":"a } and a \\" quote { too"}';

    expect(extractJsonObjects(`Sure: ${tricky} ok`)).toEqual([tricky]);
  });

  test("keeps nested objects whole", () => {
    const nested = '{"kind":"trade","give":[{"item":"wine","qty":1}]}';

    expect(extractJsonObjects(`\`\`\`json\n${nested}\n\`\`\``)).toEqual([
      nested,
    ]);
  });

  test("lists every top-level object in order, fenced ones first", () => {
    const text = `Ignore {this}. \`\`\`json\n${SAY}\n\`\`\` and {"other":1}`;

    expect(extractJsonObjects(text)).toEqual([SAY, "{this}", '{"other":1}']);
  });
});

describe("repairIntent", () => {
  test("repairs a fenced reply and a prose-wrapped reply into the same intent", () => {
    const fenced = repairIntent(`\`\`\`json\n${SAY}\n\`\`\``, parseSay);
    const prose = repairIntent(`I would say ${SAY}, I think.`, parseSay);

    expect(fenced).toEqual({ ok: true, value: { kind: "say", text: "hail" } });
    expect(prose).toEqual(fenced);
  });

  test("skips prose braces and repairs the first object the schema accepts", () => {
    const result = repairIntent(`Note {not json} then ${SAY}`, parseSay);

    expect(result).toEqual({ ok: true, value: { kind: "say", text: "hail" } });
  });

  test("a reply with no object fails with a message that says so", () => {
    const result = repairIntent("I refuse to answer in JSON.", parseSay);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("no JSON object");
    }
  });

  test("malformed JSON inside a fence fails cleanly, never throws", () => {
    const result = repairIntent(
      '```json\n{"kind":"say", "text": \n```',
      parseSay,
    );

    expect(result.ok).toBe(false);
  });

  test("valid JSON that the schema rejects fails with the schema's own reason", () => {
    const result = repairIntent('{"kind":"fly"}', parseSay);

    expect(result).toEqual({
      ok: false,
      path: "",
      message: "not a say intent",
    });
  });
});
