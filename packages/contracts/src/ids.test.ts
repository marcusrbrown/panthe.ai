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

// --- Time-ordered ids ----------------------------------------------------------------------------

import { timeOrderedIdFactory } from "./ids";
import { createObservationId } from "./proposal";

test("a time-ordered id is a UUIDv7 under its prefix: the shape a random id has, with the version and variant a v7 carries", () => {
  const id = timeOrderedIdFactory<"X">("obs")();
  expect(id).toMatch(
    /^obs-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("time-ordered ids sort in the order they were made, however fast they are made: ten thousand in a burst are strictly increasing and all different", () => {
  const make = timeOrderedIdFactory<"X">("obs");
  const ids = Array.from({ length: 10_000 }, () => make());
  expect(new Set(ids).size).toBe(ids.length);
  expect([...ids].sort()).toEqual(ids);
});

test("ids made across milliseconds keep their order, and an earlier clock reading never makes a later id sort before an earlier one", () => {
  const readings = [1_000, 1_000, 1_001, 5_000, 4_999, 4_000, 5_001];
  let at = 0;
  const make = timeOrderedIdFactory<"X">("obs", () => readings[at++] as number);
  const ids = readings.map(() => make());
  expect([...ids].sort()).toEqual(ids);
  // The ids made at 1,000 ms and 5,000 ms are far apart in their timestamp; the clock going back at 4,999 and 4,000 changes nothing.
  expect(ids[3]?.slice(4, 16)).not.toBe(ids[0]?.slice(4, 16));
  expect(ids[4]?.slice(4, 16)).toBe(ids[3]?.slice(4, 16));
});

test("two factories do not make the same id: the random part, not the clock, keeps them apart", () => {
  const a = timeOrderedIdFactory<"X">("obs", () => 7);
  const b = timeOrderedIdFactory<"X">("obs", () => 7);
  const first = Array.from({ length: 200 }, () => a());
  const second = Array.from({ length: 200 }, () => b());
  expect(new Set([...first, ...second]).size).toBe(400);
});

test("observation ids are time-ordered, and every other id stays random", () => {
  const obs = Array.from({ length: 500 }, () => createObservationId());
  expect([...obs].sort()).toEqual(obs);
  expect(obs[0]?.startsWith("obs-")).toBe(true);
  // A random id is not in order (the chance that 500 are is nil).
  const random = Array.from({ length: 500 }, () => createEntityId());
  expect([...random].sort()).not.toEqual(random);
});
