// Shared parse-don't-validate primitives and branded identifiers for
// every wire and storage shape. Parsers never throw on untrusted input;
// they return a typed success or a structured failure naming the field
// path and a reason code, following tools/probes/shared/src/schema.ts.
//
// The same RejectionReasonCode vocabulary is used both for structural
// parse failures here and for execution-time proposal validation in
// packages/world, so there is one taxonomy of "why didn't this become
// world state" instead of two parallel ones.

declare const brandTag: unique symbol;

/** Nominal type: `T` tagged at compile time with the `TBrand` string literal. */
export type Brand<T, TBrand extends string> = T & {
  readonly [brandTag]: TBrand;
};

export const REJECTION_REASON_CODES = [
  "malformed",
  "unknown-kind",
  "unsupported-version",
  "stale-target",
  "insufficient-resources",
  "insufficient-power",
  "dead-actor",
  "not-adjacent",
  "restricted-realm",
  "busy-actor",
  "unauthorized-claim",
  "counterparty-declined",
  "over-limit",
  "observation-conflict",
  /** A practice move or talk that moves nothing forward: it repeats an answered move, restates an offer already on the table, or talks around an open thread. */
  "no-progress",
] as const;

export type RejectionReasonCode = (typeof REJECTION_REASON_CODES)[number];

export interface ParseSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export interface ParseFailure {
  readonly ok: false;
  readonly reason: RejectionReasonCode;
  readonly path: string;
  readonly message: string;
}

export type ParseResult<T> = ParseSuccess<T> | ParseFailure;

export function ok<T>(value: T): ParseSuccess<T> {
  return { ok: true, value };
}

export function fail(
  path: string,
  message: string,
  reason: RejectionReasonCode = "malformed",
): ParseFailure {
  return { ok: false, reason, path, message };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseString(value: unknown, path: string): ParseResult<string> {
  if (typeof value !== "string" || value.length === 0) {
    return fail(path, "expected a non-empty string");
  }
  return ok(value);
}

export function parseOptionalString(
  value: unknown,
  path: string,
): ParseResult<string | undefined> {
  if (value === undefined) {
    return ok(undefined);
  }
  return parseString(value, path);
}

export function parseFiniteNumber(
  value: unknown,
  path: string,
): ParseResult<number> {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fail(path, "expected a finite number");
  }
  return ok(value);
}

export function parseNonNegativeNumber(
  value: unknown,
  path: string,
): ParseResult<number> {
  const result = parseFiniteNumber(value, path);
  if (!result.ok) {
    return result;
  }
  if (result.value < 0) {
    return fail(path, "expected a non-negative number");
  }
  return result;
}

export function parseNonNegativeInteger(
  value: unknown,
  path: string,
): ParseResult<number> {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return fail(path, "expected a non-negative integer");
  }
  return ok(value);
}

export function parseBoolean(
  value: unknown,
  path: string,
): ParseResult<boolean> {
  if (typeof value !== "boolean") {
    return fail(path, "expected a boolean");
  }
  return ok(value);
}

export function parseOptionalBoolean(
  value: unknown,
  path: string,
): ParseResult<boolean | undefined> {
  if (value === undefined) {
    return ok(undefined);
  }
  return parseBoolean(value, path);
}

export function parseEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): ParseResult<T> {
  if (
    typeof value !== "string" ||
    !(allowed as readonly string[]).includes(value)
  ) {
    return fail(path, `expected one of: ${allowed.join(", ")}`);
  }
  return ok(value as T);
}

export function parseArray<T>(
  value: unknown,
  path: string,
  parseItem: (item: unknown, itemPath: string) => ParseResult<T>,
): ParseResult<readonly T[]> {
  if (!Array.isArray(value)) {
    return fail(path, "expected a list");
  }
  const items: T[] = [];
  for (const [index, entry] of value.entries()) {
    const parsed = parseItem(entry, `${path}[${index}]`);
    if (!parsed.ok) {
      return parsed;
    }
    items.push(parsed.value);
  }
  return ok(items);
}

/**
 * Validates a schema version field: a non-integer or non-numeric value is
 * `malformed`; a well-formed integer outside `supported` is a distinct
 * `unsupported-version` failure, so callers can tell "bad payload" apart
 * from "payload from a version we don't understand".
 */
export function parseSchemaVersion(
  value: unknown,
  supported: readonly number[],
  path = "schemaVersion",
): ParseResult<number> {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return fail(path, "expected a positive integer schema version");
  }
  if (!supported.includes(value)) {
    return fail(
      path,
      `unsupported schema version: ${value} (supported: ${supported.join(", ")})`,
      "unsupported-version",
    );
  }
  return ok(value);
}

// --- Branded identifiers ---------------------------------------------------

export function idParser<TBrand extends string>(): (
  value: unknown,
  path: string,
) => ParseResult<Brand<string, TBrand>> {
  return (value, path) => {
    const result = parseString(value, path);
    if (!result.ok) {
      return result;
    }
    return ok(result.value as Brand<string, TBrand>);
  };
}

