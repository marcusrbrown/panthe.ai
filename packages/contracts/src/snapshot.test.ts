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
    recentEvents: [],
    state: { actors: [] },
    ...overrides,
  };
}

function recentEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "evt-4-11",
    sequence: 11,
    tick: 4,
    kind: "building-ignited",
    subjects: ["tavern"],
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
    expect(result.value.recentEvents).toHaveLength(0);
  }
});

test("a frame carrying recent events parses them in order", () => {
  const result = parseSyncFrame(
    frame({
      recentEvents: [
        recentEvent(),
        recentEvent({
          id: "evt-5-12",
          sequence: 12,
          tick: 5,
          kind: "entity-moved",
          subjects: ["npc-1", "loc-2"],
        }),
      ],
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.recentEvents as readonly unknown[]).toEqual([
      {
        id: "evt-4-11",
        sequence: 11,
        tick: 4,
        kind: "building-ignited",
        subjects: ["tavern"],
      },
      {
        id: "evt-5-12",
        sequence: 12,
        tick: 5,
        kind: "entity-moved",
        subjects: ["npc-1", "loc-2"],
      },
    ]);
  }
});

test("a frame missing recentEvents is rejected", () => {
  const payload = frame();
  delete payload.recentEvents;
  const result = parseSyncFrame(payload);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.path).toBe("recentEvents");
  }
});

test("recentEvents that is not a list is rejected", () => {
  expect(parseSyncFrame(frame({ recentEvents: {} })).ok).toBe(false);
});

test("a recent event with an unknown kind is rejected", () => {
  const result = parseSyncFrame(
    frame({ recentEvents: [recentEvent({ kind: "teleported" })] }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.path).toBe("recentEvents[0].kind");
  }
});

test("a recent event with a non-integer sequence or tick is rejected", () => {
  expect(
    parseSyncFrame(frame({ recentEvents: [recentEvent({ sequence: 1.5 })] }))
      .ok,
  ).toBe(false);
  expect(
    parseSyncFrame(frame({ recentEvents: [recentEvent({ tick: -1 })] })).ok,
  ).toBe(false);
});

test("a recent event missing its id or with a non-string subject is rejected", () => {
  const missingId = recentEvent();
  delete missingId.id;
  expect(parseSyncFrame(frame({ recentEvents: [missingId] })).ok).toBe(false);
  expect(
    parseSyncFrame(frame({ recentEvents: [recentEvent({ subjects: [7] })] }))
      .ok,
  ).toBe(false);
  expect(
    parseSyncFrame(
      frame({ recentEvents: [recentEvent({ subjects: "tavern" })] }),
    ).ok,
  ).toBe(false);
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

test("a frame can report model-degraded, the outage that never halts the world", () => {
  const result = parseSyncFrame(
    frame({ status: "degraded", degradedReason: "model-degraded" }),
  );

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      status: "degraded",
      degradedReason: "model-degraded",
    });
  }
});

test("an unknown degraded reason is still rejected", () => {
  expect(
    parseSyncFrame(frame({ status: "degraded", degradedReason: "gremlins" }))
      .ok,
  ).toBe(false);
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
        atSequence: 10,
      },
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.catchUpSummary).toEqual({
      appliedMs: 3_600_000,
      skippedMs: 120_000,
      majorOutcomes: ["tavern fire spread"],
      atSequence: 10,
    });
  }
});

test("a catch-up summary without atSequence is rejected", () => {
  const result = parseSyncFrame(
    frame({
      catchUpSummary: {
        appliedMs: 3_600_000,
        skippedMs: 120_000,
        majorOutcomes: [],
      },
    }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.path).toBe("catchUpSummary.atSequence");
  }
});

test("a catch-up summary atSequence that is not a non-negative integer is rejected", () => {
  for (const atSequence of [-1, 1.5, "10"]) {
    const result = parseSyncFrame(
      frame({
        catchUpSummary: {
          appliedMs: 0,
          skippedMs: 0,
          majorOutcomes: [],
          atSequence,
        },
      }),
    );
    expect(result.ok).toBe(false);
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
