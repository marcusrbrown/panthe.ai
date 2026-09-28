import { expect, test } from "bun:test";
import { parseSyncFrame } from "./snapshot";

function frame(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sequence: 10,
    worldId: "world-1",
    sessionId: "session-1",
    status: "running",
    state: { actors: [] },
    ...overrides,
  };
}

test("a valid running frame parses", () => {
  const result = parseSyncFrame(frame());
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      schemaVersion: 1,
      sequence: 10,
      worldId: "world-1",
      sessionId: "session-1",
      status: "running",
      state: { actors: [] },
    });
    expect(result.value.degradedReason).toBeUndefined();
    expect(result.value.catchUpSummary).toBeUndefined();
  }
});

test("a valid paused frame parses", () => {
  const result = parseSyncFrame(frame({ status: "paused" }));
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.status).toBe("paused");
  }
});

test("a degraded frame requires and carries a reason", () => {
  const result = parseSyncFrame(
    frame({ status: "degraded", degradedReason: "disk-full" }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      status: "degraded",
      degradedReason: "disk-full",
    });
  }
});

test("a degraded frame missing a reason is rejected", () => {
  const result = parseSyncFrame(frame({ status: "degraded" }));
  expect(result.ok).toBe(false);
});

test("a frame with a catch-up summary parses", () => {
  const result = parseSyncFrame(
    frame({
      catchUpSummary: {
        appliedMs: 3_600_000,
        skippedMs: 120_000,
        majorOutcomes: ["tavern fire spread"],
      },
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.catchUpSummary).toMatchObject({
      appliedMs: 3_600_000,
      skippedMs: 120_000,
      majorOutcomes: ["tavern fire spread"],
    });
  }
});

test("a frame missing the state payload is rejected", () => {
  const payload = frame();
  delete payload.state;
  const result = parseSyncFrame(payload);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.path).toBe("state");
  }
});

test("a sequence that is not a non-negative integer is rejected", () => {
  expect(parseSyncFrame(frame({ sequence: 1.5 })).ok).toBe(false);
  expect(parseSyncFrame(frame({ sequence: -1 })).ok).toBe(false);
});

test("an unsupported schema version is rejected", () => {
  const result = parseSyncFrame(frame({ schemaVersion: 99 }));
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe("unsupported-version");
  }
});

test("an unknown status is rejected", () => {
  const result = parseSyncFrame(frame({ status: "crashed" }));
  expect(result.ok).toBe(false);
});
