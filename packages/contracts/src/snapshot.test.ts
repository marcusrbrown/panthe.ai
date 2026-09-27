import { expect, test } from "bun:test";
import { LATEST_EVENT_SCHEMA_VERSION } from "./event";
import { parseSyncFrame } from "./snapshot";

function frame(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    sessionGeneration: 0,
    ...overrides,
  };
}

test("a valid snapshot frame parses", () => {
  const result = parseSyncFrame(
    frame({
      kind: "snapshot",
      sequence: 10,
      worldId: "world-1",
      projections: { actors: [] },
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "snapshot",
      sequence: 10,
      worldId: "world-1",
      projections: { actors: [] },
    });
  }
});

test("a valid delta frame with events parses", () => {
  const event = {
    schemaVersion: LATEST_EVENT_SCHEMA_VERSION,
    id: "evt-1",
    sequence: 1,
    simTime: 1,
    correlationId: "corr-1",
    causationId: "cause-1",
    approximate: false,
    kind: "entity-moved",
    entityId: "npc-1",
    to: "loc-2",
  };
  const result = parseSyncFrame(
    frame({ kind: "delta", sequence: 1, events: [event] }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({ kind: "delta", sequence: 1 });
  }
});

test("a delta with a non-integer sequence is rejected", () => {
  const result = parseSyncFrame(
    frame({ kind: "delta", sequence: 1.5, events: [] }),
  );
  expect(result.ok).toBe(false);
});

test("a delta with a negative sequence is rejected", () => {
  const result = parseSyncFrame(
    frame({ kind: "delta", sequence: -1, events: [] }),
  );
  expect(result.ok).toBe(false);
});

test("a valid resync frame parses", () => {
  const result = parseSyncFrame(
    frame({ kind: "resync", reason: "gap detected" }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      schemaVersion: 1,
      sessionId: "session-1",
      sessionGeneration: 0,
      kind: "resync",
      reason: "gap detected",
    });
  }
});

test("a valid session-change frame parses", () => {
  const result = parseSyncFrame(
    frame({ kind: "session-change", sessionGeneration: 1 }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      schemaVersion: 1,
      sessionId: "session-1",
      sessionGeneration: 1,
      kind: "session-change",
    });
  }
});

test("a valid catch-up-summary frame parses", () => {
  const result = parseSyncFrame(
    frame({
      kind: "catch-up-summary",
      appliedMs: 3_600_000,
      skippedMs: 120_000,
      majorOutcomes: ["tavern fire spread"],
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "catch-up-summary",
      appliedMs: 3_600_000,
      skippedMs: 120_000,
      majorOutcomes: ["tavern fire spread"],
    });
  }
});

test("a valid degraded-status frame parses with and without a reason", () => {
  const degraded = parseSyncFrame(
    frame({ kind: "degraded-status", degraded: true, reason: "disk-full" }),
  );
  expect(degraded.ok).toBe(true);
  if (degraded.ok) {
    expect(degraded.value).toMatchObject({
      degraded: true,
      reason: "disk-full",
    });
  }

  const recovered = parseSyncFrame(
    frame({ kind: "degraded-status", degraded: false }),
  );
  expect(recovered.ok).toBe(true);
  if (recovered.ok) {
    expect(recovered.value).toMatchObject({ degraded: false });
    expect((recovered.value as { reason?: unknown }).reason).toBeUndefined();
  }
});

test("an unsupported schema version is rejected", () => {
  const result = parseSyncFrame(
    frame({ schemaVersion: 99, kind: "session-change" }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe("unsupported-version");
  }
});

test("an unknown frame kind is rejected", () => {
  const result = parseSyncFrame(frame({ kind: "heartbeat" }));
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe("unknown-kind");
  }
});
