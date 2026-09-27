import { describe, expect, test } from "bun:test";
import {
  applyElapsed,
  type ClockConfig,
  computeTick,
  DEFAULT_CATCH_UP_CAP_MS,
  type PersistedClockState,
  pauseClock,
  resumeClock,
} from "./clock";

// --- Characterization: the lifted ADR-0003 guarantee, unchanged ------------
// These mirror tools/probes/backend-lifecycle/src/clock.test.ts exactly, to
// prove the lifted `applyElapsed` still holds the same at-most-once
// guarantee before this module extends it with pause and the catch-up cap.

describe("applyElapsed (characterization of the lifted ADR-0003 guarantee)", () => {
  test("happy path: an elapsed interval is applied once and the cursor advances to its end", () => {
    const first = applyElapsed(0, 1000);
    expect(first).toEqual({ applied: 1000, newCursor: 1000 });

    const second = applyElapsed(first.newCursor, 1000);
    expect(second).toEqual({ applied: 0, newCursor: 1000 });
  });

  test("edge case: cursor restored from DB after a simulated crash mid-apply advances only the unapplied remainder, never twice", () => {
    const cursor = 1000;
    const beforeCrash = applyElapsed(cursor, 5000);
    expect(beforeCrash.applied).toBe(4000);

    const afterRestart = applyElapsed(cursor, 6000);
    expect(afterRestart).toEqual({ applied: 5000, newCursor: 6000 });
  });

  test("error path: negative wall delta (clock set back) advances zero and logs", () => {
    const messages: string[] = [];
    const result = applyElapsed(5000, 4000, (message) => {
      messages.push(message);
    });

    expect(result).toEqual({ applied: 0, newCursor: 5000 });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("moved backward");
  });

  test("negative delta does not throw (no throw, default logger is console.warn)", () => {
    expect(() => applyElapsed(5000, 4000)).not.toThrow();
  });
});

// --- Extension: persisted pause and the configured catch-up cap ------------

const config: ClockConfig = { catchUpCapMs: DEFAULT_CATCH_UP_CAP_MS };

describe("computeTick", () => {
  test("happy path: not paused, elapsed under the cap applies in full", () => {
    const state: PersistedClockState = { cursorWallMs: 0, paused: false };
    const result = computeTick(state, 1000, config);
    expect(result).toEqual({ appliedMs: 1000, skippedMs: 0, newCursor: 1000 });
  });

  test("edge case: backward wall clock applies zero and the cursor never moves back", () => {
    const state: PersistedClockState = { cursorWallMs: 5000, paused: false };
    const result = computeTick(state, 4000, config);
    expect(result).toEqual({ appliedMs: 0, skippedMs: 0, newCursor: 5000 });
  });

  test("edge case: elapsed above the configured cap is capped, the remainder is skipped (not queued), and the cursor still jumps to now", () => {
    const tinyCapConfig: ClockConfig = { catchUpCapMs: 1000 };
    const state: PersistedClockState = { cursorWallMs: 0, paused: false };
    const result = computeTick(state, 5000, tinyCapConfig);
    expect(result).toEqual({
      appliedMs: 1000,
      skippedMs: 4000,
      newCursor: 5000,
    });

    // No permanent backlog: the next tick starts fresh from the jumped
    // cursor rather than re-attempting the discarded 4000ms.
    const next = computeTick(
      { cursorWallMs: result.newCursor, paused: false },
      5100,
      tinyCapConfig,
    );
    expect(next).toEqual({ appliedMs: 100, skippedMs: 0, newCursor: 5100 });
  });

  test("edge case: paused state applies and skips nothing; the cursor does not move", () => {
    const state: PersistedClockState = { cursorWallMs: 1000, paused: true };
    const result = computeTick(state, 999_999, config);
    expect(result).toEqual({ appliedMs: 0, skippedMs: 0, newCursor: 1000 });
  });
});

describe("pauseClock / resumeClock", () => {
  test("happy path: pause flag persists and survives a simulated reopen", () => {
    const state: PersistedClockState = { cursorWallMs: 1000, paused: false };
    const paused = pauseClock(state);
    expect(paused).toEqual({ cursorWallMs: 1000, paused: true });

    // Simulate reopening the store from the persisted row: the same value
    // read back still reports paused.
    const reopened: PersistedClockState = { ...paused };
    expect(reopened.paused).toBe(true);
  });

  test("edge case: a paused interval produces no catch-up after reopen — resuming discards the paused span instead of applying it", () => {
    const state: PersistedClockState = { cursorWallMs: 1000, paused: true };

    // Time passes while paused (e.g. the process was down for an hour).
    const resumed = resumeClock(state, 3_601_000);
    expect(resumed).toEqual({ cursorWallMs: 3_601_000, paused: false });

    // The very next tick sees only whatever elapses *after* resume, not the
    // whole paused span.
    const tick = computeTick(resumed, 3_601_500, config);
    expect(tick).toEqual({
      appliedMs: 500,
      skippedMs: 0,
      newCursor: 3_601_500,
    });
  });

  test("resumeClock is a no-op when not paused", () => {
    const state: PersistedClockState = { cursorWallMs: 1000, paused: false };
    expect(resumeClock(state, 5000)).toBe(state);
  });

  test("resumeClock never moves the cursor backward even if `nowWallMs` is stale", () => {
    const state: PersistedClockState = { cursorWallMs: 5000, paused: true };
    const resumed = resumeClock(state, 4000);
    expect(resumed).toEqual({ cursorWallMs: 5000, paused: false });
  });
});
