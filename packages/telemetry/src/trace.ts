// The local causal trace store: observation records, proposals (accepted
// and rejected), and presentation receipts, linked by correlation/causation
// IDs (Key Technical Decisions). Always on — local causal recording and
// inspection are always on; external export is a separate, opt-in concern
// (docs/README.md invariants) this module does not implement.
//
// Deliberately decoupled from packages/persistence: this module takes a
// plain `bun:sqlite` `Database` handle (the composing service, e.g.
// apps/simulation, decides whether that is the same physical file as the
// world store or a dedicated trace file) and an injected `EventSource` for
// resolving committed events by ID, rather than depending on
// @panthea/persistence's `Store` type. `packages/telemetry`'s package.json
// only declares `@panthea/contracts` as a dependency; adding a workspace
// dependency on persistence was out of scope for this unit (see the
// report accompanying this change).
//
// Contracts gap (reported, not fixed here): `packages/contracts`' Proposal
// shapes have no `id`/`proposalId` field, so a proposal can't be addressed
// by trace records without one. This module mints a local `ProposalId`
// brand using contracts' own generic `idParser`/`idFactory` helpers rather
// than editing packages/contracts.

import type { Database } from "bun:sqlite";
import type {
  Brand,
  CausationId,
  CorrelationId,
  EventId,
  ObservationId,
  ObservationRecord,
  Proposal,
  RejectionReasonCode,
  SessionId,
  WorldEvent,
} from "@panthea/contracts";
import { idFactory, idParser } from "@panthea/contracts";

export type ProposalId = Brand<string, "ProposalId">;
export const parseProposalId = idParser<"ProposalId">();
export const createProposalId = idFactory<"ProposalId">("proposal");

export type ReceiptId = Brand<string, "ReceiptId">;
export const createReceiptId = idFactory<"ReceiptId">("receipt");

/** Marker returned by every trace read once retention pruning has dropped the payload body for that row. */
export const PAYLOAD_EXPIRED = "payload expired" as const;
export type PayloadExpired = typeof PAYLOAD_EXPIRED;

/** Resolves committed events by ID. Injected so this module never assumes a specific events table shape (packages/persistence owns that). */
export interface EventSource {
  getEvent(id: EventId): WorldEvent | undefined;
}

/** Creates the trace tables (idempotent). Safe to call on every open — no `user_version` ladder, since these tables are additive and never need a destructive migration in M1. */
export function ensureTraceSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trace_observations (
      id TEXT PRIMARY KEY,
      observer TEXT NOT NULL,
      state_revision INTEGER NOT NULL,
      source TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      payload TEXT,
      payload_expired INTEGER NOT NULL DEFAULT 0
    ) STRICT
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS trace_proposal_outcomes (
      proposal_id TEXT PRIMARY KEY,
      observation_id TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      causation_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      reason TEXT,
      event_id TEXT,
      recorded_at INTEGER NOT NULL,
      payload TEXT,
      payload_expired INTEGER NOT NULL DEFAULT 0,
      CHECK (outcome IN ('committed', 'rejected'))
    ) STRICT
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_trace_proposal_outcomes_event_id
    ON trace_proposal_outcomes(event_id)
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS trace_receipts (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      is_orphan INTEGER NOT NULL,
      recorded_at INTEGER NOT NULL,
      payload TEXT,
      payload_expired INTEGER NOT NULL DEFAULT 0,
      UNIQUE (event_id, session_id)
    ) STRICT
  `);
}

export function recordObservation(
  db: Database,
  record: ObservationRecord,
  now: number = Date.now(),
): void {
  db.run(
    `INSERT OR IGNORE INTO trace_observations
       (id, observer, state_revision, source, recorded_at, payload)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.observer,
      record.stateRevision,
      record.source,
      now,
      JSON.stringify(record),
    ],
  );
}

export interface ObservationEntry {
  readonly record: ObservationRecord | PayloadExpired;
}

export function getObservation(
  db: Database,
  id: ObservationId,
): ObservationEntry | undefined {
  const row = db
    .query(
      "SELECT payload, payload_expired FROM trace_observations WHERE id = ?",
    )
    .get(id) as { payload: string | null; payload_expired: number } | null;
  if (!row) {
    return undefined;
  }
  if (row.payload_expired) {
    return { record: PAYLOAD_EXPIRED };
  }
  return { record: JSON.parse(row.payload as string) as ObservationRecord };
}

export type ProposalOutcomeKind = "committed" | "rejected";

export interface RecordProposalOutcomeInput {
  readonly proposalId: ProposalId;
  readonly observationId: ObservationId;
  readonly correlationId: CorrelationId;
  readonly causationId: CausationId;
  readonly proposal: Proposal;
  readonly outcome: ProposalOutcomeKind;
  readonly reason?: RejectionReasonCode;
  readonly eventId?: EventId;
}