export function idFactory<TBrand extends string>(
  prefix: string,
): () => Brand<string, TBrand> {
  return () => `${prefix}-${crypto.randomUUID()}` as Brand<string, TBrand>;
}

/**
 * An id factory whose ids sort in the order they were made: a UUIDv7 under
 * `prefix` (48-bit millisecond timestamp, a 12-bit counter that makes ids made
 * in one millisecond increase, and 62 random bits). It is the same shape as a
 * random id, so nothing that stores or compares ids changes, and two ids made
 * anywhere still differ by their random bits.
 *
 * It exists for ids that are the key of an index on a table that only grows
 * (the trace's observations and proposals). A random key puts each new row on
 * a random page of that index, so an hour of catch-up dirties and writes pages
 * all through a multi-megabyte B-tree; an ordered key puts every row at its
 * end. Measured on the benchmark's world, 72,000 inserts fell from 2.5 s to
 * 0.2 s (tools/probes/catchup-bench).
 *
 * The clock never runs the timestamp backwards: a reading earlier than the last
 * one is treated as the last one, so a stepped clock cannot make a later id
 * sort before an earlier one.
 */
export function timeOrderedIdFactory<TBrand extends string>(
  prefix: string,
  now: () => number = Date.now,
): () => Brand<string, TBrand> {
  let lastMs = 0;
  let counter = 0;
  const random = new Uint8Array(8);
  return () => {
    const reading = Math.max(now(), lastMs);
    if (reading === lastMs) {
      counter += 1;
      if (counter > 0xfff) {
        // 4,096 ids in one millisecond: borrow the next one rather than repeat.
        lastMs += 1;
        counter = 0;
      }
    } else {
      lastMs = reading;
      counter = 0;
    }
    crypto.getRandomValues(random);
    const hex = (n: number, width: number) =>
      n.toString(16).padStart(width, "0");
    const ms = hex(lastMs, 12);
    const tail = Array.from(random, (byte) => hex(byte, 2));
    // The variant's top two bits are 10; the rest of that byte is random.
    tail[0] = hex(((random[0] as number) & 0x3f) | 0x80, 2);
    return `${prefix}-${ms.slice(0, 8)}-${ms.slice(8)}-7${hex(counter, 3)}-${tail[0]}${tail[1]}-${tail.slice(2).join("")}` as Brand<
      string,
      TBrand
    >;
  };
}

export type WorldId = Brand<string, "WorldId">;
export const parseWorldId = idParser<"WorldId">();
export const createWorldId = idFactory<"WorldId">("world");

export type EntityId = Brand<string, "EntityId">;
export const parseEntityId = idParser<"EntityId">();
export const createEntityId = idFactory<"EntityId">("entity");

export type EventId = Brand<string, "EventId">;
export const parseEventId = idParser<"EventId">();
export const createEventId = idFactory<"EventId">("event");

export type CorrelationId = Brand<string, "CorrelationId">;
export const parseCorrelationId = idParser<"CorrelationId">();
export const createCorrelationId = idFactory<"CorrelationId">("corr");

export type CausationId = Brand<string, "CausationId">;
export const parseCausationId = idParser<"CausationId">();
export const createCausationId = idFactory<"CausationId">("cause");

export type SessionId = Brand<string, "SessionId">;
export const parseSessionId = idParser<"SessionId">();
export const createSessionId = idFactory<"SessionId">("session");

export type LegendId = Brand<string, "LegendId">;
export const parseLegendId = idParser<"LegendId">();
export const createLegendId = idFactory<"LegendId">("legend");

// --- Shared value shapes -----------------------------------------------------

export interface EntityRevision {
  readonly entityId: EntityId;
  readonly revision: number;
}

export function parseEntityRevision(
  value: unknown,
  path: string,
): ParseResult<EntityRevision> {
  if (!isRecord(value)) {
    return fail(path, "expected an entity revision entry");
  }
  const entityId = parseEntityId(value.entityId, `${path}.entityId`);
  if (!entityId.ok) {
    return entityId;
  }
  const revision = parseNonNegativeInteger(value.revision, `${path}.revision`);
  if (!revision.ok) {
    return revision;
  }
  return ok({ entityId: entityId.value, revision: revision.value });
}

export interface ResourceAmount {
  readonly resource: string;
  readonly amount: number;
}

export function parseResourceAmount(
  value: unknown,
  path: string,
): ParseResult<ResourceAmount> {
  if (!isRecord(value)) {
    return fail(path, "expected a resource amount entry");
  }
  const resource = parseString(value.resource, `${path}.resource`);
  if (!resource.ok) {
    return resource;
  }
  const amount = parseNonNegativeNumber(value.amount, `${path}.amount`);
  if (!amount.ok) {
    return amount;
  }
  return ok({ resource: resource.value, amount: amount.value });
}
