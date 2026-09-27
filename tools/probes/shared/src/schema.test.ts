import { expect, test } from "bun:test";
import { parseAction } from "./schema";

test("move with {x, y} coordinates parses", () => {
  const result = parseAction({ kind: "move", target: { x: 1, y: 2 } });
  expect(result).toEqual({
    ok: true,
    action: { kind: "move", target: { x: 1, y: 2 } },
  });
});

test("move with an entity id parses", () => {
  const result = parseAction({ kind: "move", target: "npc-42" });
  expect(result).toEqual({
    ok: true,
    action: { kind: "move", target: "npc-42" },
  });
});

test("say parses", () => {
  const result = parseAction({ kind: "say", to: "npc-1", text: "hello" });
  expect(result).toEqual({
    ok: true,
    action: { kind: "say", to: "npc-1", text: "hello" },
  });
});

test("trade parses give and receive lists", () => {
  const result = parseAction({
    kind: "trade",
    with: "npc-2",
    give: [{ item: "wheat", qty: 3 }],
    receive: [{ item: "wine", qty: 1 }],
  });
  expect(result).toEqual({
    ok: true,
    action: {
      kind: "trade",
      with: "npc-2",
      give: [{ item: "wheat", qty: 3 }],
      receive: [{ item: "wine", qty: 1 }],
    },
  });
});

test("strike parses", () => {
  const result = parseAction({ kind: "strike", target: "npc-3", power: 0.5 });
  expect(result).toEqual({
    ok: true,
    action: { kind: "strike", target: "npc-3", power: 0.5 },
  });
});

test("idle parses with and without a reason", () => {
  expect(parseAction({ kind: "idle" })).toEqual({
    ok: true,
    action: { kind: "idle" },
  });
  expect(parseAction({ kind: "idle", reason: "waiting" })).toEqual({
    ok: true,
    action: { kind: "idle", reason: "waiting" },
  });
});

test("malformed field fails with a path", () => {
  const result = parseAction({
    kind: "move",
    target: { x: "not-a-number", y: 2 },
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.path).toBe("target.x");
  }
});

test("missing required field fails with a path", () => {
  const result = parseAction({ kind: "say", to: "npc-1" });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.path).toBe("text");
  }
});

test("unknown action kind is rejected, not coerced", () => {
  const result = parseAction({ kind: "fly", target: "npc-1" });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.path).toBe("kind");
  }
});

test("non-object input fails", () => {
  const result = parseAction("not an action");
  expect(result.ok).toBe(false);
});
