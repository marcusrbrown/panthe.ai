// ADR-0003 clock guarantee: an elapsed wall-clock interval is applied at
// most once across sleep/resume and crash/restart. Only what the ADR
// needs — no one-hour catch-up cap, no chunking, no `approximate` flag
// (those are M1 time/storage work per docs/product/defaults.md).
//
// The guarantee holds because `applyElapsed` is a pure function of the last
// *persisted* cursor, never of an in-memory intermediate: the caller (see
// sidecar.ts) only advances the persisted cursor inside the same SQLite
// transaction that commits the tick it paid for. If the process crashes
// after computing a delta but before that transaction commits, the cursor
// on disk is unchanged, so the next call recomputes the full span from the
// last committed point — the same wall-clock interval is never counted
// twice, even though the *span* it covers may grow to include the lost
// crash window.

export interface ApplyElapsedResult {
  /** Milliseconds applied this call. Zero when the clock moved backward. */
  readonly applied: number;
  /** The cursor value to persist atomically with whatever consumed `applied`. */
  readonly newCursor: number;
}

/**
 * Computes the wall-clock interval between `cursor` (the last persisted
 * cursor) and `nowWallMs`, guaranteeing that interval is never applied more
 * than once: callers must persist `newCursor` in the same transaction as
 * the effect that consumes `applied`, and must never advance `cursor` any
 * other way.
 *
 * A negative delta (the wall clock moved backward) applies zero and logs
 * rather than advancing the cursor or throwing.
 */
export function applyElapsed(
  cursor: number,
  nowWallMs: number,
  log: (message: string) => void = (message) => console.warn(message),
): ApplyElapsedResult {
  const delta = nowWallMs - cursor;
  if (delta < 0) {
    log(
      `clock: wall clock moved backward by ${-delta}ms (cursor=${cursor}, now=${nowWallMs}); applying 0`,
    );
    return { applied: 0, newCursor: cursor };
  }
  return { applied: delta, newCursor: nowWallMs };
}
