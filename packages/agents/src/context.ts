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
import {
  type Brand,
  type Consequence,
  type EntityId,
  type EventId,
  MAX_REPORT_LENGTH,
} from "@panthea/contracts";
import {
  getMemories,
  hasCapability,
  type MemoryEntry,
  type PerceivedEvent,
  type PerceivedExit,
  type PerceptionSnapshot,
  type RelationshipState,
  type WorldState,
} from "@panthea/world";
import type { ParseResult } from "./config";
import type { IntentSchema, RouteContext } from "./router";

/** World actions a god intent can carry today. An ability naming any other action is not offered to the model yet. */
export const GOD_INTENT_ACTIONS = [
  "move",
  "realm-transition",
  "strike",
  "legend",
  "report",
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
  /**
   * Tell someone here what the god says happened. `claim` is its assertion of
   * who did what to whom and may be false; `linkedEventId` is an event the god
   * witnessed, cited as provenance only.
   */
  | {
      readonly action: "report";
      readonly listener: EntityId;
      readonly content: string;
      readonly claim?: Consequence;
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

/** Most memories a prompt shows: the most salient, so the 4K context bound holds however much a god remembers. */
export const MAX_REMEMBERED = 6;
/** Most feelings a prompt shows: the strongest. */
export const MAX_FEELINGS = 5;

/** What a god carries into a turn from its own memory: bounded, and nothing but what it holds. */
export interface Remembered {
  /** Oldest first. */
  readonly memories: readonly MemoryEntry[];
  readonly relationships: readonly RelationshipState[];
}

/**
 * The bounded slice of `actorId`'s memory and feelings a turn's prompt shows:
 * its `MAX_REMEMBERED` most salient memories (the newest among equals),
 * oldest first, and its `MAX_FEELINGS` strongest feelings.
 */
export function rememberedBy(state: WorldState, actorId: EntityId): Remembered {
  const memories = [...getMemories(state, actorId)]
    .sort((a, b) => b.salience - a.salience || b.recordedAt - a.recordedAt)
    .slice(0, MAX_REMEMBERED)
    .sort((a, b) => a.recordedAt - b.recordedAt);
  const strength = (r: RelationshipState) => Math.abs(r.affinity) + r.grudge;
  const relationships = [...state.relationships.values()]
    .filter((r) => r.from === actorId)
    .sort((a, b) => strength(b) - strength(a) || (a.toward < b.toward ? -1 : 1))
    .slice(0, MAX_FEELINGS);
  return { memories, relationships };
}

const NOTHING_REMEMBERED: Remembered = { memories: [], relationships: [] };

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

/** Exits the god can actually take: the world refuses a move or transition to a place whose required capability the actor lacks (`hasCapability`, the rule validate.ts applies). */
function usableExits(snapshot: PerceptionSnapshot): readonly PerceivedExit[] {
  return snapshot.exits.filter((exit) =>
    hasCapability(snapshot.self.capabilities, exit.requiredCapability),
  );
}

/** Destinations of an ordinary move: usable exits within the observer's own realm. */
function moveTargets(snapshot: PerceptionSnapshot): readonly EntityId[] {
  return usableExits(snapshot)
    .filter((exit) => exit.realm === snapshot.location.realm)
    .map((exit) => exit.to);
}

/** Destinations of a realm transition: exits over a transport that lead to another realm. */
function transitionTargets(snapshot: PerceptionSnapshot): readonly EntityId[] {
  return usableExits(snapshot)
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
  /** Who is here to hear a report; a report is offered only when someone is. */
  readonly listeners: readonly EntityId[];
  /** Ids a claim may name as its agent, and as its target: the god and what it perceives. */
  readonly claimAgents: readonly EntityId[];
  readonly claimTargets: readonly EntityId[];
  /** Events the god remembers witnessing, the only ones a report may cite. */
  readonly witnessedEventIds: readonly EventId[];
}

function offerFor(
  profile: GodProfile,
  snapshot: PerceptionSnapshot,
  remembered: Remembered,
): Offer {
  const listeners = snapshot.actors.map((actor) => actor.id);
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
    listeners,
    claimAgents: [snapshot.self.id, ...listeners],
    claimTargets: [
      snapshot.self.id,
      ...listeners,
      ...snapshot.buildings.map((building) => building.id),
    ],
    witnessedEventIds: remembered.memories.flatMap((memory) =>
      memory.kind === "witnessed" ? [memory.sourceEventId] : [],
    ),
  };
}

function availableActions(offer: Offer): readonly GodIntentAction[] {
  const actions: GodIntentAction[] = [];
  if (offer.moves.length > 0) actions.push("move");
  if (offer.transitions.length > 0) actions.push("realm-transition");
  if (offer.strikeCap >= 1) actions.push("strike");
  if (offer.canLegend) actions.push("legend");
  if (offer.listeners.length > 0) actions.push("report");
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
  const offered = new Set(
    availableActions(offerFor(profile, snapshot, NOTHING_REMEMBERED)),
  );
  const order = [
    "move",
    "realm-transition",
    ...profile.abilities.map((ability) => ability.action),
    "report",
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
    case "report":
      return parseReport(offer, fields);
    case "wait":
      return { ok: true, value: { action: "wait" } };
  }
}

function parseReport(
  offer: Offer,
  fields: Record<string, unknown>,
): ParseResult<GodIntent> {
  const listener = parseMember(
    fields.listener,
    "listener",
    offer.listeners,
    "listener",
  );
  if (!listener.ok) return listener;
  const content = fields.content;
  if (
    typeof content !== "string" ||
    content.trim() === "" ||
    content.length > MAX_REPORT_LENGTH
  ) {
    return invalid(
      "content",
      `content must be 1 to ${MAX_REPORT_LENGTH} characters`,
    );
  }
  const claim = parseClaim(offer, fields.claim);
  if (!claim.ok) return claim;
  let linkedEventId: EventId | undefined;
  if (fields.linkedEventId !== undefined && fields.linkedEventId !== null) {
    const cited = parseMember(
      fields.linkedEventId,
      "linkedEventId",
      offer.witnessedEventIds,
      "linkedEventId",
    );
    if (!cited.ok) return cited;
    linkedEventId = cited.value;
  }
  return {
    ok: true,
    value: {
      action: "report",
      listener: listener.value as EntityId,
      content,
      ...(claim.value === undefined ? {} : { claim: claim.value }),
      ...(linkedEventId === undefined ? {} : { linkedEventId }),
    },
  };
}

const CLAIM_EFFECTS = ["harm", "kindness"] as const;

function parseClaim(
  offer: Offer,
  raw: unknown,
): ParseResult<Consequence | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return invalid("claim", "claim must be an object");
  }
  const claim = raw as Record<string, unknown>;
  const effect = parseMember(
    claim.effect,
    "claim.effect",
    CLAIM_EFFECTS,
    "effect",
  );
  if (!effect.ok) return effect;
  const agent = parseMember(
    claim.agent,
    "claim.agent",
    offer.claimAgents,
    "agent",
  );
  if (!agent.ok) return agent;
  if (claim.target === undefined || claim.target === null) {
    return {
      ok: true,
      value: { effect: effect.value, agent: agent.value as EntityId },
    };
  }
  const target = parseMember(
    claim.target,
    "claim.target",
    offer.claimTargets,
    "target",
  );
  if (!target.ok) return target;
  return {
    ok: true,
    value: {
      effect: effect.value,
      agent: agent.value as EntityId,
      target: target.value as EntityId,
    },
  };
}

