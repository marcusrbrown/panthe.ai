// A god's model prompt and the intent it may answer with. Both are built from
// the god's profile and one perception snapshot, never from the full world
// state or a frame: what the snapshot omits, the god cannot name, and the
// intent parser refuses anything that names it.
//
// The schema steers the model; the parser is the source of truth. A candidate
// that names an unperceived target, an action the god lacks, or a strike
// beyond its power fails to parse, so the router treats the reply as
// invalid-output and repairs it or falls back.

import type { GodAbility, GodProfile } from "@panthea/content";
import type { Brand, EntityId, EventId } from "@panthea/contracts";
import type { PerceivedEvent, PerceptionSnapshot } from "@panthea/world";
import type { ParseResult } from "./config";
import type { IntentSchema, RouteContext } from "./router";

/** World actions a god intent can carry today. An ability naming any other action is not offered to the model yet. */
export const GOD_INTENT_ACTIONS = [
  "move",
  "realm-transition",
  "strike",
  "legend",
  "wait",
] as const;
export type GodIntentAction = (typeof GOD_INTENT_ACTIONS)[number];

/** What a god decides to do. Targets are entity ids from the snapshot the intent was made from. */
export type GodIntent =
  | { readonly action: "move"; readonly to: EntityId }
  | { readonly action: "realm-transition"; readonly to: EntityId }
  | {
      readonly action: "strike";
      readonly target: EntityId;
      readonly power: number;
    }
  | {
      readonly action: "legend";
      readonly assertion: string;
      readonly linkedEventId?: EventId;
    }
  /** Do nothing this turn. Always allowed; nothing is journaled. */
  | { readonly action: "wait" };

/**
 * A god intent that `godIntentSchema`'s parse produced: its action is one the
 * god can take, and its targets and strike power passed the snapshot's checks.
 * Nothing else can make one, so `buildModelProposal` cannot be handed an
 * intent that skipped them.
 */
export type ParsedGodIntent = Brand<GodIntent, "ParsedGodIntent">;

export const MAX_ASSERTION_LENGTH = 280;

function isGodIntentAction(action: string): action is GodIntentAction {
  return (GOD_INTENT_ACTIONS as readonly string[]).includes(action);
}

/** The first ability the profile grants for `action`. */
function abilityFor(
  profile: GodProfile,
  action: GodIntentAction,
): GodAbility | undefined {
  return profile.abilities.find((ability) => ability.action === action);
}

/** Destinations of an ordinary move: exits within the observer's own realm. */
function moveTargets(snapshot: PerceptionSnapshot): readonly EntityId[] {
  return snapshot.exits
    .filter((exit) => exit.realm === snapshot.location.realm)
    .map((exit) => exit.to);
}

/** Destinations of a realm transition: exits over a transport that lead to another realm. */
function transitionTargets(snapshot: PerceptionSnapshot): readonly EntityId[] {
  return snapshot.exits
    .filter(
      (exit) =>
        exit.transport !== "path" && exit.realm !== snapshot.location.realm,
    )
    .map((exit) => exit.to);
}

/** The most power a strike can carry: the ability's authored power, and never more than the divinity held. `0` means a strike is not possible. */
function strikePowerCap(
  ability: GodAbility | undefined,
  snapshot: PerceptionSnapshot,
): number {
  if (!ability) return 0;
  const authored = ability.parameters?.power ?? snapshot.self.divinity;
  return Math.floor(Math.min(authored, snapshot.self.divinity));
}

/** Everything one intent action needs to be offered: what its target fields may hold. */
interface Offer {
  readonly moves: readonly EntityId[];
  readonly transitions: readonly EntityId[];
  readonly strikeTargets: readonly EntityId[];
  readonly strikeCap: number;
  readonly canLegend: boolean;
  readonly eventIds: readonly EventId[];
}

function offerFor(profile: GodProfile, snapshot: PerceptionSnapshot): Offer {
  const strikeCap = strikePowerCap(abilityFor(profile, "strike"), snapshot);
  const strikeTargets =
    strikeCap >= 1 ? snapshot.buildings.map((building) => building.id) : [];
  return {
    moves: moveTargets(snapshot),
    transitions: transitionTargets(snapshot),
    strikeTargets,
    strikeCap: strikeTargets.length > 0 ? strikeCap : 0,
    canLegend: abilityFor(profile, "legend") !== undefined,
    eventIds: snapshot.events.map((event) => event.id),
  };
}

