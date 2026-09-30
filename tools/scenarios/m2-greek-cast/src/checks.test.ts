import { expect, test } from "bun:test";
import {
  differences,
  explainChain,
  isWait,
  type RememberedView,
  tracesIn,
} from "./checks";

test("tracesIn finds exactly the traces a prompt carries, and none when it carries none", () => {
  const prompt = "You see [evt-4-2] building-ignited at the-tavern.";
  expect(tracesIn(prompt, ["evt-4-2", "the-tavern", "evt-9-9"])).toEqual([
    "evt-4-2",
    "the-tavern",
  ]);
  // Control: a prompt with none of them is clean.
  expect(tracesIn("You are at The Square.", ["evt-4-2", "the-tavern"])).toEqual(
    [],
  );
});

test("isWait recognizes a wait reply and nothing else", () => {
  expect(isWait('{"action":"wait"}')).toBe(true);
  expect(isWait('{ "action": "wait" }')).toBe(true);
  expect(isWait('{"action":"legend","assertion":"x"}')).toBe(false);
  expect(isWait("not json")).toBe(false);
});

const memory = (id: string, salience = 4) => ({
  id,
  kind: "witnessed",
  sourceEventId: "evt-1-1",
  eventKind: "building-ignited",
  salience,
  recordedAt: 3,
  subjects: ["the-tavern"],
});
const relationship = (affinity: number) => ({
  from: "hera",
  toward: "zeus",
  affinity,
  grudge: 0,
  allied: false,
});

function view(
  memories: [string, unknown[]][],
  relationships: [string, unknown][],
): RememberedView {
  return {
    memories: new Map(memories),
    relationships: new Map(relationships),
  } as unknown as RememberedView;
}

test("differences is empty for equal memory and relationships, and names a dropped memory or a changed feeling", () => {
  const live = view(
    [["hera", [memory("evt-5-1"), memory("evt-6-1")]]],
    [["hera>zeus", relationship(-1)]],
  );
  expect(
    differences(
      live,
      view(
        [["hera", [memory("evt-5-1"), memory("evt-6-1")]]],
        [["hera>zeus", relationship(-1)]],
      ),
    ),
  ).toEqual([]);

  // A branch that lost one of Hera's memories.
  expect(
    differences(
      live,
      view([["hera", [memory("evt-5-1")]]], [["hera>zeus", relationship(-1)]]),
    ),
  ).toEqual(["memories of hera differ"]);
  // A branch with the feeling changed, and one with it gone.
  expect(
    differences(
      live,
      view(
        [["hera", [memory("evt-5-1"), memory("evt-6-1")]]],
        [["hera>zeus", relationship(0)]],
      ),
    ),
  ).toEqual(["relationship hera>zeus differs"]);
  expect(
    differences(
      live,
      view([["hera", [memory("evt-5-1"), memory("evt-6-1")]]], []),
    ),
  ).toEqual(["relationship hera>zeus differs"]);
});

const event = (
  id: string,
  kind: string,
  extra: Record<string, unknown> = {},
) => ({
  schemaVersion: 1,
  id,
  sequence: Number(id.split("-")[2]),
  simTime: 0,
  correlationId: "c",
  causationId: "c",
  approximate: false,
  kind,
  ...extra,
});

test("explainChain walks a relationship change back through its memory and the report to the strike, from events alone", () => {
  const events = [
    event("evt-1-1", "building-ignited", {
      entityId: "the-tavern",
      cause: { kind: "strike", actor: "zeus" },
    }),
    event("evt-2-2", "report-told", {
      entityId: "zeus",
      listenerId: "hera",
      content: "x",
      linkedEventId: "evt-1-1",
    }),
    event("evt-2-3", "memory-recorded", {
      memoryKind: "told",
      entityId: "hera",
      sourceEventId: "evt-2-2",
      teller: "zeus",
      content: "x",
      subjects: ["zeus"],
      salience: 4,
    }),
    event("evt-2-4", "relationship-changed", {
      entityId: "hera",
      toward: "zeus",
      affinityDelta: -1,
      grudgeDelta: 0,
      memoryEventId: "evt-2-3",
    }),
  ];
  expect(explainChain(events, "evt-2-4")).toEqual([
    "building-ignited",
    "report-told",
    "memory-recorded",
    "relationship-changed",
  ]);
  // Control: with the memory event missing from the log, the chain stops at the change.
  expect(
    explainChain(
      events.filter((e) => e.id !== "evt-2-3"),
      "evt-2-4",
    ),
  ).toEqual(["relationship-changed"]);
});