/**
 * The intent schema for one god's turn: the JSON Schema that steers the model
 * (targets as enums of ids in the snapshot, strike power bounded by the
 * ability and the divinity held) and the parser that enforces the same.
 */
export function godIntentSchema(
  profile: GodProfile,
  snapshot: PerceptionSnapshot,
  remembered: Remembered = NOTHING_REMEMBERED,
): IntentSchema<ParsedGodIntent> {
  const offer = offerFor(profile, snapshot, remembered);
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
  }
  if (offer.listeners.length > 0) {
    properties.listener = { type: "string", enum: [...offer.listeners] };
    properties.content = {
      type: "string",
      minLength: 1,
      maxLength: MAX_REPORT_LENGTH,
    };
    properties.claim = {
      type: "object",
      properties: {
        effect: { type: "string", enum: [...CLAIM_EFFECTS] },
        agent: { type: "string", enum: [...offer.claimAgents] },
        target: { type: "string", enum: [...offer.claimTargets] },
      },
      required: ["effect", "agent"],
      additionalProperties: false,
    };
  }
  const citable = [...new Set([...offer.eventIds, ...offer.witnessedEventIds])];
  if ((offer.canLegend || offer.listeners.length > 0) && citable.length > 0) {
    properties.linkedEventId = { type: "string", enum: citable };
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

const EFFECT_WORDS = {
  harm: "harmed",
  kindness: "was kind to",
} as const;

function describeConsequence(consequence: Consequence | undefined): string {
  if (consequence === undefined) return "";
  return `${consequence.agent} ${EFFECT_WORDS[consequence.effect]} ${consequence.target ?? "someone"}`;
}

function describeMemory(memory: MemoryEntry): string {
  const what = describeConsequence(memory.consequence);
  if (memory.kind === "witnessed") {
    return `- You saw [${memory.sourceEventId}] ${memory.eventKind} (${memory.subjects.join(", ")})${what === "" ? "" : `: ${what}`}`;
  }
  return `- ${memory.teller} told you: "${memory.content}"${what === "" ? "" : ` (claiming ${what})`}`;
}

/** The memory and feelings sections of a prompt; empty when the god remembers nothing. */
function describeRemembered(remembered: Remembered): string[] {
  const lines: string[] = [];
  if (remembered.memories.length > 0) {
    lines.push("You remember:", ...remembered.memories.map(describeMemory));
  }
  if (remembered.relationships.length > 0) {
    lines.push(
      "How you feel now:",
      ...remembered.relationships.map(
        (r) =>
          `- ${r.toward}: affinity ${r.affinity}${r.grudge > 0 ? `, grudge ${r.grudge}` : ""}${r.allied ? ", allied" : ""}`,
      ),
    );
  }
  return lines;
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
  remembered: Remembered = NOTHING_REMEMBERED,
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
    ...(snapshot.actors.length > 0
      ? [
          'You may also tell someone here something (action "report", naming the listener, your words, and optionally a claim of who harmed or did a kindness to whom, and an event you saw). It is your own account, told as you choose.',
        ]
      : []),
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
    ...describeRemembered(remembered),
    "Ways out:",
    ...(usableExits(snapshot).length === 0
      ? ["- none"]
      : usableExits(snapshot).map(
          (exit) =>
            `- ${exit.name} [${exit.to}], ${exit.realm} realm, by ${exit.transport}`,
        )),
    "What do you do?",
  ].join("\n");

  return { instructions, prompt };
}
