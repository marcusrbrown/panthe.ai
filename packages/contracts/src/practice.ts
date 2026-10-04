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

/** The practices a thread can be: a settlement between two gods, and a supplication, the terms a god sets on a prayer. Contest joins them in a later unit. */
export const PRACTICE_KINDS = ["settlement", "supplication"] as const;
export type PracticeKind = (typeof PRACTICE_KINDS)[number];

/** The moves of a thread. A demand opens a settlement and an offer opens a supplication; the others answer. */
export const PRACTICE_MOVES = [
  "demand",
  "offer",
  "counter",
  "accept",
  "refuse",
  "withdraw",
  /** A god opens a contest for a place's people over a rival's act it perceived; the world, not a thread, holds it. */
  "contest",
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
  /** An alliance term needs no performance: the settlement is the seal. */
  "sealed",
  /** A supplication's deadline passed without the boon the god promised: the mortal owes nothing for what it never received. */
  "boon-unanswered",
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
  "ally",
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
    }
  /**
   * `party` and `to` are allies once the settlement is accepted: the term is
   * sealed by agreement, which is the only way an alliance forms (R19). It binds
   * the two gods of the thread and no one else.
   */
  | {
      readonly kind: "ally";
      readonly party: EntityId;
      readonly to: EntityId;
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
    case "ally": {
      const to = parseEntityId(value.to, `${path}.to`);
      if (!to.ok) return to;
      return ok({ kind: "ally", party: party.value, to: to.value });
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

// --- Motifs: the sourced endings ------------------------------------------------------------------

/**
 * The motifs an ending can apply, each a sourced Greek story-shape with a
 * bounded change the world can make (`content/greek/lore/motifs.json` cites
 * them, and its parser requires every id here to be catalogued). Boon and
 * compensation are applied by supplication terms; the rest by settlement
 * endings. A curse is not listed: no bounded change to an existing capability
 * expresses one that the oath penalty and transformation do not.
 */
export const PRACTICE_MOTIFS = [
  "boon",
  "compensation",
  "standing-won",
  "standing-lost",
  "transformation-punishment",
  "transformation-mercy",
  "oath-penalty",
] as const;
export type PracticeMotif = (typeof PRACTICE_MOTIFS)[number];

/** The kind of bounded change each motif applies. One table for the catalogue and the world. */
export const PRACTICE_MOTIF_CHANGES = {
  boon: "resource-grant",
  compensation: "resource-transfer",
  "standing-won": "standing-record",
  "standing-lost": "standing-record",
  "transformation-punishment": "transformation",
  "transformation-mercy": "transformation",
  "oath-penalty": "oath-penalty",
} as const satisfies Record<PracticeMotif, string>;
export type PracticeMotifChange =
  (typeof PRACTICE_MOTIF_CHANGES)[PracticeMotif];

/**
 * A change of form and capabilities: what an actor becomes, the capabilities
 * it gains, and the ones it loses. Identity, memory, and relationships are not
 * in it because nothing here touches them (R18).
 */
export interface Transformation {
  readonly form: string;
  readonly capabilitiesGained: readonly string[];
  readonly capabilitiesLost: readonly string[];
}

export function parseTransformation(
  value: unknown,
  path: string,
): ParseResult<Transformation> {
  if (!isRecord(value)) return fail(path, "expected a transformation object");
  const form = parseString(value.form, `${path}.form`);
  if (!form.ok) return form;
  const gained = parseStringList(
    value.capabilitiesGained,
    `${path}.capabilitiesGained`,
  );
  if (!gained.ok) return gained;
  const lost = parseStringList(
    value.capabilitiesLost,
    `${path}.capabilitiesLost`,
  );
  if (!lost.ok) return lost;
  return ok({
    form: form.value,
    capabilitiesGained: gained.value,
    capabilitiesLost: lost.value,
  });
}

function parseStringList(
  value: unknown,
  path: string,
): ParseResult<readonly string[]> {
  if (!Array.isArray(value)) return fail(path, "expected an array");
  const items: string[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = parseString(item, `${path}[${index}]`);
    if (!parsed.ok) return parsed;
    items.push(parsed.value);
  }
  return ok(items);
}

// --- Contests: gods claim a place's people ---------------------------------------------------------

/** The services a god performs that mortals experience and a contest counts: a bless, a strike, a legend. */
export const SERVICE_KINDS = ["bless", "strike", "legend"] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

/** How a contest ends: decided (the god most mortals favour wins standing there and the other loses it) or expired (no one's standing changes). */
export const CONTEST_RESULTS = ["decided", "expired"] as const;
export type ContestResult = (typeof CONTEST_RESULTS)[number];

/** Why a contest ended: its window closed on a favoured god; the place emptied of people; or the window closed with no god favoured over the other. */
export const CONTEST_END_REASONS = [
  "window",
  "place-empty",
  "no-favour",
] as const;
export type ContestEndReason = (typeof CONTEST_END_REASONS)[number];
