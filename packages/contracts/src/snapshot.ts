// The sidecar's streaming protocol: one committed-state frame. A reconnect
// requests a fresh frame; there is no incremental delta protocol.

import {
  fail,
  isRecord,
  ok,
  type ParseResult,
  parseArray,
  parseEnum,
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
] as const;
export type DegradedReason = (typeof DEGRADED_REASONS)[number];

export interface CatchUpSummary {
  readonly appliedMs: number;
  readonly skippedMs: number;
  readonly majorOutcomes: readonly string[];
}

function parseCatchUpSummary(
  value: unknown,
  path: string,
): ParseResult<CatchUpSummary> {
  if (!isRecord(value)) {
    return fail(path, "expected a catch-up summary object");
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
  return ok({
    appliedMs: appliedMs.value,
    skippedMs: skippedMs.value,
    majorOutcomes: majorOutcomes.value,
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
    state: input.state,
  });
}
