// Read-only views of a world slot's SQLite file. The scenario asserts on
// committed rows (events, clock, trace), so it reads them from the store
// itself rather than trusting a summary the service built.

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

export interface OutcomeRow {
  readonly proposalId: string;
  readonly observationId: string;
  readonly outcome: "committed" | "rejected";
  readonly reason: string | null;
  readonly eventId: string | null;
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

export function readOutcomesForObservation(
  db: Database,
  observationId: string,
): OutcomeRow[] {
  const rows = db
    .query(
      "SELECT proposal_id, observation_id, outcome, reason, event_id FROM trace_proposal_outcomes WHERE observation_id = ?",
    )
    .all(observationId) as {
    proposal_id: string;
    observation_id: string;
    outcome: "committed" | "rejected";
    reason: string | null;
    event_id: string | null;
  }[];
  return rows.map((row) => ({
    proposalId: row.proposal_id,
    observationId: row.observation_id,
    outcome: row.outcome,
    reason: row.reason,
    eventId: row.event_id,
  }));
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
