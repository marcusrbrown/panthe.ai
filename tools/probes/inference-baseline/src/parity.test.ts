// Integration test scenario from the plan: the same recorded model output
// parses identically through the local response path (a JSON-schema
// constrained call returns a clean object, parsed directly) and the
// provider-probe-style repair path Unit 6's hosted adapters will share
// (extract first JSON object -> parseAction) — no network calls, every
// fixture is a recorded string.

import { describe, expect, test } from "bun:test";
import { parseAction } from "@panthea/tools-probes-shared";
import { extractFirstJsonObject } from "./servers";

interface RecordedPair {
  readonly name: string;
  /** Clean JSON, as a JSON-schema-constrained local call returns it. */
  readonly local: string;
  /** The same action, fenced or prose-wrapped, as a hosted adapter without
   * native structured output might return it. */
  readonly hosted: string;
}

const RECORDED_OUTPUTS: readonly RecordedPair[] = [
  {
    name: "move to an entity id",
    local: '{"kind":"move","target":"town-square"}',
    hosted:
      'Sure, here is the action:\n```json\n{"kind":"move","target":"town-square"}\n```',
  },
  {
    name: "move to coordinates",
    local: '{"kind":"move","target":{"x":12,"y":-4}}',
    hosted: 'The action is: {"kind":"move","target":{"x":12,"y":-4}} — done.',
  },
  {
    name: "say with punctuation in text",
    local: '{"kind":"say","to":"Hera","text":"I will consider it."}',
    hosted:
      '```json\n{"kind":"say","to":"Hera","text":"I will consider it."}\n```\nLet me know if you need anything else.',
  },
  {
    name: "trade with nested items",
    local:
      '{"kind":"trade","with":"Nikos","give":[{"item":"bread","qty":1}],"receive":[{"item":"fish","qty":2}]}',
    hosted:
      'The action is: {"kind":"trade","with":"Nikos","give":[{"item":"bread","qty":1}],"receive":[{"item":"fish","qty":2}]} — done.',
  },
  {
    name: "strike with numeric power",
    local: '{"kind":"strike","target":"old-oak-tree","power":7}',
    hosted: '```\n{"kind":"strike","target":"old-oak-tree","power":7}\n```',
  },
  {
    name: "idle with no reason",
    local: '{"kind":"idle"}',
    hosted: 'idle:\n{"kind":"idle"}',
  },
  {
    name: "idle with a reason",
    local: '{"kind":"idle","reason":"waiting for the storm to pass"}',
    hosted:
      '```json\n{"kind":"idle","reason":"waiting for the storm to pass"}\n```',
  },
];

describe("parity: local response path vs provider-probe-style repair path", () => {
  for (const fixture of RECORDED_OUTPUTS) {
    test(fixture.name, () => {
      // Local path: a JSON-schema-constrained call's content is valid JSON
      // already — parse it directly, exactly as bench.ts's "native" mode does.
      const localParsed = parseAction(JSON.parse(fixture.local));

      // Repair path: extract the first balanced JSON object, then the same
      // parseAction — exactly what Unit 6's provider adapters will do for a
      // hosted model without native structured output.
      const extracted = extractFirstJsonObject(fixture.hosted);
      expect(extracted).toBeDefined();
      // biome-ignore lint/style/noNonNullAssertion: asserted defined above
      const hostedParsed = parseAction(JSON.parse(extracted!));

      expect(localParsed.ok).toBe(true);
      expect(hostedParsed).toEqual(localParsed);
    });
  }

  test("an action with no valid kind fails identically through both paths", () => {
    const local = '{"kind":"fly","target":"moon"}';
    const hosted = '```json\n{"kind":"fly","target":"moon"}\n```';

    const localParsed = parseAction(JSON.parse(local));
    const extracted = extractFirstJsonObject(hosted);
    expect(extracted).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted defined above
    const hostedParsed = parseAction(JSON.parse(extracted!));

    expect(localParsed.ok).toBe(false);
    expect(hostedParsed).toEqual(localParsed);
  });

  test("no balanced JSON object anywhere in the output fails to extract", () => {
    expect(
      extractFirstJsonObject("I don't think I should act right now."),
    ).toBeUndefined();
  });
});
