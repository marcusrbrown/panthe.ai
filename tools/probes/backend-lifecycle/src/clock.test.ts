import { describe, expect, test } from "bun:test";
import { applyElapsed } from "./clock";

describe("applyElapsed", () => {
  test("happy path: an elapsed interval is applied once and the cursor advances to its end", () => {
    const first = applyElapsed(0, 1000);
    expect(first).toEqual({ applied: 1000, newCursor: 1000 });

    // Persisting newCursor and calling again with the same wall time (e.g. a
    // duplicate tick, or a second reader before the wall clock advances)
    // must apply nothing further — the guarantee is "at most once".
    const second = applyElapsed(first.newCursor, 1000);
    expect(second).toEqual({ applied: 0, newCursor: 1000 });
  });

  test("edge case: cursor restored from DB after a simulated crash mid-apply advances only the unapplied remainder, never twice", () => {
    const cursor = 1000;

    // Simulate a crash: applyElapsed is called and would compute a delta,
    // but the caller crashes before persisting `newCursor` in the same
    // transaction as the tick it paid for. The persisted cursor is still
    // `cursor` (1000) on restart.
    const beforeCrash = applyElapsed(cursor, 5000);
    expect(beforeCrash.applied).toBe(4000);
    // `beforeCrash.newCursor` (5000) is intentionally never persisted here.

    // Restart: the wall clock has moved further ahead of the crash point.
    const afterRestart = applyElapsed(cursor, 6000);

    // The remainder from the last *persisted* cursor (1000) to now (6000)
    // is applied exactly once — 5000ms, not 4000 + 5000 (double-counted)
    // and not 6000 - 5000 = 1000 (which would silently drop the crash
    // window instead of ever having applied it).
    expect(afterRestart).toEqual({ applied: 5000, newCursor: 6000 });
  });

  test("error path: negative wall delta (clock set back) advances zero and logs", () => {
    const messages: string[] = [];
    const result = applyElapsed(5000, 4000, (message) =>
      messages.push(message),
    );

    expect(result).toEqual({ applied: 0, newCursor: 5000 });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("moved backward");
  });

  test("negative delta does not log by default (no throw, default logger is console.warn)", () => {
    expect(() => applyElapsed(5000, 4000)).not.toThrow();
  });
});
