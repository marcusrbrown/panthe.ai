// The catch-up summary row: when a backlog closes, what it records, and when
// a new summary keeps or replaces the previous one's identity. These run on a
// real store with progress rows written directly; the end-to-end behavior
// (chunks, restarts, kills) is in catchup.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeStore,
  openStore,
  readCatchUpProgress,
  readCatchUpSummary,
  writeCatchUpProgress,
  writeCatchUpSummary,
} from "@panthea/persistence";
import { DEFAULT_TICK_ELAPSED_MS } from "@panthea/world";
import {
  closeCatchUpBacklog,
  isNonEmptyAccount,
  recordPartialSummary,
} from "./catchup-summary";
import {
  createWorldProjectionReducers,
  loadGreekWorldState,
} from "./world-store";

let dir: string;
let store: ReturnType<typeof openStore>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "panthea-sim-catchup-summary-"));
  store = openStore(
    join(dir, "world.sqlite"),
    createWorldProjectionReducers(loadGreekWorldState()),
  );
});

afterEach(() => {
  closeStore(store);
  rmSync(dir, { recursive: true, force: true });
});

const TICK = DEFAULT_TICK_ELAPSED_MS;

const backlog = (
  overrides: Partial<Parameters<typeof writeCatchUpProgress>[1]> = {},
) => ({
  appliedMs: 120 * TICK,
  discardedMs: 0,
  startSequence: 0,
  ...overrides,
});

describe("isNonEmptyAccount", () => {
  test("less than one tick applied and skipped, with no outcomes, is nothing that happened", () => {
    expect(
      isNonEmptyAccount({
        appliedMs: TICK - 1,
        skippedMs: TICK - 1,
        majorOutcomes: [],
      }),
    ).toBe(false);
    expect(
      isNonEmptyAccount({ appliedMs: 0, skippedMs: 0, majorOutcomes: [] }),
    ).toBe(false);
  });

  test("a tick applied, a tick skipped, or an outcome is something", () => {
    expect(
      isNonEmptyAccount({ appliedMs: TICK, skippedMs: 0, majorOutcomes: [] }),
    ).toBe(true);
    expect(
      isNonEmptyAccount({ appliedMs: 0, skippedMs: TICK, majorOutcomes: [] }),
    ).toBe(true);
    expect(
      isNonEmptyAccount({
        appliedMs: 0,
        skippedMs: 0,
        majorOutcomes: ["building-ignited:x"],
      }),
    ).toBe(true);
  });
});

describe("closeCatchUpBacklog", () => {
  test("with no open backlog it does nothing and leaves the previous summary alone", () => {
    const previous = {
      id: "previous",
      atSequence: 0,
      appliedMs: TICK,
      skippedMs: 0,
      majorOutcomes: [],
    };
    writeCatchUpSummary(store.db, previous);

    expect(closeCatchUpBacklog(store.db)).toBeUndefined();

    expect(readCatchUpSummary(store.db)).toEqual(previous);
  });

  test("an open non-empty backlog becomes a persisted summary with a service-minted id, and its progress is cleared, in one step", () => {
    writeCatchUpProgress(store.db, backlog({ discardedMs: 7_200_000 }));

    const closed = closeCatchUpBacklog(store.db);

    const persisted = readCatchUpSummary(store.db);
    expect(persisted).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      atSequence: 0,
      appliedMs: 120 * TICK,
      skippedMs: 7_200_000,
      majorOutcomes: [],
    });
    expect(closed?.delivered).toEqual(persisted);
    expect(readCatchUpProgress(store.db)).toBeUndefined();
  });

  test("an open backlog that amounts to nothing is closed without replacing the previous summary", () => {
    const previous = {
      id: "previous",
      atSequence: 0,
      appliedMs: 60 * TICK,
      skippedMs: 0,
      majorOutcomes: [],
    };
    writeCatchUpSummary(store.db, previous);
    writeCatchUpProgress(
      store.db,
      backlog({ appliedMs: 0, discardedMs: TICK - 1 }),
    );

    const closed = closeCatchUpBacklog(store.db);

    expect(closed?.delivered).toBeUndefined();
    expect(readCatchUpSummary(store.db)).toEqual(previous);
    expect(readCatchUpProgress(store.db)).toBeUndefined();
  });

  test("a different backlog gets a new id even when it ends at the same sequence as the previous summary did", () => {
    writeCatchUpProgress(store.db, backlog());
    const first = closeCatchUpBacklog(store.db)?.delivered;

    // An eventless second backlog: same ending sequence, different amounts.
    writeCatchUpProgress(store.db, backlog({ appliedMs: 30 * TICK }));
    const second = closeCatchUpBacklog(store.db)?.delivered;

    expect(first?.atSequence).toBe(second?.atSequence);
    expect(second?.id).not.toBe(first?.id);
    expect(readCatchUpSummary(store.db)).toEqual(second);
  });
});

