// The local causal trace store: observation records, proposals (accepted
// and rejected), and presentation receipts, linked by correlation/causation
// IDs (Key Technical Decisions). Local causal recording and inspection are
// always on; external export is a separate, opt-in concern (docs/README.md
// invariants) this module does not implement.
//
// Deliberately decoupled from packages/persistence: this module takes a
// plain `bun:sqlite` `Database` handle (the composing service, e.g.
// apps/simulation, decides whether that is the same physical file as the
// world store or a dedicated trace file) and an injected `EventSource` for
// resolving committed events by ID, rather than depending on
// @panthea/persistence's `Store` type. `packages/telemetry`'s package.json
// only declares `@panthea/contracts` as a dependency.
//
// `packages/contracts`' Proposal shapes have no `id`/`proposalId` field, so
// a proposal can't be addressed by trace records without one. This module
// mints a local `ProposalId` brand using contracts' own generic
// `idParser`/`idFactory` helpers rather than editing packages/contracts.

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

/** Resolves committed events by ID. Injected so this module never assumes a specific events table shape (packages/persistence owns that). */
export interface EventSource {
  getEvent(id: EventId): WorldEvent | undefined;
}

/** Creates the trace tables (idempotent). Safe to call on every open. */
export function ensureTraceSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trace_observations (
      id TEXT PRIMARY KEY,
      observer TEXT NOT NULL,
      state_revision INTEGER NOT NULL,
      source TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      payload TEXT NOT NULL
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
      payload TEXT NOT NULL,
      CHECK (outcome IN ('committed', 'rejected'))
    ) STRICT
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_trace_proposal_outcomes_event_id
    ON trace_proposal_outcomes(event_id)
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS trace_receipts (
      event_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      presented_at_ms INTEGER NOT NULL,
      PRIMARY KEY (event_id, session_id)
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
  readonly record: ObservationRecord;
}

export function getObservation(
  db: Database,
  id: ObservationId,
): ObservationEntry | undefined {
  const row = db
    .query("SELECT payload FROM trace_observations WHERE id = ?")
    .get(id) as { payload: string } | null;
  if (!row) {
    return undefined;
  }
  return { record: JSON.parse(row.payload) as ObservationRecord };
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
  readonly proposal: Proposal;
}

function decodeProposalOutcomeRow(row: {
  proposal_id: string;
  observation_id: string;
  correlation_id: string;
  causation_id: string;
  outcome: string;
  reason: string | null;
  event_id: string | null;
  payload: string;
}): ProposalOutcomeRow {
  return {
    proposalId: row.proposal_id as ProposalId,
    observationId: row.observation_id as ObservationId,
    correlationId: row.correlation_id as CorrelationId,
    causationId: row.causation_id as CausationId,
    outcome: row.outcome as ProposalOutcomeKind,
    reason: (row.reason ?? undefined) as RejectionReasonCode | undefined,
    eventId: (row.event_id ?? undefined) as EventId | undefined,
    proposal: JSON.parse(row.payload) as Proposal,
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
  readonly eventId: EventId;
  readonly sessionId: SessionId;
}

/** Thrown by `recordReceipt` when `eventId` does not resolve via the injected `EventSource`. */
export class UnknownEventError extends Error {
  constructor(readonly eventId: EventId) {
    super(`recordReceipt: unknown event id ${eventId}`);
    this.name = "UnknownEventError";
  }
}

/**
 * Records that `sessionId` presented `eventId`. Rejects with
 * `UnknownEventError` if `eventId` does not resolve via `eventSource` --
 * a receipt only ever names a real, committed event. Idempotent per
 * (event, session) via the table's primary key plus `INSERT OR IGNORE`.
 */
export function recordReceipt(
  db: Database,
  eventSource: EventSource,
  input: RecordReceiptInput,
  presentedAtMs: number = Date.now(),
): void {
  if (eventSource.getEvent(input.eventId) === undefined) {
    throw new UnknownEventError(input.eventId);
  }
  db.run(
    `INSERT OR IGNORE INTO trace_receipts
       (event_id, session_id, presented_at_ms)
     VALUES (?, ?, ?)`,
    [input.eventId, input.sessionId, presentedAtMs],
  );
}

export interface ReceiptRow {
  readonly eventId: EventId;
  readonly sessionId: SessionId;
  readonly presentedAtMs: number;
}

export function listReceiptsByEvent(
  db: Database,
  eventId: EventId,
): readonly ReceiptRow[] {
  const rows = db
    .query(
      "SELECT * FROM trace_receipts WHERE event_id = ? ORDER BY presented_at_ms ASC",
    )
    .all(eventId) as {
    event_id: string;
    session_id: string;
    presented_at_ms: number;
  }[];
  return rows.map((row) => ({
    eventId: row.event_id as EventId,
    sessionId: row.session_id as SessionId,
    presentedAtMs: row.presented_at_ms,
  }));
}
