// Practice terms: the closed set of performances the world can check against
// committed events. A term names its party (who must perform) and a deadline;
// nothing else can be promised, so no one binds another's cooperation and every
// term has an ending the world judges, never one a god declares.
//
// Two shapes share one parser. A committed event carries a term with an
// absolute `deadline` (a world tick); a proposal carries a `PracticeTermOffer`
// with `deadlineTicks` counted from the tick it commits in, which the rules
// turn into the absolute deadline. Words never appear in a term.

import {
  type EntityId,
  fail,
  isRecord,
  ok,
  type ParseResult,
  parseEntityId,
  parseNonNegativeInteger,
  parseString,
} from "./ids";

/** The practices a thread can be. Contest and supplication join them in later units. */
export const PRACTICE_KINDS = ["settlement"] as const;
export type PracticeKind = (typeof PRACTICE_KINDS)[number];

/** The moves of a settlement. A demand opens the thread; the others answer it. */
export const PRACTICE_MOVES = [
  "demand",
  "counter",
  "accept",
  "refuse",
  "withdraw",
] as const;
export type PracticeMove = (typeof PRACTICE_MOVES)[number];

/** Where a thread stands. The first three are open; the rest are endings the world recorded. */
export const PRACTICE_STATUSES = [
  "open",
  "countered",
  "accepted",
  "fulfilled",
  "refused",
  "expired",
  "withdrawn",
  "breached",
] as const;
export type PracticeStatus = (typeof PRACTICE_STATUSES)[number];

/** The ways a thread ends. */
export const PRACTICE_OUTCOMES = [
  "fulfilled",
  "refused",
  "expired",
  "withdrawn",
  "breached",
] as const;
export type PracticeOutcome = (typeof PRACTICE_OUTCOMES)[number];

/** Why the world ruled as it did: what it observed, or which limit ran out. */
export const PRACTICE_END_REASONS = [
  "performed",
  "kept-away",
  "entered",
  "negotiation-deadline",
  "budget-exhausted",
  "obligation-deadline",
  "party-died",
] as const;
export type PracticeEndReason = (typeof PRACTICE_END_REASONS)[number];

/** The kinds of term, each judged from committed events by its party alone. */
export const PRACTICE_TERM_KINDS = [
  "tell-legend",
  "be-at",
  "stay-away",
  "give-resource",
  "bless-mortal",
  "make-offering",
] as const;
export type PracticeTermKind = (typeof PRACTICE_TERM_KINDS)[number];

/** A term without its deadline: what the party must do, and nothing more. */
export type PracticeTermSpec =
  /** `party` tells a legend, aloud at `place`, to at least one mortal there. */
  | {
      readonly kind: "tell-legend";
      readonly party: EntityId;
      readonly place: EntityId;
    }
  /** `party` is at `place` when the world looks after acceptance. */
  | {
      readonly kind: "be-at";
      readonly party: EntityId;
      readonly place: EntityId;
    }
  /** `party` does not enter `place` before the deadline. */
  | {
      readonly kind: "stay-away";
      readonly party: EntityId;
      readonly place: EntityId;
    }
  /** `party` gives `to` at least `amount` of `resource`, in a trade. */
  | {
      readonly kind: "give-resource";
      readonly party: EntityId;
      readonly to: EntityId;
      readonly resource: string;
      readonly amount: number;
    }
  /** `party` blesses `mortal`, answering that mortal's petition. */
  | {
      readonly kind: "bless-mortal";
      readonly party: EntityId;
      readonly mortal: EntityId;
    }
  /** `party` offers `to` at least `amount` of `resource` in worship. */
  | {
      readonly kind: "make-offering";
      readonly party: EntityId;
      readonly to: EntityId;
      readonly resource: string;
      readonly amount: number;
    };

/** A term as a committed event holds it: the world tick it must be performed by, inclusive. */
export type PracticeTerm = PracticeTermSpec & { readonly deadline: number };

/** A term as a proposal offers it: ticks from the tick it commits in. */
export type PracticeTermOffer = PracticeTermSpec & {
  readonly deadlineTicks: number;
};

function parsePositiveInteger(
  value: unknown,
  path: string,
): ParseResult<number> {
  const n = parseNonNegativeInteger(value, path);
  if (!n.ok) return n;
  if (n.value < 1) return fail(path, "expected a positive integer");
  return n;
}

/** The fields of a term other than its deadline, by kind. */
export function parsePracticeTermSpec(
  value: unknown,
  path: string,
): ParseResult<PracticeTermSpec> {
  if (!isRecord(value)) return fail(path, "expected a term object");
  const party = parseEntityId(value.party, `${path}.party`);
  if (!party.ok) return party;
  switch (value.kind) {
    case "tell-legend":
    case "be-at":
    case "stay-away": {
      const place = parseEntityId(value.place, `${path}.place`);
      if (!place.ok) return place;
      return ok({ kind: value.kind, party: party.value, place: place.value });
    }
    case "give-resource":
    case "make-offering": {
      const to = parseEntityId(value.to, `${path}.to`);
      if (!to.ok) return to;
      const resource = parseString(value.resource, `${path}.resource`);
      if (!resource.ok) return resource;
      const amount = parsePositiveInteger(value.amount, `${path}.amount`);
      if (!amount.ok) return amount;
      return ok({
        kind: value.kind,
        party: party.value,
        to: to.value,
        resource: resource.value,
        amount: amount.value,
      });
    }
    case "bless-mortal": {
      const mortal = parseEntityId(value.mortal, `${path}.mortal`);
      if (!mortal.ok) return mortal;
      return ok({
        kind: "bless-mortal",
        party: party.value,
        mortal: mortal.value,
      });
    }
    default:
      return fail(
        `${path}.kind`,
        `expected one of: ${PRACTICE_TERM_KINDS.join(", ")}`,
      );
  }
}

/** A term a committed event holds: its spec and an absolute deadline tick. */
export function parsePracticeTerm(
  value: unknown,
  path: string,
): ParseResult<PracticeTerm> {
  const spec = parsePracticeTermSpec(value, path);
  if (!spec.ok) return spec;
  const deadline = parseNonNegativeInteger(
    (value as Record<string, unknown>).deadline,
    `${path}.deadline`,
  );
  if (!deadline.ok) return deadline;
  return ok({ ...spec.value, deadline: deadline.value });
}

/** A term a proposal offers: its spec and a positive number of ticks to perform it in. */
export function parsePracticeTermOffer(
  value: unknown,
  path: string,
): ParseResult<PracticeTermOffer> {
  const spec = parsePracticeTermSpec(value, path);
  if (!spec.ok) return spec;
  const deadlineTicks = parsePositiveInteger(
    (value as Record<string, unknown>).deadlineTicks,
    `${path}.deadlineTicks`,
  );
  if (!deadlineTicks.ok) return deadlineTicks;
  return ok({ ...spec.value, deadlineTicks: deadlineTicks.value });
}