describe("recordPartialSummary: a degraded catch-up keeps its backlog open", () => {
  test("it persists what the backlog committed and keeps the progress", () => {
    writeCatchUpProgress(store.db, backlog({ appliedMs: 60 * TICK }));

    const partial = recordPartialSummary(store.db);

    expect(partial).toMatchObject({ appliedMs: 60 * TICK, skippedMs: 0 });
    expect(readCatchUpSummary(store.db)).toEqual(partial);
    expect(readCatchUpProgress(store.db)?.appliedMs).toBe(60 * TICK);
  });

  test("a retry with no new committed progress reuses the id", () => {
    writeCatchUpProgress(store.db, backlog({ appliedMs: 60 * TICK }));
    const first = recordPartialSummary(store.db);

    const retry = recordPartialSummary(store.db);

    expect(retry?.id).toBe(first?.id);
  });

  test("a retry that changes the summary mints a new id", () => {
    writeCatchUpProgress(store.db, backlog({ appliedMs: 60 * TICK }));
    const first = recordPartialSummary(store.db);
    writeCatchUpProgress(store.db, backlog({ appliedMs: 120 * TICK }));

    const changed = recordPartialSummary(store.db);

    expect(changed?.id).not.toBe(first?.id);
    expect(changed?.appliedMs).toBe(120 * TICK);
  });

  test("closing the backlog with nothing new since the partial summary keeps its id, so a client that dismissed it is not shown it again", () => {
    writeCatchUpProgress(store.db, backlog({ appliedMs: 60 * TICK }));
    const partial = recordPartialSummary(store.db);

    const closed = closeCatchUpBacklog(store.db);

    expect(closed?.delivered?.id).toBe(partial?.id);
    expect(readCatchUpProgress(store.db)).toBeUndefined();
  });

  test("closing after more progress mints a new id", () => {
    writeCatchUpProgress(store.db, backlog({ appliedMs: 60 * TICK }));
    const partial = recordPartialSummary(store.db);
    writeCatchUpProgress(store.db, backlog({ appliedMs: 180 * TICK }));

    const closed = closeCatchUpBacklog(store.db);

    expect(closed?.delivered?.id).not.toBe(partial?.id);
    expect(closed?.delivered?.appliedMs).toBe(180 * TICK);
  });

  test("with no open backlog it persists nothing", () => {
    expect(recordPartialSummary(store.db)).toBeUndefined();
    expect(readCatchUpSummary(store.db)).toBeUndefined();
  });

  test("an empty backlog persists nothing and keeps the previous summary", () => {
    const previous = {
      id: "previous",
      atSequence: 0,
      appliedMs: 60 * TICK,
      skippedMs: 0,
      majorOutcomes: [],
    };
    writeCatchUpSummary(store.db, previous);
    writeCatchUpProgress(store.db, backlog({ appliedMs: 0, discardedMs: 1 }));

    expect(recordPartialSummary(store.db)).toBeUndefined();

    expect(readCatchUpSummary(store.db)).toEqual(previous);
    expect(readCatchUpProgress(store.db)).toBeDefined();
  });
});
