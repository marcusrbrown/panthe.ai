// Dismissal of the catch-up summary panel. A summary is identified by the
// session it arrived in and the committed sequence its catch-up finished
// at, not by the sequence of the frame carrying it, so the same summary
// keeps one identity across every frame the sidecar repeats it on.

import type { WorldViewModel } from "./store";

/** The identity of the summary `view` carries, or `undefined` when it carries none. */
export function summaryKey(
  view: WorldViewModel | undefined,
): string | undefined {
  const summary = view?.catchUpSummary;
  return view && summary
    ? `${view.sessionId}:${summary.atSequence}`
    : undefined;
}

/** Whether `view`'s summary is the one the operator already dismissed. */
export function isSummaryDismissed(
  view: WorldViewModel | undefined,
  dismissedKey: string | undefined,
): boolean {
  const key = summaryKey(view);
  return key !== undefined && key === dismissedKey;
}
