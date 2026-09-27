// Tiny validated world API bridge exposed to the guest runtime: `move`,
// `say`, `spend`. This is the *only* host bridge a generated behavior can
// reach — everything else (require/io/os/process/fetch/Bun/etc.) must be
// absent from the guest's ambient scope, not merely unauthorized.
//
// Parse-don't-validate: every call parses its raw argument(s) into a typed
// value or throws a WorldApiError before anything is staged. A thrown error
// propagates to the guest as a catchable exception (QuickJS) or an uncaught
// runtime error (Lua, which has no base library and therefore no `pcall`).
//
// Transaction semantics: calls are staged into an append-only log as they
// succeed. The runner calls `finalize(true)` only when the guest execution
// returns normally; any termination or thrown/uncaught guest error must
// result in `finalize(false)`, which keeps the staged calls in the log but
// marks the whole invocation "rolled-back" rather than "committed" — the log
// always tells the truth about what was attempted, and separately whether
// the world would have kept it.

const DEFAULT_INVOCATION_BUDGET = 50;
const DEFAULT_KNOWN_ENTITY_IDS = ["npc-1", "npc-2", "player-1"] as const;

export type MoveTarget = { readonly x: number; readonly y: number } | string;

export interface ApiCallRecord {
  readonly index: number;
  readonly call: "move" | "say" | "spend";
  readonly args: unknown;
}

export type ApiLogStatus = "pending" | "committed" | "rolled-back";

export interface ApiLog {
  readonly calls: readonly ApiCallRecord[];
  readonly status: ApiLogStatus;
}

export class WorldApiError extends Error {}

export class ValidationError extends WorldApiError {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
  }
}

export class InvocationBudgetExceededError extends WorldApiError {
  constructor(budget: number) {
    super(`invocation budget of ${budget} exceeded`);
  }
}

export class UnknownEntityError extends WorldApiError {
  constructor(entityId: string) {
    super(`unknown entity id: ${entityId}`);
  }
}

export interface WorldApiOptions {
  /** Maximum number of API calls a single execution may make. */
  readonly budget?: number;
  /** Entity ids `move`/`say` targets are validated against. */
  readonly knownEntityIds?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * ADR-0004 world-API boundary rule: every argument crossing from a guest
 * runtime into the world API must already be a snapshot of *plain data* —
 * no functions, no non-plain prototypes (`Object.prototype`/`null`/array
 * only) — before it reaches a `WorldApi` method. This is a defense-in-depth
 * guard, not the primary defense: it catches a function or an
 * exotic-prototype object smuggled through, but it cannot by itself detect
 * a value whose *content* was assembled inconsistently (see the
 * `snapshotOnce`/consistency-check helpers in `quickjs.ts`/`lua.ts`, which
 * close that gap by re-reading and comparing before this guard ever runs).
 */
export function assertPlainData(value: unknown, path: string): void {
  if (value === null || value === undefined) {
    return;
  }
  const kind = typeof value;
  if (kind === "number" || kind === "string" || kind === "boolean") {
    return;
  }
  if (kind === "function") {
    throw new ValidationError(path, "function values are not allowed");
  }
  if (kind !== "object") {
    throw new ValidationError(path, `unsupported value type: ${kind}`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertPlainData(item, `${path}[${index}]`);
    });
    return;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new ValidationError(
      path,
      "non-plain object prototype is not allowed",
    );
  }
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    assertPlainData(nested, `${path}.${key}`);
  }
}

/**
 * The world API bridge and its append-only invocation log. One instance
 * backs exactly one fixture execution — a fresh instance per run, never
 * reused, mirroring the fresh-runtime-per-execution rule for the guest
 * language runtimes themselves.
 */
export class WorldApi {
  private readonly budget: number;
  private readonly knownEntityIds: ReadonlySet<string>;
  private readonly calls: ApiCallRecord[] = [];
  private invocationCount = 0;
  private status: ApiLogStatus = "pending";

  constructor(options: WorldApiOptions = {}) {
    this.budget = options.budget ?? DEFAULT_INVOCATION_BUDGET;
    this.knownEntityIds = new Set(
      options.knownEntityIds ?? DEFAULT_KNOWN_ENTITY_IDS,
    );
  }

  /** Moves an entity to `{x, y}` or toward a known entity id. */
  move(target: unknown): void {
    this.record("move", () => this.parseMoveTarget(target));
  }

  /** Sends `text` to a known entity id. */
  say(to: unknown, text: unknown): void {
    this.record("say", () => {
      const parsedTo = this.parseEntityId(to, "to");
      const parsedText = this.parseNonEmptyString(text, "text");
      return { to: parsedTo, text: parsedText };
    });
  }

  /** Spends a non-negative finite amount. */
  spend(amount: unknown): void {
    this.record("spend", () => this.parseAmount(amount));
  }

  /** Marks the invocation committed (guest execution returned normally). */
  finalize(committed: boolean): ApiLog {
    this.status = committed ? "committed" : "rolled-back";
    return this.getLog();
  }

  /** The current invocation log; safe to call at any point. */
  getLog(): ApiLog {
    return { calls: [...this.calls], status: this.status };
  }

  private record(call: ApiCallRecord["call"], validate: () => unknown): void {
    this.invocationCount += 1;
    if (this.invocationCount > this.budget) {
      throw new InvocationBudgetExceededError(this.budget);
    }
    const parsedArgs = validate();
    this.calls.push({ index: this.invocationCount, call, args: parsedArgs });
  }

  private parseMoveTarget(value: unknown): MoveTarget {
    if (typeof value === "string") {
      return this.parseEntityId(value, "target");
    }
    if (isRecord(value)) {
      const x = value.x;
      const y = value.y;
      if (typeof x !== "number" || !Number.isFinite(x)) {
        throw new ValidationError("target.x", "expected a finite number");
      }
      if (typeof y !== "number" || !Number.isFinite(y)) {
        throw new ValidationError("target.y", "expected a finite number");
      }
      return { x, y };
    }
    throw new ValidationError(
      "target",
      "expected {x, y} or an entity id string",
    );
  }

  private parseEntityId(value: unknown, path: string): string {
    if (typeof value !== "string" || value.length === 0) {
      throw new ValidationError(path, "expected a non-empty string");
    }
    if (!this.knownEntityIds.has(value)) {
      throw new UnknownEntityError(value);
    }
    return value;
  }

  private parseNonEmptyString(value: unknown, path: string): string {
    if (typeof value !== "string" || value.length === 0) {
      throw new ValidationError(path, "expected a non-empty string");
    }
    return value;
  }

  private parseAmount(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new ValidationError(
        "amount",
        "expected a non-negative finite number",
      );
    }
    return value;
  }
}
