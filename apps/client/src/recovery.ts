// The device-loss rebuild seam: after the renderer is disposed and a fresh
// one created, `rebuild` recomputes the view model from what the store
// holds, so the new renderer draws exactly what the lost one showed.

import { toViewModel, type WorldStore, type WorldViewModel } from "./store";

export interface Recovery {
  /** The view model recomputed from the store's frame and state, or `undefined` before any frame arrived. */
  rebuild(): WorldViewModel | undefined;
}

export function createRecovery(store: WorldStore): Recovery {
  return {
    rebuild() {
      const held = store.snapshot();
      return held ? toViewModel(held.frame, held.state) : undefined;
    },
  };
}