function availableActions(offer: Offer): readonly GodIntentAction[] {
  const actions: GodIntentAction[] = [];
  if (offer.moves.length > 0) actions.push("move");
  if (offer.transitions.length > 0) actions.push("realm-transition");
  if (offer.strikeCap >= 1) actions.push("strike");
  if (offer.canLegend) actions.push("legend");
  actions.push("wait");
  return actions;
}

/**
 * The actions this god can take right now: its movement options and the
 * abilities it can afford, given what it perceives, and waiting, which is
 * always available. Ordered movement first, then the profile's abilities,
 * then waiting.
 */
export function godAvailableActions(
  profile: GodProfile,
  snapshot: PerceptionSnapshot,
): readonly GodIntentAction[] {
  const offered = new Set(availableActions(offerFor(profile, snapshot)));
  const order = [
    "move",
    "realm-transition",
    ...profile.abilities.map((ability) => ability.action),
    "wait",
  ];
  return [...new Set(order)].filter(
    (action): action is GodIntentAction =>
      isGodIntentAction(action) && offered.has(action),
  );
}

function invalid(path: string, message: string): ParseResult<never> {
  return { ok: false, path, message };
}

function parseMember<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
  what: string,
): ParseResult<T> {
  if (
    typeof value !== "string" ||
    !(allowed as readonly string[]).includes(value)
  ) {
    return invalid(
      path,
      `${what} must be one of the ids you can see: ${allowed.join(", ") || "(none)"}`,
    );
  }
  return { ok: true, value: value as T };
}

function parseIntent(
  offer: Offer,
  actions: readonly GodIntentAction[],
  candidate: unknown,
): ParseResult<GodIntent> {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    return invalid("", "expected a JSON object");
  }
  const fields = candidate as Record<string, unknown>;
  const action = parseMember(fields.action, "action", actions, "action");
  if (!action.ok) return action;

  switch (action.value) {
    case "move": {
      const to = parseMember(fields.to, "to", offer.moves, "to");
      return to.ok
        ? { ok: true, value: { action: "move", to: to.value as EntityId } }
        : to;
    }
    case "realm-transition": {
      const to = parseMember(fields.to, "to", offer.transitions, "to");
      return to.ok
        ? {
            ok: true,
            value: { action: "realm-transition", to: to.value as EntityId },
          }
        : to;
    }
    case "strike": {
      const target = parseMember(
        fields.target,
        "target",
        offer.strikeTargets,
        "target",
      );
      if (!target.ok) return target;
      const power = fields.power;
      if (
        typeof power !== "number" ||
        !Number.isInteger(power) ||
        power < 1 ||
        power > offer.strikeCap
      ) {
        return invalid(
          "power",
          `power must be a whole number from 1 to ${offer.strikeCap}`,
        );
      }
      return {
        ok: true,
        value: { action: "strike", target: target.value as EntityId, power },
      };
    }
    case "legend": {
      const assertion = fields.assertion;
      if (
        typeof assertion !== "string" ||
        assertion.trim() === "" ||
        assertion.length > MAX_ASSERTION_LENGTH
      ) {
        return invalid(
          "assertion",
          `assertion must be 1 to ${MAX_ASSERTION_LENGTH} characters`,
        );
      }
      const linked = fields.linkedEventId;
      if (linked === undefined || linked === null) {
        return { ok: true, value: { action: "legend", assertion } };
      }
      const linkedEventId = parseMember(
        linked,
        "linkedEventId",
        offer.eventIds,
        "linkedEventId",
      );
      return linkedEventId.ok
        ? {
            ok: true,
            value: {
              action: "legend",
              assertion,
              linkedEventId: linkedEventId.value,
            },
          }
        : linkedEventId;
    }
    case "wait":
      return { ok: true, value: { action: "wait" } };
  }
}

/**
 * The intent schema for one god's turn: the JSON Schema that steers the model
 * (targets as enums of ids in the snapshot, strike power bounded by the
 * ability and the divinity held) and the parser that enforces the same.
 */
