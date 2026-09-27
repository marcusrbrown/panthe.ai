// A snapshot is a consistent read pinned to a committed event sequence —
// "never authority" (Key Technical Decisions: projections are always
// rebuildable from the log; a snapshot is a restore/speed artifact). Export
// (archive.ts) builds on top of this: it takes a snapshot, then adds the
// manifest and canonical content hash.

import type { WorldId } from "@panthea/contracts";
import type { PersistedClockState } from "./clock";
import {
  getCurrentSequence,
  type ProjectionReducers,
  readClock,
  readLiveProjections,
  readPrngState,
  type Store,
} from "./store";

export interface Snapshot<TProjections> {
  readonly worldId: WorldId;
  readonly sequence: number;
  readonly projections: TProjections;
  readonly clock: PersistedClockState;
  readonly prngState: string;
}

/**
 * Takes a snapshot pinned to the sequence committed at the moment the read
 * transaction opens. Wrapped in a deferred (read) transaction so a
 * snapshot always reflects exactly one committed sequence even if it is
 * requested while the tick loop is running — "export while ticking always
 * reflects one committed sequence" (Unit 2 test scenario).
 */
export function takeSnapshot<TProjections>(
  store: Store,
  reducers: ProjectionReducers<TProjections>,
): Snapshot<TProjections> {
  const run = store.db.transaction(() => {
    const sequence = getCurrentSequence(store.db);
    const projections = readLiveProjections(store, reducers);
    const clock = readClock(store.db);
    const prngState = readPrngState(store.db);
    return { sequence, projections, clock, prngState };
  });
  const { sequence, projections, clock, prngState } = run.deferred();
  return { worldId: store.worldId, sequence, projections, clock, prngState };
}
