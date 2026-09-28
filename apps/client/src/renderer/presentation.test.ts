import { expect, test } from "bun:test";

import { createReceiptEmitter } from "../receipts";
import type { WorldViewModel } from "../store";
import { drawableEvents, receiptDrawnEvents } from "./presentation";
import { rebuildAfterDeviceLoss } from "./recovery";

const view = {
  sessionId: "session-1",
  sequence: 4,
  tick: 2,
  status: "running",
  realms: { mortal: [], olympus: [], underworld: [] },
  recentEvents: [
    { id: "strike-1", sequence: 1, tick: 1, kind: "strike", subjects: [] },
    {
      id: "fire-1",
      sequence: 2,
      tick: 1,
      kind: "building-ignited",
      subjects: [],
    },
    { id: "trade-1", sequence: 3, tick: 2, kind: "trade", subjects: [] },
    { id: "other-1", sequence: 4, tick: 2, kind: "actor-moved", subjects: [] },
  ],
} as unknown as WorldViewModel;

test("only drawable recent effects are handed to presentation receipts", async () => {
  const drawn = drawableEvents(view, "mortal");
  const sent: string[] = [];
  const emitter = createReceiptEmitter({
    presentEvent: async (id) => {
      sent.push(id);
    },
    onError: () => {},
  });

  await receiptDrawnEvents(view.sessionId, drawn, emitter);
  await receiptDrawnEvents(view.sessionId, drawn, emitter);

  expect(drawn.map((event) => String(event.id))).toEqual([
    "strike-1",
    "fire-1",
    "trade-1",
  ]);
  expect(sent.map(String)).toEqual(["strike-1", "fire-1", "trade-1"]);
});

test("device loss rebuilds the current view before a fresh renderer resumes", () => {
  const actions: string[] = [];
  const rebuilt = { ...view, sequence: 5 };

  const result = rebuildAfterDeviceLoss(
    () => {
      actions.push("rebuild");
      return rebuilt;
    },
    (next) => {
      actions.push(`replace:${next.sequence}`);
    },
  );

  expect(result).toBe(rebuilt);
  expect(actions).toEqual(["rebuild", "replace:5"]);
});
