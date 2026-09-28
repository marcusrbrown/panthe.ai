import { expect, test } from "bun:test";
import {
  createCausationId,
  createCorrelationId,
  createEntityId,
  createEventId,
  createSessionId,
  createWorldId,
  parseCausationId,
  parseCorrelationId,
  parseEntityId,
  parseEntityRevision,
  parseEnum,
  parseEventId,
  parseNonNegativeInteger,
  parseResourceAmount,
  parseSchemaVersion,
  parseSessionId,
  parseWorldId,
} from "./ids";

test("branded id parsers accept a non-empty string", () => {
  expect(parseWorldId("world-1", "worldId")).toMatchObject({
    ok: true,
    value: "world-1",
  });
  expect(parseEntityId("npc-1", "actor")).toMatchObject({
    ok: true,
    value: "npc-1",
  });
  expect(parseEventId("evt-1", "id")).toMatchObject({
    ok: true,
    value: "evt-1",
  });
  expect(parseCorrelationId("corr-1", "correlationId")).toMatchObject({
    ok: true,
    value: "corr-1",
  });
  expect(parseCausationId("cause-1", "causationId")).toMatchObject({
    ok: true,
    value: "cause-1",
  });
  expect(parseSessionId("session-1", "sessionId")).toMatchObject({
    ok: true,
    value: "session-1",
  });
});

test("branded id parsers reject empty or non-string values", () => {
  const empty = parseWorldId("", "worldId");
  expect(empty.ok).toBe(false);
  if (!empty.ok) expect(empty.path).toBe("worldId");

  const notAString = parseEntityId(42, "actor");
  expect(notAString.ok).toBe(false);
});

test("a created world id round-trips through its parser", () => {
  const worldId = createWorldId();
  expect(parseWorldId(worldId, "id")).toEqual({ ok: true, value: worldId });
});

test("a created entity id round-trips through its parser", () => {
  const entityId = createEntityId();
  expect(parseEntityId(entityId, "id")).toEqual({ ok: true, value: entityId });
});

test("a created event id round-trips through its parser", () => {
  const eventId = createEventId();
  expect(parseEventId(eventId, "id")).toEqual({ ok: true, value: eventId });
});

test("a created correlation id round-trips through its parser", () => {
  const correlationId = createCorrelationId();
  expect(parseCorrelationId(correlationId, "id")).toEqual({
    ok: true,
    value: correlationId,
  });
});

test("a created causation id round-trips through its parser", () => {
  const causationId = createCausationId();
  expect(parseCausationId(causationId, "id")).toEqual({
    ok: true,
    value: causationId,
  });
});

test("a created session id round-trips through its parser", () => {
  const sessionId = createSessionId();
  expect(parseSessionId(sessionId, "id")).toEqual({
    ok: true,
    value: sessionId,
  });
});

test("parseSchemaVersion accepts a supported version", () => {
  expect(parseSchemaVersion(1, [1, 2])).toEqual({ ok: true, value: 1 });
});

test("parseSchemaVersion rejects a non-integer as malformed", () => {
  const result = parseSchemaVersion(1.5, [1, 2]);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe("malformed");
});

test("parseSchemaVersion rejects an unsupported version distinctly", () => {
  const result = parseSchemaVersion(99, [1, 2]);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe("unsupported-version");
});

test("parseNonNegativeInteger accepts zero and rejects negatives or fractions", () => {
  expect(parseNonNegativeInteger(0, "sequence")).toEqual({
    ok: true,
    value: 0,
  });
  expect(parseNonNegativeInteger(-1, "sequence").ok).toBe(false);
  expect(parseNonNegativeInteger(1.5, "sequence").ok).toBe(false);
});

test("parseEnum accepts a listed value and rejects anything else", () => {
  const allowed = ["a", "b"] as const;
  expect(parseEnum("a", "letter", allowed)).toEqual({ ok: true, value: "a" });
  expect(parseEnum("z", "letter", allowed).ok).toBe(false);
});

test("parseEntityRevision parses a well-formed entry and rejects a bad one", () => {
  expect(
    parseEntityRevision({ entityId: "npc-1", revision: 3 }, "targets[0]"),
  ).toMatchObject({
    ok: true,
    value: { entityId: "npc-1", revision: 3 },
  });
  const bad = parseEntityRevision(
    { entityId: "npc-1", revision: -1 },
    "targets[0]",
  );
  expect(bad.ok).toBe(false);
});

test("parseResourceAmount parses a well-formed entry and rejects a negative amount", () => {
  expect(
    parseResourceAmount({ resource: "wood", amount: 2 }, "costs[0]"),
  ).toEqual({
    ok: true,
    value: { resource: "wood", amount: 2 },
  });
  const bad = parseResourceAmount({ resource: "wood", amount: -1 }, "costs[0]");
  expect(bad.ok).toBe(false);
});
