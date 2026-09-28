import { expect, test } from "bun:test";
import { parseSyncFrame } from "@panthea/contracts";
import { decode } from "@panthea/world";

import { baseState, framePayload } from "./fixtures";
import { toViewModel, type WorldViewModel } from "./store";
import { isSummaryDismissed, summaryKey } from "./summary";

function frameView(options: {
  readonly sequence: number;
  readonly sessionId?: string;
  readonly atSequence?: number;
}): WorldViewModel {
  const parsed = parseSyncFrame(
    framePayload(baseState(), {
      sequence: options.sequence,
      ...(options.sessionId === undefined
        ? {}
        : { sessionId: options.sessionId }),
      ...(options.atSequence === undefined
        ? {}
        : {
            catchUpSummary: {
              appliedMs: 3_600_000,
              skippedMs: 0,
              majorOutcomes: [],
              atSequence: options.atSequence,
            },
          }),
    }),
  );
  if (!parsed.ok) throw new Error(parsed.message);
  return toViewModel(parsed.value, decode(parsed.value.state));
}

test("a summary is shown the first time a frame carries it", () => {
  const view = frameView({ sequence: 20, atSequence: 15 });

  expect(summaryKey(view)).toBeDefined();
  expect(isSummaryDismissed(view, undefined)).toBe(false);
});

test("a frame with no summary has no key and nothing to dismiss", () => {
  const view = frameView({ sequence: 20 });

  expect(summaryKey(view)).toBeUndefined();
  expect(isSummaryDismissed(view, "session-1:15")).toBe(false);
  expect(summaryKey(undefined)).toBeUndefined();
});

test("a dismissed summary stays hidden on every later frame that carries it", () => {
  const first = frameView({ sequence: 20, atSequence: 15 });
  const dismissed = summaryKey(first);

  for (const sequence of [21, 22, 23, 40]) {
    const later = frameView({ sequence, atSequence: 15 });
    expect(isSummaryDismissed(later, dismissed)).toBe(true);
  }
});

test("a summary from a later catch-up shows again after an earlier one was dismissed", () => {
  const dismissed = summaryKey(frameView({ sequence: 20, atSequence: 15 }));

  const renewed = frameView({ sequence: 60, atSequence: 55 });

  expect(isSummaryDismissed(renewed, dismissed)).toBe(false);
});

test("a summary in a new session shows again even at the same sequence", () => {
  const dismissed = summaryKey(
    frameView({ sequence: 20, sessionId: "session-1", atSequence: 15 }),
  );

  const restarted = frameView({
    sequence: 20,
    sessionId: "session-2",
    atSequence: 15,
  });

  expect(isSummaryDismissed(restarted, dismissed)).toBe(false);
});
