// The durable journal of external (fixture and operator) proposals. Intake
// appends an entry before it answers; a tick consumes the entries it runs in
// the same transaction as its own commit. Entries are kept after they are
// consumed: the trace holds the outcome, this table holds the input and the
// order it arrived in. Nothing here reads a clock -- order is `input_order`,
// and an entry becomes eligible at `target_tick`.
//
// Proposal and observation are stored as parsed JSON. This module never
// interprets them beyond comparing them for equality; packages/world and
// packages/contracts own what they mean.

import type { Database } from "bun:sqlite";
import { canonicalJson, type RejectionReasonCode } from "@panthea/contracts";

/** How a consumed proposal ended. A rejection always carries the reason code the world gave. */
export type ExternalProposalOutcome =
  | { readonly status: "committed" }
  | { readonly status: "rejected"; readonly reason: RejectionReasonCode };

interface ExternalProposalBase {
  readonly inputOrder: number;
  readonly proposalId: string;
  /** The first tick allowed to run this entry: the tick after the persisted clock when it was accepted. */
  readonly targetTick: number;
  readonly proposal: unknown;
  readonly observation: unknown;
}

/** Accepted and waiting for a tick. */
export interface PendingExternalProposal extends ExternalProposalBase {
  readonly consumedTick: undefined;
  readonly outcome: undefined;
}

/** Run by `consumedTick`, which recorded its terminal outcome on the row. */
export interface ConsumedExternalProposal extends ExternalProposalBase {
  readonly consumedTick: number;
  readonly outcome: ExternalProposalOutcome;
}

export type ExternalProposalEntry =
  | PendingExternalProposal
  | ConsumedExternalProposal;

export interface NewExternalProposal {
  readonly proposalId: string;
  readonly proposal: unknown;
  readonly observation: unknown;
}

export type InsertExternalProposalResult =
  /** A new entry was journaled. */
  | { readonly kind: "accepted"; readonly entry: ExternalProposalEntry }
  /** The id was already journaled with the same content; nothing was inserted. */
  | { readonly kind: "existing"; readonly entry: ExternalProposalEntry }
  /** The proposal id was already journaled with different content; nothing was inserted. */
  | { readonly kind: "conflict"; readonly entry: ExternalProposalEntry }
  /** A different proposal already journaled the same observation id with different observation content; nothing was inserted, and `entry` is that earlier proposal. */
  | {
      readonly kind: "observation-conflict";
      readonly entry: ExternalProposalEntry;
    };

interface JournalRow {
  input_order: number;
  proposal_id: string;
  target_tick: number;
  proposal: string;
  observation: string;
  consumed_tick: number | null;
  outcome: "committed" | "rejected" | null;
  reason: string | null;
}

function decode(row: JournalRow): ExternalProposalEntry {
  const base = {
    inputOrder: row.input_order,
    proposalId: row.proposal_id,
    targetTick: row.target_tick,
    proposal: JSON.parse(row.proposal) as unknown,
    observation: JSON.parse(row.observation) as unknown,
  };
  // The schema guarantees consumed_tick and outcome are set together.
  if (row.consumed_tick === null || row.outcome === null) {
    return { ...base, consumedTick: undefined, outcome: undefined };
  }
  return {
    ...base,
    consumedTick: row.consumed_tick,
    outcome:
      row.outcome === "rejected"
        ? { status: "rejected", reason: row.reason as RejectionReasonCode }
        : { status: "committed" },
  };
}

function sameContent(
  entry: ExternalProposalEntry,
  input: NewExternalProposal,
): boolean {
  return (
    canonicalJson({
      proposal: entry.proposal,
      observation: entry.observation,
    }) ===
    canonicalJson({ proposal: input.proposal, observation: input.observation })
  );
}

