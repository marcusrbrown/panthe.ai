// Composition root bridging packages/world's pure engine to
// packages/persistence's storage. apps/simulation depends on both
// packages; everything here is thin glue -- no domain logic, just wiring
// world's registries and codec into persistence's `ProjectionReducers<T>`
// injection points.
//
// packages/persistence never imports packages/world; this file is the
// only place both are imported together.

import { join } from "node:path";
import { loadContentPack } from "@panthea/content";
import type {
  ClockRow,
  ProjectionCodec,
  ProjectionReducers,
} from "@panthea/persistence";
import {
  applyEvent,
  createInitialWorldState,
  decode as decodeWorldState,
  type EncodedWorldState,
  encode as encodeWorldState,
  type PrngState,
  type WorldState,
} from "@panthea/world";

/** The authored Greek world content directory, resolved relative to this file. */
export const GREEK_WORLD_CONTENT_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "content",
  "greek",
  "world",
);

/** Loads the authored Greek content pack and builds its initial `WorldState` (no actors -- see packages/world/src/state.ts). */
export function loadGreekWorldState(
  baseDir: string = GREEK_WORLD_CONTENT_DIR,
): WorldState {
  const result = loadContentPack(baseDir);
  if (!result.ok) {
    throw new Error(
      `world-store: failed to load content pack at ${baseDir} (${result.path}): ${result.message}`,
    );
  }
  return createInitialWorldState(result.value);
}

/**
 * Bridges `WorldState`'s `Map`-backed shape to packages/persistence's
 * JSON-safe storage via packages/world's own `encode`/`decode`. Persistence
 * calls `encode` once per `commitTick`/`exportArchive` and `decode` once
 * per `readLiveProjections`/`rebuildProjections`/store-reopen -- never per
 * event -- so `applyEvent` below operates on the real, `Map`-backed
 * `WorldState` throughout a transaction, not on the encoded form.
 */
export const worldProjectionCodec: ProjectionCodec<WorldState> = {
  encode: (state) => encodeWorldState(state),
  decode: (value) => decodeWorldState(value as EncodedWorldState),
};

/**
 * Builds the `ProjectionReducers<WorldState>` packages/persistence's
 * `commitTick`/`rebuildProjections`/`readLiveProjections` inject into:
 * `applyEvent` is packages/world's own plain event-application function --
 * the single place event-to-state logic lives -- and `codec` is
 * `worldProjectionCodec`.
 */
export function createWorldProjectionReducers(
  initialState: WorldState,
): ProjectionReducers<WorldState> {
  return {
    initial: initialState,
    applyEvent,
    codec: worldProjectionCodec,
  };
}

/**
 * Restores `WorldState.tick`/`simTime` from the store's clock row: the
 * projection-replay path can never reconstruct them (no event or reducer
 * carries them), so the clock row committed atomically with each tick is
 * their authoritative source after a reopen or rebuild.
 */
export function restoreWorldTime(
  state: WorldState,
  clock: Pick<ClockRow, "tick" | "simTimeMs">,
): WorldState {
  return { ...state, tick: clock.tick, simTime: clock.simTimeMs };
}

/**
 * Serializes packages/world's `PrngState` for `TickInput.prngState`
 * (persistence stores it as an opaque string; packages/world owns the
 * algorithm and its own serialization).
 */
export function serializePrngState(prng: PrngState): string {
  return JSON.stringify(prng);
}

/** Inverse of `serializePrngState`; the empty string (a brand-new store's seed row) has no PRNG history to restore. */
export function deserializePrngState(raw: string): PrngState | undefined {
  if (raw === "") {
    return undefined;
  }
  return JSON.parse(raw) as PrngState;
}