export function recordProposalOutcome(
  db: Database,
  input: RecordProposalOutcomeInput,
  now: number = Date.now(),
): void {
  db.run(
    `INSERT OR IGNORE INTO trace_proposal_outcomes
       (proposal_id, observation_id, correlation_id, causation_id, outcome, reason, event_id, recorded_at, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.proposalId,
      input.observationId,
      input.correlationId,
      input.causationId,
      input.outcome,
      input.reason ?? null,
      input.eventId ?? null,
      now,
      JSON.stringify(input.proposal),
    ],
  );
}

export interface ProposalOutcomeRow {
  readonly proposalId: ProposalId;
  readonly observationId: ObservationId;
  readonly correlationId: CorrelationId;
  readonly causationId: CausationId;
  readonly outcome: ProposalOutcomeKind;
  readonly reason: RejectionReasonCode | undefined;
  readonly eventId: EventId | undefined;
  readonly proposal: Proposal | PayloadExpired;
}

function decodeProposalOutcomeRow(row: {
  proposal_id: string;
  observation_id: string;
  correlation_id: string;
  causation_id: string;
  outcome: string;
  reason: string | null;
  event_id: string | null;
  payload: string | null;
  payload_expired: number;
}): ProposalOutcomeRow {
  return {
    proposalId: row.proposal_id as ProposalId,
    observationId: row.observation_id as ObservationId,
    correlationId: row.correlation_id as CorrelationId,
    causationId: row.causation_id as CausationId,
    outcome: row.outcome as ProposalOutcomeKind,
    reason: (row.reason ?? undefined) as RejectionReasonCode | undefined,
    eventId: (row.event_id ?? undefined) as EventId | undefined,
    proposal: row.payload_expired
      ? PAYLOAD_EXPIRED
      : (JSON.parse(row.payload as string) as Proposal),
  };
}

export function getProposalOutcomeByProposalId(
  db: Database,
  proposalId: ProposalId,
): ProposalOutcomeRow | undefined {
  const row = db
    .query("SELECT * FROM trace_proposal_outcomes WHERE proposal_id = ?")
    .get(proposalId) as Parameters<typeof decodeProposalOutcomeRow>[0] | null;
  return row ? decodeProposalOutcomeRow(row) : undefined;
}

export function getProposalOutcomeByEventId(
  db: Database,
  eventId: EventId,
): ProposalOutcomeRow | undefined {
  const row = db
    .query("SELECT * FROM trace_proposal_outcomes WHERE event_id = ?")
    .get(eventId) as Parameters<typeof decodeProposalOutcomeRow>[0] | null;
  return row ? decodeProposalOutcomeRow(row) : undefined;
}

export interface RecordReceiptInput {
  readonly id: ReceiptId;
  readonly eventId: EventId;
  readonly sessionId: SessionId;
  readonly payload?: unknown;
}

export interface RecordReceiptResult {
  /** True when `eventId` did not resolve via the injected `EventSource` — stored as an orphan trace record, never mutating world tables. */
  readonly orphan: boolean;
}

/**
 * Append-only, idempotent per (event, session) via the table's UNIQUE
 * constraint plus `INSERT OR IGNORE`. Never issues a write to any world
 * table — this module has no reference to packages/persistence's `Store`
 * and cannot reach them even by mistake.
 */
export function recordReceipt(
  db: Database,
  eventSource: EventSource,
  input: RecordReceiptInput,
  now: number = Date.now(),
): RecordReceiptResult {
  const orphan = eventSource.getEvent(input.eventId) === undefined;
  db.run(
    `INSERT OR IGNORE INTO trace_receipts
       (id, event_id, session_id, is_orphan, recorded_at, payload)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.eventId,
      input.sessionId,
      orphan ? 1 : 0,
      now,
      JSON.stringify(input.payload ?? null),
    ],
  );
  return { orphan };
}

export interface ReceiptRow {
  readonly id: ReceiptId;
  readonly eventId: EventId;
  readonly sessionId: SessionId;
  readonly orphan: boolean;
  readonly payload: unknown | PayloadExpired;
}

export function listReceiptsByEvent(
  db: Database,
  eventId: EventId,
): readonly ReceiptRow[] {
  const rows = db
    .query(
      "SELECT * FROM trace_receipts WHERE event_id = ? ORDER BY recorded_at ASC",
    )
    .all(eventId) as {
    id: string;
    event_id: string;
    session_id: string;
    is_orphan: number;
    payload: string | null;
    payload_expired: number;
  }[];
  return rows.map((row) => ({
    id: row.id as ReceiptId,
    eventId: row.event_id as EventId,
    sessionId: row.session_id as SessionId,
    orphan: row.is_orphan !== 0,
    payload: row.payload_expired
      ? PAYLOAD_EXPIRED
      : (JSON.parse(row.payload as string) as unknown),
  }));
}

/**
 * Retention pruning: drops payload bodies for rows older than `olderThanMs`
 * but keeps every causal edge (IDs, correlation/causation, event links) and
 * a tombstone (`payload_expired = 1`) — follow-event queries keep walking
 * the full chain and mark expired hops instead of breaking (Key Technical
 * Decisions: "pruning drops payload bodies only").
 */
export function pruneRetention(
  db: Database,
  olderThanMs: number,
  now: number = Date.now(),
): void {
  const cutoff = now - olderThanMs;
  db.transaction(() => {
    db.run(
      "UPDATE trace_observations SET payload = NULL, payload_expired = 1 WHERE recorded_at < ? AND payload_expired = 0",
      [cutoff],
    );
    db.run(
      "UPDATE trace_proposal_outcomes SET payload = NULL, payload_expired = 1 WHERE recorded_at < ? AND payload_expired = 0",
      [cutoff],
    );
    db.run(
      "UPDATE trace_receipts SET payload = NULL, payload_expired = 1 WHERE recorded_at < ? AND payload_expired = 0",
      [cutoff],
    );
  }).immediate();
}
