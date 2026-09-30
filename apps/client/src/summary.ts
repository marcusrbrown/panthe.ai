// Dismissal of the catch-up summary panel. The client owns it: the sidecar
// delivers a summary with a stable id and holds it on every frame (even across
// a restart), and the operator acknowledges it by that id.
//
// One localStorage key per world, `panthea.catchUpDismissed:<worldId>`, holds
// the one latest dismissed summary id. It is written only when the operator
// presses Dismiss, never when a frame arrives or the panel renders. A summary
// with a different id (any later catch-up, even at the same sequence) is a new
// summary and shows. If storage cannot be written the summary stays dismissed
// in memory for this session and shows again after a reload; nothing here
// claims a dismissal that was not stored.

import type { WorldViewModel } from "./store";

/** The slice of `localStorage` dismissal uses; a test supplies its own. */
export interface DismissalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function dismissalKey(worldId: string): string {
  return `panthea.catchUpDismissed:${worldId}`;
}

export interface SummaryDismissal {
  isDismissed(worldId: string, summaryId: string): boolean;
  dismiss(worldId: string, summaryId: string): void;
}

/**
 * A dismissal store over `storage` (or, with none, over this session's memory
 * alone). A new instance over the same storage is a page reload.
 */
export function createSummaryDismissal(
  storage: DismissalStorage | undefined,
): SummaryDismissal {
  // The latest id dismissed this session, per world; the fallback when the
  // stored write fails.
  const session = new Map<string, string>();
  return {
    isDismissed(worldId, summaryId) {
      if (session.get(worldId) === summaryId) {
        return true;
      }
      try {
        return storage?.getItem(dismissalKey(worldId)) === summaryId;
      } catch {
        // Unreadable storage must not fail the view: show the summary.
        return false;
      }
    },
    dismiss(worldId, summaryId) {
      session.set(worldId, summaryId);
      try {
        storage?.setItem(dismissalKey(worldId), summaryId);
      } catch {
        // Dismissed for this session only; it shows again after a reload.
      }
    },
  };
}

/** The browser's `localStorage`, or `undefined` where the platform refuses access to it. */
export function browserDismissalStorage(): DismissalStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Whether `view`'s catch-up summary is the one the operator already dismissed. Reads only. */
export function isSummaryDismissed(
  view: WorldViewModel | undefined,
  dismissal: SummaryDismissal,
): boolean {
  const summary = view?.catchUpSummary;
  return view !== undefined && summary !== undefined
    ? dismissal.isDismissed(view.worldId, summary.id)
    : false;
}

/** Records that the operator dismissed `view`'s summary. Call it from the Dismiss action only. */
export function dismissSummary(
  view: WorldViewModel | undefined,
  dismissal: SummaryDismissal,
): void {
  const summary = view?.catchUpSummary;
  if (view !== undefined && summary !== undefined) {
    dismissal.dismiss(view.worldId, summary.id);
  }
}
