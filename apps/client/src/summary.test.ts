import { expect, test } from "bun:test";
import { parseSyncFrame } from "@panthea/contracts";
import { decode } from "@panthea/world";

import { baseState, framePayload } from "./fixtures";
import { toViewModel, type WorldViewModel } from "./store";
import {
  createSummaryDismissal,
  type DismissalStorage,
  dismissalKey,
  dismissSummary,
  isSummaryDismissed,
} from "./summary";

function frameView(options: {
  readonly sequence?: number;
  readonly worldId?: string;
  readonly summaryId?: string;
}): WorldViewModel {
  const payload = framePayload(baseState(), {
    sequence: options.sequence ?? 20,
    ...(options.summaryId === undefined
      ? {}
      : {
          catchUpSummary: {
            id: options.summaryId,
            appliedMs: 3_600_000,
            skippedMs: 0,
            majorOutcomes: [],
            atSequence: 15,
          },
        }),
  }) as Record<string, unknown>;
  if (options.worldId !== undefined) payload.worldId = options.worldId;
  const parsed = parseSyncFrame(payload);
  if (!parsed.ok) throw new Error(parsed.message);
  return toViewModel(parsed.value, decode(parsed.value.state));
}

/** An in-memory `localStorage` that records every write, so a test can tell an explicit dismissal from a render. */
function recordingStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  const writes: [string, string][] = [];
  const storage: DismissalStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      writes.push([key, value]);
      data.set(key, value);
    },
  };
  return { storage, writes, data };
}

test("the storage key is per world: panthea.catchUpDismissed:<worldId>", () => {
  expect(dismissalKey("world-1")).toBe("panthea.catchUpDismissed:world-1");
});

test("a summary is shown the first time a frame carries it", () => {
  const { storage } = recordingStorage();
  const dismissal = createSummaryDismissal(storage);

  expect(isSummaryDismissed(frameView({ summaryId: "a" }), dismissal)).toBe(
    false,
  );
});

test("a frame with no summary has nothing to dismiss", () => {
  const { storage } = recordingStorage();
  const dismissal = createSummaryDismissal(storage);
  const view = frameView({});

  expect(isSummaryDismissed(view, dismissal)).toBe(false);
  expect(isSummaryDismissed(undefined, dismissal)).toBe(false);
  dismissSummary(view, dismissal);
  dismissSummary(undefined, dismissal);
});

test("fetching and rendering never dismiss: many frames carrying the summary, checked many times, write nothing", () => {
  const { storage, writes } = recordingStorage();
  const dismissal = createSummaryDismissal(storage);

  for (const sequence of [20, 21, 22, 40, 41]) {
    const view = frameView({ sequence, summaryId: "a" });
    expect(isSummaryDismissed(view, dismissal)).toBe(false);
    expect(isSummaryDismissed(view, dismissal)).toBe(false);
  }

  expect(writes).toEqual([]);
});

test("an explicit dismiss writes the summary's id under the world's key, and hides it on every later frame that carries it", () => {
  const { storage, writes } = recordingStorage();
  const dismissal = createSummaryDismissal(storage);

  dismissSummary(frameView({ summaryId: "summary-a" }), dismissal);

  expect(writes).toEqual([["panthea.catchUpDismissed:world-1", "summary-a"]]);
  for (const sequence of [21, 22, 23, 40]) {
    expect(
      isSummaryDismissed(
        frameView({ sequence, summaryId: "summary-a" }),
        dismissal,
      ),
    ).toBe(true);
  }
});

test("a reload keeps it dismissed: a new instance reading the same storage hides the same summary", () => {
  const { storage } = recordingStorage();
  dismissSummary(
    frameView({ summaryId: "summary-a" }),
    createSummaryDismissal(storage),
  );

  const afterReload = createSummaryDismissal(storage);

  expect(
    isSummaryDismissed(frameView({ summaryId: "summary-a" }), afterReload),
  ).toBe(true);
});

test("a summary with a new id shows again, and dismissing it replaces the one remembered id", () => {
  const { storage, data } = recordingStorage();
  const dismissal = createSummaryDismissal(storage);
  dismissSummary(frameView({ summaryId: "summary-a" }), dismissal);

  expect(
    isSummaryDismissed(frameView({ summaryId: "summary-b" }), dismissal),
  ).toBe(false);
  dismissSummary(frameView({ summaryId: "summary-b" }), dismissal);

  expect(data.get("panthea.catchUpDismissed:world-1")).toBe("summary-b");
  expect(
    isSummaryDismissed(frameView({ summaryId: "summary-b" }), dismissal),
  ).toBe(true);
});

test("worlds are independent: dismissing in one leaves another world's summary showing, even with the same id", () => {
  const { storage, writes } = recordingStorage();
  const dismissal = createSummaryDismissal(storage);

  dismissSummary(
    frameView({ worldId: "world-1", summaryId: "shared-id" }),
    dismissal,
  );

  expect(writes.map(([key]) => key)).toEqual([
    "panthea.catchUpDismissed:world-1",
  ]);
  expect(
    isSummaryDismissed(
      frameView({ worldId: "world-1", summaryId: "shared-id" }),
      dismissal,
    ),
  ).toBe(true);
  expect(
    isSummaryDismissed(
      frameView({ worldId: "world-2", summaryId: "shared-id" }),
      dismissal,
    ),
  ).toBe(false);
});

test("a storage write that fails keeps the summary dismissed for this session but it shows again after a reload: no durable dismissal is claimed", () => {
  const storage: DismissalStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  const dismissal = createSummaryDismissal(storage);

  expect(() =>
    dismissSummary(frameView({ summaryId: "summary-a" }), dismissal),
  ).not.toThrow();

  expect(
    isSummaryDismissed(frameView({ summaryId: "summary-a" }), dismissal),
  ).toBe(true);
  expect(
    isSummaryDismissed(
      frameView({ summaryId: "summary-a" }),
      createSummaryDismissal(storage),
    ),
  ).toBe(false);
});

test("storage that cannot be read shows the summary rather than failing the view", () => {
  const storage: DismissalStorage = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {},
  };
  const dismissal = createSummaryDismissal(storage);

  expect(
    isSummaryDismissed(frameView({ summaryId: "summary-a" }), dismissal),
  ).toBe(false);
});

test("with no storage at all, a dismissal lasts the session only", () => {
  const dismissal = createSummaryDismissal(undefined);

  dismissSummary(frameView({ summaryId: "summary-a" }), dismissal);

  expect(
    isSummaryDismissed(frameView({ summaryId: "summary-a" }), dismissal),
  ).toBe(true);
  expect(
    isSummaryDismissed(
      frameView({ summaryId: "summary-a" }),
      createSummaryDismissal(undefined),
    ),
  ).toBe(false);
});

test("the view model carries the world id the dismissal is keyed on", () => {
  expect(frameView({ worldId: "world-7", summaryId: "a" }).worldId).toBe(
    "world-7",
  );
});
