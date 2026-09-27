import { describe, expect, test } from "bun:test";
import { extractFirstJsonObject, repairAction } from "./repair";

const VALID_ACTION_JSON = '{"kind":"say","to":"zeus","text":"hail"}';

describe("extractFirstJsonObject", () => {
  test("extracts the JSON body from a fenced code block", () => {
    const text = `Here's my action:\n\`\`\`json\n${VALID_ACTION_JSON}\n\`\`\`\nDone.`;
    expect(extractFirstJsonObject(text)).toBe(VALID_ACTION_JSON);
  });

  test("extracts a balanced JSON object from prose with no fence", () => {
    const text = `I think the right move is ${VALID_ACTION_JSON} — let me know.`;
    expect(extractFirstJsonObject(text)).toBe(VALID_ACTION_JSON);
  });

  test("returns undefined when no JSON object is present", () => {
    expect(extractFirstJsonObject("no json here at all")).toBeUndefined();
  });

  test("handles nested braces without truncating early", () => {
    const nested =
      '{"kind":"trade","with":"hermes","give":[{"item":"wine","qty":1}],"receive":[]}';
    const text = `\`\`\`json\n${nested}\n\`\`\``;
    expect(extractFirstJsonObject(text)).toBe(nested);
  });
});

describe("repairAction", () => {
  test("repairs a fenced JSON reply into the same action across call sites", () => {
    const fenced = `\`\`\`json\n${VALID_ACTION_JSON}\n\`\`\``;
    const prose = `My decision: ${VALID_ACTION_JSON}`;

    const fromFenced = repairAction(fenced);
    const fromProse = repairAction(prose);

    expect(fromFenced.ok).toBe(true);
    expect(fromProse.ok).toBe(true);
    expect(fromFenced).toEqual(fromProse);
    if (fromFenced.ok) {
      expect(fromFenced.action).toEqual({
        kind: "say",
        to: "zeus",
        text: "hail",
      });
    }
  });

  test("a reply with no valid action fails the same way regardless of shape", () => {
    const noJson = repairAction("I refuse to answer in JSON.");
    const badAction = repairAction('```json\n{"kind":"fly"}\n```');

    expect(noJson.ok).toBe(false);
    expect(badAction.ok).toBe(false);
  });

  test("malformed JSON inside a fence fails cleanly", () => {
    const result = repairAction('```json\n{"kind":"say", "to": \n```');
    expect(result.ok).toBe(false);
  });
});
