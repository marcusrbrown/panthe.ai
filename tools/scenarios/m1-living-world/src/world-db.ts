// Read-only views of a world slot's SQLite file, for the facts no sidecar
// endpoint exposes: event payloads and correlation ids, the wall cursor, the
// proposal journal and catch-up progress, and any state inspected while the
// sidecar is stopped or killed. Anything /frame, /trace/*, or a proposal retry
// already serves is read through the API (`steps/api.ts`), not here; the
// story-bound accessors in `steps/direct.ts` name why each read stays direct.

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { canonicalJson } from "./helpers";

export interface EventRow {
  readonly sequence: number;
  readonly id: string;
  readonly correlationId: string;
  readonly kind: string;
  readonly approximate: boolean;
  /** The parsed event payload. */
  readonly payload: Record<string, unknown>;
}

export interface ClockRow {
  readonly cursorWallMs: number;
  readonly paused: boolean;
  readonly tick: number;
  readonly simTimeMs: number;
}

export function activeStorePath(dataDir: string): string {
  return join(dataDir, "active", "world.sqlite");
}

export function slotStorePath(slotPath: string): string {
  return join(slotPath, "world.sqlite");
}

/**
 * Runs the read-only query `fn` against the store at `path`. A live
 * sidecar's store opens read-only. A cleanly stopped store has no `-shm`
 * file, and SQLite cannot open a WAL database read-only without one, so
 * that case retries with a read-write handle (`fn` only reads).
 */
export function withWorldDb<T>(path: string, fn: (db: Database) => T): T {
  for (const readonly of [true, false]) {
    const db = new Database(
      path,
      readonly ? { readonly: true } : { readwrite: true },
    );
    try {
      return fn(db);
    } catch (error) {
      if (readonly && (error as { code?: string }).code === "SQLITE_CANTOPEN") {
        continue;
      }
      throw error;
    } finally {
      db.close();
    }
  }
  throw new Error("unreachable");
}

export function readClockRow(db: Database): ClockRow {
  const row = db
    .query(
      "SELECT cursor_wall_ms, paused, tick, sim_time_ms FROM clock WHERE id = 1",
    )
    .get() as {
    cursor_wall_ms: number;
    paused: number;
    tick: number;
    sim_time_ms: number;
  };
  return {
    cursorWallMs: row.cursor_wall_ms,
    paused: row.paused !== 0,
    tick: row.tick,
    simTimeMs: row.sim_time_ms,
  };
}

export function readEventRows(db: Database, fromSequence = 1): EventRow[] {
  const rows = db
    .query(
      "SELECT sequence, id, correlation_id, kind, approximate, payload FROM events WHERE sequence >= ? ORDER BY sequence ASC",
    )
    .all(fromSequence) as {
    sequence: number;
    id: string;
    correlation_id: string;
    kind: string;
    approximate: number;
    payload: string;
  }[];
  return rows.map((row) => ({
    sequence: row.sequence,
    id: row.id,
    correlationId: row.correlation_id,
    kind: row.kind,
    approximate: row.approximate !== 0,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  }));
}

export function readMaxSequence(db: Database): number {
  const row = db.query("SELECT MAX(sequence) AS m FROM events").get() as {
    m: number | null;
  };
  return row.m ?? 0;
}

export function readObservationSources(db: Database): Record<string, number> {
  const rows = db
    .query(
      "SELECT source, COUNT(*) AS n FROM trace_observations GROUP BY source",
    )
    .all() as { source: string; n: number }[];
  return Object.fromEntries(rows.map((row) => [row.source, row.n]));
}

export function integrityCheck(db: Database): string {
  return (
    db.query("PRAGMA integrity_check").get() as { integrity_check: string }
  ).integrity_check;
}

/** A digest of events 1..`throughSequence` (ids and canonical payloads), to compare two stores' histories independent of key order. */
export function hashEventPrefix(db: Database, throughSequence: number): string {
  const hasher = new Bun.CryptoHasher("sha256");
  const rows = db
    .query(
      "SELECT id, payload FROM events WHERE sequence <= ? ORDER BY sequence ASC",
    )
    .iterate(throughSequence) as IterableIterator<{
    id: string;
    payload: string;
  }>;
  for (const row of rows) {
    hasher.update(`${row.id}\n${canonicalJson(JSON.parse(row.payload))}\n`);
  }
  return hasher.digest("hex");
}

export interface ReceiptWithKind {
  readonly eventId: string;
  readonly sessionId: string;
  readonly kind: string;
}

export function readReceiptsWithKinds(db: Database): ReceiptWithKind[] {
  const rows = db
    .query(
      "SELECT r.event_id, r.session_id, e.kind FROM trace_receipts r JOIN events e ON e.id = r.event_id",
    )
    .all() as { event_id: string; session_id: string; kind: string }[];
  return rows.map((row) => ({
    eventId: row.event_id,
    sessionId: row.session_id,
    kind: row.kind,
  }));
}

/** Rewrites the persisted wall cursor of a stopped sidecar's store. Fault injection: the harness simulating a machine that slept. */
export function backdateCursor(path: string, cursorWallMs: number): void {
  const db = new Database(path);
  try {
    db.run("UPDATE clock SET cursor_wall_ms = ? WHERE id = 1", [cursorWallMs]);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

export interface JournalRow {
  readonly inputOrder: number;
  readonly proposalId: string;
  readonly targetTick: number;
  readonly consumedTick: number | undefined;
  readonly outcome: string | undefined;
  readonly reason: string | undefined;
  readonly observationId: string;
}

/** The durable proposal journal (`external_proposals`), in input order. */
export function readJournal(db: Database): JournalRow[] {
  const rows = db
    .query(
      "SELECT input_order, proposal_id, target_tick, consumed_tick, outcome, reason, observation FROM external_proposals ORDER BY input_order ASC",
    )
    .all() as {
    input_order: number;
    proposal_id: string;
    target_tick: number;
    consumed_tick: number | null;
    outcome: string | null;
    reason: string | null;
    observation: string;
  }[];
  return rows.map((row) => ({
    inputOrder: row.input_order,
    proposalId: row.proposal_id,
    targetTick: row.target_tick,
    consumedTick: row.consumed_tick ?? undefined,
    outcome: row.outcome ?? undefined,
    reason: row.reason ?? undefined,
    observationId: (JSON.parse(row.observation) as { id: string }).id,
  }));
}

export interface CatchUpProgressRow {
  readonly appliedMs: number;
  readonly discardedMs: number;
}

/** The unfinished catch-up backlog's committed progress, or undefined when none is in progress. */
export function readCatchUpProgressRow(
  db: Database,
): CatchUpProgressRow | undefined {
  const row = db
    .query(
      "SELECT applied_ms, discarded_ms FROM catch_up_progress WHERE id = 1",
    )
    .get() as { applied_ms: number; discarded_ms: number } | null;
  return row
    ? { appliedMs: row.applied_ms, discardedMs: row.discarded_ms }
    : undefined;
}

/** Whether an operator observation naming `fact` is on record (the trace stores what an operator action read). */
export function operatorObservationExists(db: Database, fact: string): boolean {
  const rows = db
    .query("SELECT payload FROM trace_observations WHERE source = 'operator'")
    .all() as { payload: string }[];
  return rows.some((row) => row.payload.includes(fact));
}
