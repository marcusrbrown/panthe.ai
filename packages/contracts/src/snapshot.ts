// The sidecar's streaming protocol: one committed-state frame. A reconnect
// requests a fresh frame; there is no incremental delta protocol.

import { WORLD_EVENT_KINDS, type WorldEvent } from "./event";
import {
  type EntityId,
  type EventId,
  fail,
  isRecord,
  ok,
  type ParseResult,
  parseArray,
  parseEntityId,
  parseEnum,
  parseEventId,
  parseNonNegativeInteger,
  parseSchemaVersion,
  parseSessionId,
  parseString,
  parseWorldId,
  type SessionId,
  type WorldId,
} from "./ids";

export const SYNC_FRAME_SCHEMA_VERSIONS = [1] as const;

export const WORLD_STATUSES = ["running", "paused", "degraded"] as const;
export type WorldStatus = (typeof WORLD_STATUSES)[number];

export const DEGRADED_REASONS = [
  "store-error",
  "disk-full",
  "sidecar-unreachable",
  /** Every model endpoint failed. Unlike the others it never halts the world: routines and the director keep ticking. */
  "model-degraded",
] as const;
export type DegradedReason = (typeof DEGRADED_REASONS)[number];

export interface CatchUpSummary {
  /**
   * The summary's own identity, minted by the service when it persists the
   * summary and held until a different summary replaces it. A client
   * acknowledges a summary by this id, so it stays acknowledged across every
   * frame that repeats it and across a service restart, and a later
   * catch-up (a new id, even at the same sequence) shows again.
   */
  readonly id: string;
  readonly appliedMs: number;
  readonly skippedMs: number;
  readonly majorOutcomes: readonly string[];
  /** The committed sequence at which this catch-up finished; its outcomes are frozen at it. */
  readonly atSequence: number;
}

function parseCatchUpSummary(
  value: unknown,
  path: string,
): ParseResult<CatchUpSummary> {
  if (!isRecord(value)) {
    return fail(path, "expected a catch-up summary object");
  }
  const id = parseString(value.id, `${path}.id`);
  if (!id.ok) return id;
  if (id.value === "") {
    return fail(`${path}.id`, "expected a non-empty summary id");
  }
  const appliedMs = parseNonNegativeInteger(
    value.appliedMs,
    `${path}.appliedMs`,
  );
  if (!appliedMs.ok) return appliedMs;
  const skippedMs = parseNonNegativeInteger(
    value.skippedMs,
    `${path}.skippedMs`,
  );
  if (!skippedMs.ok) return skippedMs;
  const majorOutcomes = parseArray(
    value.majorOutcomes,
    `${path}.majorOutcomes`,
    parseString,
  );
  if (!majorOutcomes.ok) return majorOutcomes;
  const atSequence = parseNonNegativeInteger(
    value.atSequence,
    `${path}.atSequence`,
  );
  if (!atSequence.ok) return atSequence;
  return ok({
    id: id.value,
    appliedMs: appliedMs.value,
    skippedMs: skippedMs.value,
    majorOutcomes: majorOutcomes.value,
    atSequence: atSequence.value,
  });
}

/**
 * A committed event the frame's window still carries: enough for a client
 * to decide which events concern what it renders and to receipt the ones
 * it drew. `subjects` are the actor, building, location, and deity ids the
 * event touches.
 */
export interface RecentEvent {
  readonly id: EventId;
  readonly sequence: number;
  readonly tick: number;
  readonly kind: WorldEvent["kind"];
  readonly subjects: readonly EntityId[];
}

function parseRecentEvent(
  value: unknown,
  path: string,
): ParseResult<RecentEvent> {
  if (!isRecord(value)) {
    return fail(path, "expected a recent event object");
  }
  const id = parseEventId(value.id, `${path}.id`);
  if (!id.ok) return id;
  const sequence = parseNonNegativeInteger(value.sequence, `${path}.sequence`);
  if (!sequence.ok) return sequence;
  const tick = parseNonNegativeInteger(value.tick, `${path}.tick`);
  if (!tick.ok) return tick;
  const kind = parseEnum(value.kind, `${path}.kind`, WORLD_EVENT_KINDS);
  if (!kind.ok) return kind;
  const subjects = parseArray(
    value.subjects,
    `${path}.subjects`,
    parseEntityId,
  );
  if (!subjects.ok) return subjects;
  return ok({
    id: id.value,
    sequence: sequence.value,
    tick: tick.value,
    kind: kind.value,
    subjects: subjects.value,
  });
}

export interface SyncFrame {
  readonly schemaVersion: number;
  readonly sequence: number;
  readonly worldId: WorldId;
  readonly sessionId: SessionId;
  readonly status: WorldStatus;
  readonly degradedReason?: DegradedReason;
  readonly catchUpSummary?: CatchUpSummary;
  /** Committed events inside the sidecar's recent window, ascending by sequence. */
  readonly recentEvents: readonly RecentEvent[];
  /** Opaque projection payload; its shape is owned by packages/world. */
  readonly state: unknown;
}

export function parseSyncFrame(input: unknown): ParseResult<SyncFrame> {
  if (!isRecord(input)) {
    return fail("", "expected a state frame object");
  }

  const schemaVersion = parseSchemaVersion(
    input.schemaVersion,
    SYNC_FRAME_SCHEMA_VERSIONS,
  );
  if (!schemaVersion.ok) return schemaVersion;

  const sequence = parseNonNegativeInteger(input.sequence, "sequence");
  if (!sequence.ok) return sequence;

  const worldId = parseWorldId(input.worldId, "worldId");
  if (!worldId.ok) return worldId;

  const sessionId = parseSessionId(input.sessionId, "sessionId");
  if (!sessionId.ok) return sessionId;

  const status = parseEnum(input.status, "status", WORLD_STATUSES);
  if (!status.ok) return status;

  let degradedReason: DegradedReason | undefined;
  if (status.value === "degraded") {
    const reason = parseEnum(
      input.degradedReason,
      "degradedReason",
      DEGRADED_REASONS,
    );
    if (!reason.ok) return reason;
    degradedReason = reason.value;
  }

  let catchUpSummary: CatchUpSummary | undefined;
  if (input.catchUpSummary !== undefined) {
    const summary = parseCatchUpSummary(input.catchUpSummary, "catchUpSummary");
    if (!summary.ok) return summary;
    catchUpSummary = summary.value;
  }

  const recentEvents = parseArray(
    input.recentEvents,
    "recentEvents",
    parseRecentEvent,
  );
  if (!recentEvents.ok) return recentEvents;

  if (input.state === undefined) {
    return fail("state", "expected a state payload");
  }

  return ok({
    schemaVersion: schemaVersion.value,
    sequence: sequence.value,
    worldId: worldId.value,
    sessionId: sessionId.value,
    status: status.value,
    ...(degradedReason === undefined ? {} : { degradedReason }),
    ...(catchUpSummary === undefined ? {} : { catchUpSummary }),
    recentEvents: recentEvents.value,
    state: input.state,
  });
}
