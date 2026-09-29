// Composition root bridging packages/world's pure engine to
// packages/persistence's storage. apps/simulation depends on both
// packages; everything here is thin glue -- no domain logic, just wiring
// world's registries and codec into persistence's `ProjectionReducers<T>`
// injection points.
//
// packages/persistence never imports packages/world; this file is the
// only place both are imported together.

import type {
  ClockRow,
  ProjectionCodec,
  ProjectionReducers,
  Store,
} from "@panthea/persistence";
import { getEventRow } from "@panthea/persistence";
import type { EventSource } from "@panthea/telemetry";
import {
  applyEvent,
  createInitialWorldState,
  decode as decodeWorldState,
  encode as encodeWorldState,
  type PrngState,
  type WorldState,
} from "@panthea/world";
import {
  loadEmbeddedGreekGodProfiles,
  loadEmbeddedGreekWorldPack,
} from "./greek-world-pack";

/**
 * Loads the embedded authored Greek content pack (see
 * greek-world-pack.ts) and builds its initial `WorldState` (no actors --
 * see packages/world/src/state.ts). Needs no filesystem access, so it
 * works identically whether running from source or inside a compiled
 * `bun build --compile` sidecar binary. The embedded god profiles are
 * parsed against the pack too, so a profile that no longer matches a deity
 * inhabitant stops startup.
 */
export function loadGreekWorldState(): WorldState {
  const result = loadEmbeddedGreekWorldPack();
  if (!result.ok) {
    throw new Error(
      `world-store: failed to parse the embedded Greek content pack (${result.path}): ${result.message}`,
    );
  }
  const gods = loadEmbeddedGreekGodProfiles(result.value);
  if (!gods.ok) {
    throw new Error(
      `world-store: failed to parse the embedded Greek god profiles (${gods.path}): ${gods.message}`,
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
  decode: (value) => decodeWorldState(value),
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

/**
 * Bridges persistence's `getEventRow` to packages/telemetry's `EventSource`
 * injection seam, so a trace query can resolve committed events without
 * telemetry depending on `@panthea/persistence`'s `Store` type directly.
 */
export function createEventSource(store: Pick<Store, "db">): EventSource {
  return {
    getEvent: (id) => getEventRow(store.db, id),
  };
}
