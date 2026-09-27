// Action-proposal schema shared by the inference-baseline (Unit 5) and
// provider-matrix (Unit 6) probes so local and hosted structured-output
// results are comparable. Parse-don't-validate: parseAction(unknown) never
// throws and never coerces an unknown action kind.

export type MoveTarget = { readonly x: number; readonly y: number } | string;

export interface MoveAction {
  readonly kind: "move";
  readonly target: MoveTarget;
}

export interface SayAction {
  readonly kind: "say";
  readonly to: string;
  readonly text: string;
}

export interface TradeItem {
  readonly item: string;
  readonly qty: number;
}

export interface TradeAction {
  readonly kind: "trade";
  readonly with: string;
  readonly give: readonly TradeItem[];
  readonly receive: readonly TradeItem[];
}

export interface StrikeAction {
  readonly kind: "strike";
  readonly target: string;
  readonly power: number;
}

export interface IdleAction {
  readonly kind: "idle";
  readonly reason?: string;
}

export type Action =
  | MoveAction
  | SayAction
  | TradeAction
  | StrikeAction
  | IdleAction;

export interface ParseSuccess<T> {
  readonly ok: true;
  readonly action: T;
}

export interface ParseFailure {
  readonly ok: false;
  readonly path: string;
  readonly message: string;
}

export type ParseResult<T> = ParseSuccess<T> | ParseFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): ParseFailure {
  return { ok: false, path, message };
}

type FieldResult<T> = { ok: true; value: T } | ParseFailure;

function parseString(value: unknown, path: string): FieldResult<string> {
  if (typeof value !== "string" || value.length === 0) {
    return fail(path, "expected a non-empty string");
  }
  return { ok: true, value };
}

function parseNumber(value: unknown, path: string): FieldResult<number> {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fail(path, "expected a finite number");
  }
  return { ok: true, value };
}

function parseOptionalString(
  value: unknown,
  path: string,
): FieldResult<string | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  return parseString(value, path);
}

function parseMoveTarget(
  value: unknown,
  path: string,
): FieldResult<MoveTarget> {
  if (typeof value === "string") {
    return value.length > 0
      ? { ok: true, value }
      : fail(path, "expected a non-empty entity id");
  }
  if (isRecord(value)) {
    const x = parseNumber(value.x, `${path}.x`);
    if (!x.ok) {
      return x;
    }
    const y = parseNumber(value.y, `${path}.y`);
    if (!y.ok) {
      return y;
    }
    return { ok: true, value: { x: x.value, y: y.value } };
  }
  return fail(path, "expected {x, y} or an entity id string");
}

function parseTradeItem(value: unknown, path: string): FieldResult<TradeItem> {
  if (!isRecord(value)) {
    return fail(path, "expected an item entry");
  }
  const item = parseString(value.item, `${path}.item`);
  if (!item.ok) {
    return item;
  }
  const qty = parseNumber(value.qty, `${path}.qty`);
  if (!qty.ok) {
    return qty;
  }
  return { ok: true, value: { item: item.value, qty: qty.value } };
}

function parseTradeItems(
  value: unknown,
  path: string,
): FieldResult<readonly TradeItem[]> {
  if (!Array.isArray(value)) {
    return fail(path, "expected a list of items");
  }
  const items: TradeItem[] = [];
  for (const [index, entry] of value.entries()) {
    const parsed = parseTradeItem(entry, `${path}[${index}]`);
    if (!parsed.ok) {
      return parsed;
    }
    items.push(parsed.value);
  }
  return { ok: true, value: items };
}

/** Parses an unknown value into a validated {@link Action}, or a failure with a field path. */
export function parseAction(input: unknown): ParseResult<Action> {
  if (!isRecord(input)) {
    return fail("", "expected an action object");
  }

  const kind = input.kind;
  switch (kind) {
    case "move": {
      const target = parseMoveTarget(input.target, "target");
      if (!target.ok) {
        return target;
      }
      return { ok: true, action: { kind: "move", target: target.value } };
    }
    case "say": {
      const to = parseString(input.to, "to");
      if (!to.ok) {
        return to;
      }
      const text = parseString(input.text, "text");
      if (!text.ok) {
        return text;
      }
      return {
        ok: true,
        action: { kind: "say", to: to.value, text: text.value },
      };
    }
    case "trade": {
      const withParty = parseString(input.with, "with");
      if (!withParty.ok) {
        return withParty;
      }
      const give = parseTradeItems(input.give, "give");
      if (!give.ok) {
        return give;
      }
      const receive = parseTradeItems(input.receive, "receive");
      if (!receive.ok) {
        return receive;
      }
      return {
        ok: true,
        action: {
          kind: "trade",
          with: withParty.value,
          give: give.value,
          receive: receive.value,
        },
      };
    }
    case "strike": {
      const target = parseString(input.target, "target");
      if (!target.ok) {
        return target;
      }
      const power = parseNumber(input.power, "power");
      if (!power.ok) {
        return power;
      }
      return {
        ok: true,
        action: { kind: "strike", target: target.value, power: power.value },
      };
    }
    case "idle": {
      const reason = parseOptionalString(input.reason, "reason");
      if (!reason.ok) {
        return reason;
      }
      return reason.value === undefined
        ? { ok: true, action: { kind: "idle" } }
        : { ok: true, action: { kind: "idle", reason: reason.value } };
    }
    default:
      return fail("kind", `unknown action kind: ${String(kind)}`);
  }
}
