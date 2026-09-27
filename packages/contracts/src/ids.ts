// Shared parse-don't-validate primitives and branded identifiers for every
// M1 wire and storage shape. Parsers never throw on untrusted input; they
// return a typed success or a structured failure naming the field path and
// a reason code, following tools/probes/shared/src/schema.ts.
//
// Design decision (Unit 1): the same RejectionReasonCode vocabulary is used
// both for structural parse failures here and for execution-time proposal
// validation in packages/world (Unit 3+), so there is one taxonomy of "why
// didn't this become world state" instead of two parallel ones.

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
  "over-limit",
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
