// The sidecar's streaming protocol: a snapshot pinned to a committed event
// sequence, followed by sequenced deltas; a resync marker when a subscriber
// falls behind; a session-change marker when the sidecar restarts and mints
// a new session; a catch-up summary; and a degraded-status frame. These are
// the only shapes that cross the loopback WebSocket / Tauri Channel
// boundary described in Key Technical Decisions' transport design.

import { parseEvent, type WorldEvent } from "./event";
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

export interface SnapshotFrame {
  readonly kind: "snapshot";
  readonly schemaVersion: number;
  readonly sessionId: SessionId;
  readonly sessionGeneration: number;
  readonly sequence: number;
  readonly worldId: WorldId;
  /** Opaque projection payload; its shape is owned by packages/world (Unit 3+). */
  readonly projections: unknown;
}

export interface DeltaFrame {
  readonly kind: "delta";
  readonly schemaVersion: number;
  readonly sessionId: SessionId;
  readonly sessionGeneration: number;
  readonly sequence: number;
  readonly events: readonly WorldEvent[];
}

export interface ResyncFrame {
  readonly kind: "resync";
  readonly schemaVersion: number;
  readonly sessionId: SessionId;
  readonly sessionGeneration: number;
  readonly reason: string;
}

export interface SessionChangeFrame {
  readonly kind: "session-change";
  readonly schemaVersion: number;
  readonly sessionId: SessionId;
  readonly sessionGeneration: number;
}

export interface CatchUpSummaryFrame {
  readonly kind: "catch-up-summary";
  readonly schemaVersion: number;
  readonly sessionId: SessionId;
  readonly sessionGeneration: number;
  readonly appliedMs: number;
  readonly skippedMs: number;
  readonly majorOutcomes: readonly string[];
}

export const DEGRADED_REASONS = [
  "store-error",
  "disk-full",
  "sidecar-unreachable",
] as const;
export type DegradedReason = (typeof DEGRADED_REASONS)[number];

export interface DegradedStatusFrame {
  readonly kind: "degraded-status";
  readonly schemaVersion: number;
  readonly sessionId: SessionId;
  readonly sessionGeneration: number;
  readonly degraded: boolean;
  readonly reason?: DegradedReason;
}

export type SyncFrame =
  | SnapshotFrame
  | DeltaFrame
  | ResyncFrame
  | SessionChangeFrame
  | CatchUpSummaryFrame
  | DegradedStatusFrame;

export function parseSyncFrame(input: unknown): ParseResult<SyncFrame> {
  if (!isRecord(input)) {
    return fail("", "expected a sync frame object");
  }

  const schemaVersion = parseSchemaVersion(
    input.schemaVersion,
    SYNC_FRAME_SCHEMA_VERSIONS,
  );
  if (!schemaVersion.ok) return schemaVersion;

  const sessionId = parseSessionId(input.sessionId, "sessionId");
  if (!sessionId.ok) return sessionId;

  const sessionGeneration = parseNonNegativeInteger(
    input.sessionGeneration,
    "sessionGeneration",
  );
  if (!sessionGeneration.ok) return sessionGeneration;

  const envelope = {
    schemaVersion: schemaVersion.value,
    sessionId: sessionId.value,
    sessionGeneration: sessionGeneration.value,
  };

  switch (input.kind) {
    case "snapshot": {
      const sequence = parseNonNegativeInteger(input.sequence, "sequence");
      if (!sequence.ok) return sequence;
      const worldId = parseWorldId(input.worldId, "worldId");
      if (!worldId.ok) return worldId;
      if (input.projections === undefined) {
        return fail("projections", "expected a projections payload");
      }
      return ok({
        ...envelope,
        kind: "snapshot",
        sequence: sequence.value,
        worldId: worldId.value,
        projections: input.projections,
      });
    }
    case "delta": {
      const sequence = parseNonNegativeInteger(input.sequence, "sequence");
      if (!sequence.ok) return sequence;
      const events = parseArray(input.events, "events", parseEvent);
      if (!events.ok) return events;
      return ok({
        ...envelope,
        kind: "delta",
        sequence: sequence.value,
        events: events.value,
      });
    }
    case "resync": {
      const reason = parseString(input.reason, "reason");
      if (!reason.ok) return reason;
      return ok({ ...envelope, kind: "resync", reason: reason.value });
    }
    case "session-change":
      return ok({ ...envelope, kind: "session-change" });
    case "catch-up-summary": {
      const appliedMs = parseNonNegativeInteger(input.appliedMs, "appliedMs");
      if (!appliedMs.ok) return appliedMs;
      const skippedMs = parseNonNegativeInteger(input.skippedMs, "skippedMs");
      if (!skippedMs.ok) return skippedMs;
      const majorOutcomes = parseArray(
        input.majorOutcomes,
        "majorOutcomes",
        parseString,
      );
      if (!majorOutcomes.ok) return majorOutcomes;
      return ok({
        ...envelope,
        kind: "catch-up-summary",
        appliedMs: appliedMs.value,
        skippedMs: skippedMs.value,
        majorOutcomes: majorOutcomes.value,
      });
    }
    case "degraded-status": {
      const degraded = input.degraded;
      if (typeof degraded !== "boolean") {
        return fail("degraded", "expected a boolean");
      }
      const reason =
        input.reason === undefined
          ? ok<DegradedReason | undefined>(undefined)
          : parseEnum(input.reason, "reason", DEGRADED_REASONS);
      if (!reason.ok) return reason;
      return ok({
        ...envelope,
        kind: "degraded-status",
        degraded,
        ...(reason.value === undefined ? {} : { reason: reason.value }),
      });
    }
    default:
      return fail(
        "kind",
        `unknown sync frame kind: ${String(input.kind)}`,
        "unknown-kind",
      );
  }
}
