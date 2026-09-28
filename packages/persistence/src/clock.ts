// World clock: at-most-once elapsed wall-clock application, lifted from
// tools/probes/backend-lifecycle/src/clock.ts (ADR-0003's clock
// guarantee). This module extends the probe's guarantee with two
// concerns the probe deliberately left out: persisted pause, and a
// configured catch-up cap.
//
// The at-most-once guarantee is unchanged: `applyElapsed` is a pure function
// of the last *persisted* cursor. Callers (packages/persistence's `store.ts`
// via `commitTick`) must persist `newCursor` in the same transaction as the
// effect that consumed `applied`, and must never advance the cursor any
// other way.

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
 * rather than advancing the cursor or throwing. This is the unmodified
 * ADR-0003 guarantee lifted from the probe.
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

/**
 * Starting catch-up cap per docs/product/defaults.md ("Catch-up cap:
 * Advance at most one hour of missed wall time per return; no permanent
 * backlog of discarded time"). A convenience default only — callers must
 * pass a `ClockConfig` explicitly; nothing in this module falls back to
 * this constant on its own, so the cap always comes from configuration
 * the caller assembled, never a silently-hardcoded value inside tick logic.
 */
export const DEFAULT_CATCH_UP_CAP_MS = 60 * 60 * 1000;

export interface ClockConfig {
  /** Maximum wall-clock milliseconds applied in a single tick/catch-up call. */
  readonly catchUpCapMs: number;
}

/** The clock state persisted with every committed tick (see `store.ts`'s `clock` table). */
export interface PersistedClockState {
  readonly cursorWallMs: number;
  readonly paused: boolean;
}

export interface TickClockResult {
  /** Milliseconds applied this tick, capped at `config.catchUpCapMs`. */
  readonly appliedMs: number;
  /**
   * Elapsed milliseconds beyond the cap, discarded rather than queued —
   * "no permanent backlog of discarded time" (docs/product/defaults.md).
   */
  readonly skippedMs: number;
  /** The cursor value to persist atomically with this tick's effects. */
  readonly newCursor: number;
}

/**
 * Computes one tick's clock advancement against `state`, honoring pause and
 * the configured catch-up cap.
 *
 * - Paused: applies and skips nothing; the cursor does not move. Combined
 *   with `resumeClock` discarding the paused interval, a paused interval
 *   never produces catch-up, whether observed live or after a restart.
 * - Not paused: delegates to `applyElapsed` for the at-most-once guarantee,
 *   then caps the applied amount at `config.catchUpCapMs`. The cursor still
 *   advances to `nowWallMs` even when capped, so the discarded remainder is
 *   never revisited on a later call (no permanent backlog).
 */
export function computeTick(
  state: PersistedClockState,
  nowWallMs: number,
  config: ClockConfig,
  log?: (message: string) => void,
): TickClockResult {
  if (state.paused) {
    return { appliedMs: 0, skippedMs: 0, newCursor: state.cursorWallMs };
  }
  const { applied, newCursor } = applyElapsed(
    state.cursorWallMs,
    nowWallMs,
    log,
  );
  const appliedMs = Math.min(applied, config.catchUpCapMs);
  const skippedMs = applied - appliedMs;
  return { appliedMs, skippedMs, newCursor };
}

/** Pauses the clock. The cursor is untouched; no elapsed time is applied while paused. */
export function pauseClock(state: PersistedClockState): PersistedClockState {
  return { ...state, paused: true };
}

/**
 * Resumes the clock at `nowWallMs`, discarding the paused wall-clock
 * interval rather than applying it as catch-up: the cursor jumps directly
 * to `nowWallMs` (never backward — `nowWallMs` is expected to be the
 * current wall time), so the very next tick's `applyElapsed` call sees a
 * zero-or-small delta instead of the whole paused span.
 */
export function resumeClock(
  state: PersistedClockState,
  nowWallMs: number,
): PersistedClockState {
  if (!state.paused) {
    return state;
  }
  const newCursor = Math.max(state.cursorWallMs, nowWallMs);
  return { cursorWallMs: newCursor, paused: false };
}
