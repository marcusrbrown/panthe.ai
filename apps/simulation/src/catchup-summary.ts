// The catch-up summary a client is shown, and the rules for when it is
// persisted, kept, and replaced. A summary is derived once, from the open
// backlog (`catch_up_progress`) and the events it committed, and is then
// stored as its own row (`catch_up_summary`) with a service-minted id. It is
// never re-derived: a summary persisted at a backlog's ending sequence stays
// exactly that while live ticks go on and later backlogs come and go.
//
// Every write here is meant to run inside the transaction that ends (or
// partially records) the backlog, so the summary row and the progress delete
// commit or roll back together, and only what committed is ever published.

import type { Database } from "bun:sqlite";
import {
  type CatchUpProgress,
  type CatchUpSummaryRecord,
  clearCatchUpProgress,
  getCurrentSequence,
  listEvents,
  readCatchUpProgress,
  readCatchUpSummary,
  writeCatchUpSummary,
} from "@panthea/persistence";
import { DEFAULT_TICK_ELAPSED_MS } from "@panthea/world";

/** Event kinds worth naming in the catch-up summary's `majorOutcomes`. */
export const MAJOR_EVENT_KINDS = new Set<string>([
  "building-ignited",
  "building-destroyed",
  "building-repaired",
  "legend-recorded",
]);

/** What a backlog applied, skipped, and found notable, before it has an identity or an ending sequence. */
export interface BacklogAccount {
  readonly appliedMs: number;
  readonly skippedMs: number;
  readonly majorOutcomes: readonly string[];
}

export const EMPTY_ACCOUNT: BacklogAccount = {
  appliedMs: 0,
  skippedMs: 0,
  majorOutcomes: [],
};

/**
 * A backlog's account, read from what it committed: time applied and
 * discarded from its progress row, and its notable outcomes from the events
 * committed after the sequence it started at, up to and including
 * `endSequence`. Bounding at the ending sequence is what keeps a summary
 * about its own backlog and not about events that happened after it.
 */
export function accountOf(
  db: Database,
  progress: CatchUpProgress,
  endSequence: number,
): BacklogAccount {
  return {
    appliedMs: progress.appliedMs,
    skippedMs: progress.discardedMs,
    majorOutcomes: listEvents(db, {
      fromSequence: progress.startSequence,
      toSequence: endSequence,
    })
      .filter((event) => MAJOR_EVENT_KINDS.has(event.kind))
      .map((event) => `${event.kind}:${String(event.entityId)}`),
  };
}

/**
 * Whether an account is something worth telling: at least one tick applied
 * or skipped, or an outcome. Less than that (a resume with no missed time, a
 * restart a few milliseconds after the store was created) is "nothing
 * happened" and must not open the panel or replace an earlier summary.
 */
export function isNonEmptyAccount(account: BacklogAccount): boolean {
  return (
    account.appliedMs >= DEFAULT_TICK_ELAPSED_MS ||
    account.skippedMs >= DEFAULT_TICK_ELAPSED_MS ||
    account.majorOutcomes.length > 0
  );
}

/** The account of the open backlog frozen at the current committed sequence, or `undefined` when none is open. */
export function openBacklogAccount(db: Database): BacklogAccount | undefined {
  const progress = readCatchUpProgress(db);
  return progress ? accountOf(db, progress, getCurrentSequence(db)) : undefined;
}

function sameAccount(
  existing: CatchUpSummaryRecord,
  account: BacklogAccount,
  atSequence: number,
): boolean {
  return (
    existing.atSequence === atSequence &&
    existing.appliedMs === account.appliedMs &&
    existing.skippedMs === account.skippedMs &&
    existing.majorOutcomes.length === account.majorOutcomes.length &&
    existing.majorOutcomes.every(
      (outcome, index) => outcome === account.majorOutcomes[index],
    )
  );
}

/**
 * Persists `account` as the latest summary. If it is exactly the summary
 * already persisted (a retry with no new committed progress), the id is
 * reused and nothing is written, so a client that acknowledged it is not shown
 * it again. Any difference mints a new id, even at the same sequence.
 */
function persistAccount(
  db: Database,
  account: BacklogAccount,
  atSequence: number,
): CatchUpSummaryRecord {
  const existing = readCatchUpSummary(db);
  if (existing && sameAccount(existing, account, atSequence)) {
    return existing;
  }
  const record: CatchUpSummaryRecord = {
    id: crypto.randomUUID(),
    atSequence,
    appliedMs: account.appliedMs,
    skippedMs: account.skippedMs,
    majorOutcomes: [...account.majorOutcomes],
  };
  writeCatchUpSummary(db, record);
  return record;
}

/**
 * Persists the open backlog's account as the latest summary but keeps the
 * backlog open: a degraded catch-up shows what it committed, and a retry
 * continues from the same progress. Returns the persisted summary, or
 * `undefined` when there is no open backlog or it amounts to nothing (the
 * previous summary is kept). One upsert, atomic on its own.
 */
export function recordPartialSummary(
  db: Database,
): CatchUpSummaryRecord | undefined {
  const progress = readCatchUpProgress(db);
  if (!progress) {
    return undefined;
  }
  const endSequence = getCurrentSequence(db);
  const account = accountOf(db, progress, endSequence);
  return isNonEmptyAccount(account)
    ? persistAccount(db, account, endSequence)
    : undefined;
}

export interface ClosedBacklog {
  /** What the backlog applied, skipped, and found, frozen at its ending sequence. */
  readonly account: BacklogAccount;
  /** The summary now persisted for it, or `undefined` when it amounted to nothing and the previous summary was kept. */
  readonly delivered: CatchUpSummaryRecord | undefined;
}

/**
 * Ends the open backlog: freezes its account at the current committed
 * sequence, persists it as the latest summary (unless it amounts to nothing),
 * and clears the progress. Call inside the commit transaction that ends the
 * backlog, so the summary and the delete commit or roll back with it. Returns
 * `undefined` when no backlog is open.
 */
export function closeCatchUpBacklog(db: Database): ClosedBacklog | undefined {
  const progress = readCatchUpProgress(db);
  if (!progress) {
    return undefined;
  }
  const endSequence = getCurrentSequence(db);
  const account = accountOf(db, progress, endSequence);
  const delivered = isNonEmptyAccount(account)
    ? persistAccount(db, account, endSequence)
    : undefined;
  clearCatchUpProgress(db);
  return { account, delivered };
}