export function getExternalProposal(
  db: Database,
  proposalId: string,
): ExternalProposalEntry | undefined {
  const row = db
    .query("SELECT * FROM external_proposals WHERE proposal_id = ?")
    .get(proposalId) as JournalRow | null;
  return row ? decode(row) : undefined;
}

/**
 * Journals `input` in one transaction: allocates the next input order,
 * targets the tick after the persisted clock, and inserts. A retry of an id
 * already journaled returns that entry (or a conflict, when the content
 * differs) without inserting.
 */
export function insertExternalProposal(
  db: Database,
  input: NewExternalProposal,
): InsertExternalProposalResult {
  const run = db.transaction((): InsertExternalProposalResult => {
    const existing = getExternalProposal(db, input.proposalId);
    if (existing) {
      return {
        kind: sameContent(existing, input) ? "existing" : "conflict",
        entry: existing,
      };
    }
    // An observation id binds to one content: another proposal may cite the
    // same, unchanged observation, but not a changed one.
    const observationId = (input.observation as { id?: unknown } | null)?.id;
    if (typeof observationId === "string") {
      const earlier = db
        .query(
          "SELECT * FROM external_proposals WHERE json_extract(observation, '$.id') = ? ORDER BY input_order ASC LIMIT 1",
        )
        .get(observationId) as JournalRow | null;
      if (
        earlier &&
        canonicalJson(decode(earlier).observation) !==
          canonicalJson(input.observation)
      ) {
        return { kind: "observation-conflict", entry: decode(earlier) };
      }
    }
    const { tick } = db.query("SELECT tick FROM clock WHERE id = 1").get() as {
      tick: number;
    };
    const { next } = db
      .query(
        "SELECT COALESCE(MAX(input_order), 0) + 1 AS next FROM external_proposals",
      )
      .get() as { next: number };
    db.run(
      `INSERT INTO external_proposals (input_order, proposal_id, target_tick, proposal, observation)
       VALUES (?, ?, ?, ?, ?)`,
      [
        next,
        input.proposalId,
        tick + 1,
        JSON.stringify(input.proposal),
        JSON.stringify(input.observation),
      ],
    );
    const entry = getExternalProposal(db, input.proposalId);
    if (!entry) {
      throw new Error("journal: an inserted entry could not be read back");
    }
    return { kind: "accepted", entry };
  });
  return run.immediate();
}

/** Pending entries a tick numbered `tick` may run, in input order. */
export function readPendingExternalProposals(
  db: Database,
  tick: number,
): readonly ExternalProposalEntry[] {
  const rows = db
    .query(
      `SELECT * FROM external_proposals
       WHERE consumed_tick IS NULL AND target_tick <= ?
       ORDER BY input_order ASC`,
    )
    .all(tick) as JournalRow[];
  return rows.map(decode);
}

/** Every entry, pending and consumed, in input order. */
export function listExternalProposals(
  db: Database,
): readonly ExternalProposalEntry[] {
  return (
    db
      .query("SELECT * FROM external_proposals ORDER BY input_order ASC")
      .all() as JournalRow[]
  ).map(decode);
}

/**
 * Marks a pending entry consumed by `tick`, with its terminal `outcome`, in
 * one write. Call inside the consuming tick's `onCommitted`, so it commits or
 * rolls back with that tick. Throws when the entry is unknown or already
 * consumed: an entry runs at most once.
 */
export function markExternalProposalConsumed(
  db: Database,
  proposalId: string,
  tick: number,
  outcome: ExternalProposalOutcome,
): void {
  const result = db.run(
    `UPDATE external_proposals SET consumed_tick = ?, outcome = ?, reason = ?
     WHERE proposal_id = ? AND consumed_tick IS NULL`,
    [
      tick,
      outcome.status,
      outcome.status === "rejected" ? outcome.reason : null,
      proposalId,
    ],
  );
  if (result.changes !== 1) {
    throw new Error(
      `journal: proposal ${proposalId} is not pending (unknown or already consumed)`,
    );
  }
}