export function godIntentSchema(
  profile: GodProfile,
  snapshot: PerceptionSnapshot,
): IntentSchema<ParsedGodIntent> {
  const offer = offerFor(profile, snapshot);
  const actions = godAvailableActions(profile, snapshot);

  const properties: Record<string, unknown> = {
    action: { type: "string", enum: [...actions] },
  };
  const to = [...new Set([...offer.moves, ...offer.transitions])];
  if (to.length > 0) properties.to = { type: "string", enum: to };
  if (offer.strikeCap >= 1) {
    properties.target = { type: "string", enum: [...offer.strikeTargets] };
    properties.power = {
      type: "integer",
      minimum: 1,
      maximum: offer.strikeCap,
    };
  }
  if (offer.canLegend) {
    properties.assertion = {
      type: "string",
      minLength: 1,
      maxLength: MAX_ASSERTION_LENGTH,
    };
    if (offer.eventIds.length > 0) {
      properties.linkedEventId = { type: "string", enum: [...offer.eventIds] };
    }
  }

  return {
    jsonSchema: {
      type: "object",
      properties,
      required: ["action"],
      additionalProperties: false,
    },
    // The one place an intent is branded: only a candidate that passed every
    // check above becomes a ParsedGodIntent.
    parse: (candidate) => {
      const parsed = parseIntent(offer, actions, candidate);
      return parsed.ok
        ? { ok: true, value: parsed.value as ParsedGodIntent }
        : parsed;
    },
  };
}

// --- The prompt ------------------------------------------------------------------

function describeEvent(event: PerceivedEvent): string {
  const subjects = event.subjects.join(", ");
  const detail = event.assertion === undefined ? "" : `: "${event.assertion}"`;
  return `- [${event.id}] ${event.kind} (${subjects})${detail}`;
}

function describeAbility(
  ability: GodAbility,
  profile: GodProfile,
  snapshot: PerceptionSnapshot,
): string | undefined {
  if (!isGodIntentAction(ability.action)) return undefined;
  const limit =
    ability.action === "strike"
      ? ` Use a power of at most ${strikePowerCap(abilityFor(profile, "strike"), snapshot)} (your authored power and the divinity you hold).`
      : "";
  return `- ${ability.name} (action "${ability.action}"): ${ability.description}${limit}`;
}

/**
 * The prompt for one god's turn. `instructions` is who the god is (drives,
 * lore, relationships, powers); `prompt` is what the god perceives now. Built
 * from the profile and the snapshot alone.
 */
export function buildGodContext(
  profile: GodProfile,
  snapshot: PerceptionSnapshot,
): RouteContext {
  const drives = Object.entries(profile.drives)
    .map(([drive, weight]) => `${drive} ${weight}`)
    .join(", ");
  const abilities = profile.abilities
    .map((ability) => describeAbility(ability, profile, snapshot))
    .filter((line): line is string => line !== undefined);
  const relationships = profile.relationships.map(
    (relationship) =>
      `- ${relationship.target} (${relationship.kind}), disposition ${relationship.disposition.toFixed(2)} on a scale from -1 to 1${relationship.note === undefined ? "" : `: ${relationship.note}`}`,
  );

  const instructions = [
    `You are ${profile.name}, a Greek god of ${profile.domains.join(", ")}.`,
    "Decide what you do next, in character, using only what you are shown as perceived. You know nothing else about the world, and you may only name ids listed in the scene.",
    `Your drives, from 0 to 1: ${drives}.`,
    "What is told of you:",
    ...profile.lore.map((line) => `- ${line.statement}`),
    ...(relationships.length > 0
      ? ["Those you hold close or against:", ...relationships]
      : []),
    "Your powers:",
    ...abilities,
    'You may also move to a neighboring place (action "move"), or cross to another realm where a passage leads (action "realm-transition").',
    'You may also choose to wait (action "wait") and do nothing this turn; waiting is always allowed.',
    "Reply with one JSON object naming your action.",
  ].join("\n");

  const held =
    snapshot.self.inventory.length === 0
      ? "nothing"
      : snapshot.self.inventory
          .map((item) => `${item.resource} ${item.amount}`)
          .join(", ");
  const prompt = [
    `You are at ${snapshot.location.name} [${snapshot.location.id}] in the ${snapshot.location.realm} realm, tick ${snapshot.tick}.`,
    `You hold: ${held}.`,
    "Here with you:",
    ...(snapshot.actors.length === 0
      ? ["- no one else"]
      : snapshot.actors.map(
          (actor) => `- ${actor.id}${actor.isDeity ? " (a god)" : ""}`,
        )),
    "Buildings here:",
    ...(snapshot.buildings.length === 0
      ? ["- none"]
      : snapshot.buildings.map(
          (building) =>
            `- ${building.name} [${building.id}], ${building.status}`,
        )),
    "Recent events here:",
    ...(snapshot.events.length === 0
      ? ["- none"]
      : snapshot.events.map(describeEvent)),
    "Ways out:",
    ...(snapshot.exits.length === 0
      ? ["- none"]
      : snapshot.exits.map(
          (exit) =>
            `- ${exit.name} [${exit.to}], ${exit.realm} realm, by ${exit.transport}`,
        )),
    "What do you do?",
  ].join("\n");

  return { instructions, prompt };
}
