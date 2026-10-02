// A god's practice threads as its prompt shows them, and the one flat intent it
// answers them with. Built from world state the way petitions are: the digest
// is the god's own view (its role, the cause as it knows it, the legal
// responses, the deadline), never the other party's private goal or evidence.
//
// The digest leads the prompt. Obligations the god owes and threads awaiting
// its answer always appear, compressed when the budget runs short; only the
// other open threads are cut. The intent is one flat object: a move, a thread
// or a cause, and one term picked from the closed checkable set. The parser is
// the source of truth for which (move, thread) pairs are legal.

import type {
  EntityId,
  EventId,
  PracticeTerm,
  PracticeTermOffer,
} from "@panthea/contracts";
import {
  canStillPerform,
  getActor,
  getMemories,
  isThreadOpen,
  type MemoryEntry,
  practiceBalanceOf,
  termObstacle,
  type WorldState,
} from "@panthea/world";
import type { ParseResult } from "./config";

/** The heading of the practice digest, the first section of a god's prompt: found by it (with the dashed and indented lines under it) wherever a prompt is checked for a thread. */
export const PRACTICES_HEADING = "Your open practices:";

/** Characters of digest shown in full. Rows beyond it are compressed, and only threads that need nothing from this god are cut. */
export const DIGEST_BUDGET_CHARS = 1600;

/** The answers a thread can take from the god. A demand opens one and is not an answer. */
export type AnswerMove = "accept" | "counter" | "refuse" | "withdraw";

/** Where a thread stands for this god: owed by it, awaiting its answer, or waiting on someone else. */
export type Standing = "obligation" | "awaiting" | "other";

/** One open thread the god is a party to, resolved for the prompt and the builder. */
export interface ThreadView {
  readonly id: EventId;
  readonly standing: Standing;
  readonly self: EntityId;
  readonly other: EntityId;
  readonly status: "open" | "countered" | "accepted";
  /** The thread's revision when the view was read: the one thing a move on it pins. */
  readonly revision: number;
  readonly term: PracticeTerm;
  /** The last answered move, from the thread's own fields. */
  readonly lastMove: string;
  /** The cause as this god knows it; a cause it holds no account of is said to be unknown. */
  readonly cause: string;
  readonly negotiationDeadline: number;
  readonly counterBudgetLeft: number;
  /** The tick the view was read at: deadlines are shown as ticks left. */
  readonly tick: number;
  /** The answers this god may give now. */
  readonly moves: readonly AnswerMove[];
  /** Whether this god may swear its acceptance: only the god who must perform the term may. */
  readonly canSwear: boolean;
  /** Why an obligation of this god's cannot be performed now, when it cannot. */
  readonly unperformable?: string;
  /** Why the world judged the god's last move on this thread to make no progress. Unit 3 fills it. */
  readonly noProgress?: string;
}

/** A cause the god may open a demand on: an event it remembers, with the memory that says so. */
export interface DemandCause {
  readonly id: EventId;
  readonly memoryId: EventId;
  readonly text: string;
}

/** What a term may name, from the world the god can know of: the other gods, the places on the map, the mortals it was shown, the resources that exist. */
export interface PracticeOptions {
  readonly gods: readonly EntityId[];
  readonly places: readonly EntityId[];
  readonly mortals: readonly EntityId[];
  readonly resources: readonly string[];
  readonly minTicks: number;
  readonly maxTicks: number;
  readonly causes: readonly DemandCause[];
}

export const NO_PRACTICE: PracticeOptions = {
  gods: [],
  places: [],
  mortals: [],
  resources: [],
  minTicks: 1,
  maxTicks: 1,
  causes: [],
};

/** Whether a witnessed memory's event kind is a thread's ending, which its parties remember though no one stood at it. */
export function isEndingKind(kind: string): boolean {
  return kind === "practice-moved" || kind === "practice-ended";
}

/**
 * What one memory says about the event it rests on, in the god's own terms. A
 * told account is named, not quoted: its words are in the memory section of the
 * prompt, and quoting them again here would carry a teller's words into a line
 * the privacy checks do not recognize as a told account.
 */
function describeBasis(memory: MemoryEntry): string {
  switch (memory.kind) {
    case "witnessed":
      return isEndingKind(memory.eventKind)
        ? "a practice you were party to ended"
        : `you saw ${memory.eventKind} (${memory.subjects.join(", ")})`;
    case "told":
      return `${memory.teller} told you of it`;
    case "noticed":
      return `you noticed a loss (${memory.subjects.join(", ")})`;
    case "sign":
      return `${memory.god} ${memory.outcome === "answered" ? "answered" : "did not answer"} a petition`;
  }
}

/** The event a memory is evidence of: the one a told memory cites, else the event it rests on. */
function basisOf(memory: MemoryEntry): EventId | undefined {
  switch (memory.kind) {
    case "witnessed":
      return memory.sourceEventId;
    case "told":
      return memory.linkedEventId ?? memory.sourceEventId;
    case "noticed":
      return memory.causeEventId;
    case "sign":
      return undefined;
  }
}

/** Whether `memory` is evidence of `cause`, by the rule the world's `knowsCause` applies. */
const evidences = (memory: MemoryEntry, cause: EventId) =>
  memory.sourceEventId === cause ||
  (memory.kind === "told" && memory.linkedEventId === cause) ||
  (memory.kind === "noticed" && memory.causeEventId === cause);

/** The causes a god may open a demand on: what the memories its prompt shows are evidence of. */
export function demandCauses(
  shown: readonly MemoryEntry[],
): readonly DemandCause[] {
  const causes = new Map<EventId, DemandCause>();
  for (const memory of shown) {
    const id = basisOf(memory);
    if (id === undefined || causes.has(id)) continue;
    causes.set(id, { id, memoryId: memory.id, text: describeBasis(memory) });
  }
  return [...causes.values()];
}

/** The term in words, from the god's side: "you" for itself. */
export function describeTerm(term: PracticeTerm, self: EntityId): string {
  const who = (id: EntityId) => (id === self ? "you" : id);
  const party = who(term.party);
  switch (term.kind) {
    case "tell-legend":
      return `${party} must tell a legend to the mortals at ${term.place}`;
    case "be-at":
      return `${party} must be at ${term.place}`;
    case "stay-away":
      return `${party} must stay away from ${term.place}`;
    case "give-resource":
      return `${party} must give ${who(term.to)} ${term.amount} ${term.resource}`;
    case "bless-mortal":
      return `${party} must bless ${term.mortal}`;
    case "make-offering":
      return `${party} must offer ${who(term.to)} ${term.amount} ${term.resource}`;
    case "ally":
      return `${party} must ally with ${who(term.to)}`;
  }
}

/** The cause of a thread as `self` knows it: its own memory of it, or that it holds none. */
function causeAsKnown(
  state: WorldState,
  self: EntityId,
  demander: EntityId,
  causes: readonly EventId[],
): string {
  const memories = getMemories(state, self);
  const known = causes.flatMap((cause) => {
    const memory = memories.find((m) => evidences(m, cause));
    return memory === undefined ? [] : [`${describeBasis(memory)} [${cause}]`];
  });
  if (known.length > 0) return known.join("; ");
  return `${demander === self ? "you cite" : `${demander} cites`} an event; you hold no account of it`;
}

/** The thread views of `actorId`, most urgent first, and the options its terms and demands draw on. */
export function practiceBy(
  state: WorldState,
  actorId: EntityId,
  shownMemories: readonly MemoryEntry[],
  shownPetitioners: readonly EntityId[],
): { threads: readonly ThreadView[]; options: PracticeOptions } {
  const self = getActor(state, actorId);
  if (!self?.isDeity) return { threads: [], options: NO_PRACTICE };

  const threads: ThreadView[] = [];
  for (const thread of state.threads.values()) {
    if (!isThreadOpen(thread)) continue;
    if (thread.demander !== actorId && thread.obligated !== actorId) continue;
    const other =
      thread.demander === actorId ? thread.obligated : thread.demander;
    const otherAlive = getActor(state, other)?.alive === true;
    const who = (id: EntityId) => (id === actorId ? "you" : id);
    const status = thread.status as ThreadView["status"];
    const standing: Standing =
      status === "accepted"
        ? thread.term.party === actorId
          ? "obligation"
          : "other"
        : thread.offeredBy !== actorId
          ? "awaiting"
          : "other";

    const moves: AnswerMove[] = [];
    if (status !== "accepted") {
      if (
        thread.offeredBy !== actorId &&
        state.tick <= thread.negotiationDeadline &&
        otherAlive
      ) {
        if (
          termObstacle(
            state,
            thread.term,
            thread.term.deadline - state.tick,
          ) === undefined
        ) {
          moves.push("accept");
        }
        if (thread.counterBudgetLeft >= 1) moves.push("counter");
        moves.push("refuse");
      }
      moves.push("withdraw");
    }

    const accepter =
      thread.demander === thread.offeredBy ? thread.obligated : thread.demander;
    const lastMove =
      status === "accepted"
        ? `${who(accepter)} agreed at tick ${thread.acceptance?.tick ?? "?"}${thread.acceptance?.sworn ? ", sworn by the Styx" : ""}`
        : status === "countered"
          ? `${who(thread.offeredBy)} countered`
          : `${who(thread.demander)} demanded`;

    const obstacle =
      standing === "obligation" && !canStillPerform(state, thread)
        ? termObstacle(state, thread.term, thread.term.deadline - state.tick)
        : undefined;

    threads.push({
      id: thread.id,
      standing,
      self: actorId,
      other,
      status,
      revision: thread.revision,
      term: thread.term,
      lastMove,
      cause: causeAsKnown(state, actorId, thread.demander, thread.causes),
      negotiationDeadline: thread.negotiationDeadline,
      counterBudgetLeft: thread.counterBudgetLeft,
      tick: state.tick,
      moves,
      canSwear: moves.includes("accept") && thread.term.party === actorId,
      ...(obstacle === undefined ? {} : { unperformable: obstacle.message }),
    });
  }

  const urgency = (view: ThreadView) =>
    view.standing === "obligation"
      ? view.term.deadline
      : view.standing === "awaiting"
        ? view.negotiationDeadline
        : Number.MAX_SAFE_INTEGER;
  const rank = { obligation: 0, awaiting: 1, other: 2 } as const;
  const opened = (view: ThreadView) =>
    state.threads.get(view.id)?.openedSequence ?? 0;
  threads.sort(
    (a, b) =>
      rank[a.standing] - rank[b.standing] ||
      urgency(a) - urgency(b) ||
      opened(a) - opened(b),
  );

  const named = new Set<EntityId>(shownPetitioners);
  for (const memory of shownMemories) {
    for (const subject of memory.subjects) named.add(subject);
    if (memory.consequence !== undefined) {
      named.add(memory.consequence.agent);
      if (memory.consequence.target !== undefined) {
        named.add(memory.consequence.target);
      }
    }
    if (memory.kind === "told") named.add(memory.teller);
  }
  const resources = new Set<string>();
  for (const actor of state.actors.values()) {
    for (const resource of actor.inventory.keys()) resources.add(resource);
  }
  // The resources the world prices are the ones that exist, held by anyone yet or not.
  for (const key of Object.keys(state.rules.economyBalance)) {
    if (key.startsWith("value_")) resources.add(key.slice("value_".length));
  }
  for (const recipe of Object.values(state.recipes)) {
    for (const line of [...recipe.inputs, ...recipe.outputs]) {
      resources.add(line.resource);
    }
  }
  const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    threads,
    options: {
      gods: [...state.actors.values()]
        .filter((a) => a.isDeity && a.alive && a.id !== actorId)
        .map((a) => a.id)
        .sort(byId),
      places: [...state.locations.keys()].sort(byId),
      mortals: [...named]
        .filter((id) => {
          const actor = getActor(state, id);
          return actor?.alive === true && actor.isDeity !== true;
        })
        .sort(byId),
      resources: [...resources].sort(byId),
      minTicks: practiceBalanceOf(state.rules, "minTermTicks"),
      maxTicks: practiceBalanceOf(state.rules, "maxTermTicks"),
      causes: demandCauses(shownMemories),
    },
  };
}

// --- The digest ------------------------------------------------------------------------------

const quoted = (moves: readonly AnswerMove[]) =>
  moves.map((move) => `"${move}"`).join(", ");

const ticksLeft = (deadline: number, now: number) =>
  Math.max(0, deadline - now);

/** One thread as a full row: its role, term and deadline, last move, cause, and exactly what the god may answer with. */
function fullRow(view: ThreadView): string[] {
  const term = describeTerm(view.term, view.self);
  const by = `by tick ${view.term.deadline} (${ticksLeft(view.term.deadline, view.tick)} ticks left)`;
  const lines: string[] = [];
  const respond = view.moves.length > 0;
  const answerBy = `Answer by tick ${view.negotiationDeadline} (${ticksLeft(view.negotiationDeadline, view.tick)} ticks left).`;
  switch (view.standing) {
    case "obligation":
      lines.push(
        `- [${view.id}] YOU OWE ${view.other}: ${term}, ${by}. ${view.lastMove}. Cause: ${view.cause}.`,
        "  Perform it before the deadline; if you do not, the world records a breach.",
      );
      if (view.unperformable !== undefined) {
        lines.push(`  UNPERFORMABLE now: ${view.unperformable}.`);
      }
      break;
    case "awaiting":
      lines.push(
        `- [${view.id}] AWAITING YOUR ANSWER: ${view.lastMove}: ${term}, ${by}. ${answerBy} Cause: ${view.cause}.`,
        respond
          ? `  Answer with action "practice", thread "${view.id}", and move ${quoted(view.moves)}${view.canSwear ? " (add swear true to swear it by the Styx)" : ""}${view.moves.includes("counter") ? `; a counter carries a new term (${view.counterBudgetLeft} left)` : ""}.`
          : `  The window to answer has closed; it ends on its own.`,
      );
      break;
    case "other":
      lines.push(
        view.status === "accepted"
          ? `- [${view.id}] ${view.other} OWES YOU: ${term}, ${by}. ${view.lastMove}. Cause: ${view.cause}.`
          : `- [${view.id}] OPEN, waiting on ${view.other}: ${view.lastMove}: ${term}, ${by}. Their answer is due by tick ${view.negotiationDeadline}. Cause: ${view.cause}.`,
      );
      if (view.moves.includes("withdraw")) {
        lines.push(
          `  You may withdraw it: action "practice", thread "${view.id}", move "withdraw".`,
        );
      }
      break;
  }
  if (view.noProgress !== undefined) {
    lines.push(`  Not accepted: ${view.noProgress}.`);
  }
  return lines;
}

/** One thread squeezed to a single line: its id, its term, its deadline, and the answer it needs, nothing else. */
function compactRow(view: ThreadView): string {
  const term = describeTerm(view.term, view.self);
  const by = `by tick ${view.term.deadline}`;
  switch (view.standing) {
    case "obligation":
      return `- [${view.id}] YOU OWE ${view.other}: ${term}, ${by}.${view.unperformable === undefined ? "" : " UNPERFORMABLE now."}`;
    case "awaiting":
      return `- [${view.id}] AWAITING YOUR ANSWER: ${term}, ${by}. thread "${view.id}", move ${quoted(view.moves)}; answer by tick ${view.negotiationDeadline}.`;
    case "other":
      return `- [${view.id}] OPEN with ${view.other}: ${term}, ${by}.`;
  }
}

const sizeOf = (lines: readonly string[]) =>
  lines.reduce((sum, line) => sum + line.length + 1, 0);

/**
 * The digest that leads a god's prompt: empty when it has no open thread. Rows
 * come most urgent first. A row is shown in full while the budget lasts; after
 * that an obligation or a thread awaiting the god is compressed to one line and
 * always shown, while any other thread is shown compressed if there is room and
 * otherwise counted and cut.
 */
export function describeDigest(
  threads: readonly ThreadView[],
  budget = DIGEST_BUDGET_CHARS,
): string[] {
  if (threads.length === 0) return [];
  const lines: string[] = [PRACTICES_HEADING];
  let used = sizeOf(lines);
  let cut = 0;
  for (const view of threads) {
    const full = fullRow(view);
    if (used + sizeOf(full) <= budget) {
      lines.push(...full);
      used += sizeOf(full);
      continue;
    }
    const compact = compactRow(view);
    if (view.standing !== "other" || used + compact.length + 1 <= budget) {
      lines.push(compact);
      used += compact.length + 1;
    } else {
      cut += 1;
    }
  }
  if (cut > 0) {
    lines.push(`- (${cut} more open thread${cut === 1 ? "" : "s"} not shown)`);
  }
  return lines;
}

// --- The instructions ------------------------------------------------------------------------

/** What practices are and how to move in one, told only to a god that can move in one. */
export function describePracticeInstructions(
  threads: readonly ThreadView[],
  options: PracticeOptions,
): string[] {
  const canAnswer = threads.some((view) => view.moves.length > 0);
  const canDemand = options.causes.length > 0 && options.gods.length > 0;
  if (!canAnswer && !canDemand) return [];
  const lines: string[] = [];
  if (canDemand) {
    lines.push(
      `You may bargain with another god through the world (action "practice"). To demand something, send move "demand" with a cause you were shown and one term for that god to do by a deadline: tell a legend at a place, be at a place, stay away from a place, give a resource, bless a mortal, make an offering, or ally with you. The world checks the term itself; only moves bind, and words never do.`,
      `Causes you may demand over: ${options.causes.map((cause) => `[${cause.id}] ${cause.text}`).join("; ")}.`,
    );
  }
  if (canAnswer) {
    lines.push(
      'Answer an open thread with action "practice", its thread id, and one of the moves its row lists. A counter or demand carries one term: {kind, party, and place, or to, or mortal, with resource and amount where it gives or offers, and deadlineTicks}.',
    );
  }
  return lines;
}

// --- The intent ------------------------------------------------------------------------------

/** The kinds of term a god may offer: the closed checkable set. */
const TERM_KINDS = [
  "tell-legend",
  "be-at",
  "stay-away",
  "give-resource",
  "bless-mortal",
  "make-offering",
  "ally",
] as const;

/** What a god's `practice` action says, once parsed against what it was shown. */
export type PracticeIntent = { readonly action: "practice" } & (
  | {
      readonly move: "demand";
      readonly cause: EventId;
      readonly term: PracticeTermOffer;
    }
  | {
      readonly move: "counter";
      readonly thread: EventId;
      readonly term: PracticeTermOffer;
    }
  | {
      readonly move: "accept";
      readonly thread: EventId;
      readonly swear?: boolean;
    }
  | { readonly move: "refuse" | "withdraw"; readonly thread: EventId }
);

/** Everything a `practice` action may name: the threads each answer is legal on, the causes, and what a term may hold. */
export interface PracticeOffer {
  readonly self: EntityId;
  readonly options: PracticeOptions;
  /** Legal thread ids, by answer move. */
  readonly answers: Readonly<Record<AnswerMove, readonly EventId[]>>;
  /** Mortals a term may name: those the god was shown, here or remembered. */
  readonly mortals: readonly EntityId[];
  readonly canDemand: boolean;
  /** Each thread's other party, for the terms a counter may bind. */
  readonly otherOf: ReadonlyMap<EventId, EntityId>;
  /** The threads this god may swear its acceptance of: those whose term it must perform. */
  readonly swearable: readonly EventId[];
}

/** The practice offer, or `undefined` when the god has nothing to say in a practice now. */
export function practiceOffer(
  self: EntityId,
  threads: readonly ThreadView[],
  options: PracticeOptions,
  herePresent: readonly EntityId[],
): PracticeOffer | undefined {
  const by = (move: AnswerMove) =>
    threads.filter((view) => view.moves.includes(move)).map((view) => view.id);
  const answers = {
    accept: by("accept"),
    counter: by("counter"),
    refuse: by("refuse"),
    withdraw: by("withdraw"),
  };
  const canDemand = options.causes.length > 0 && options.gods.length > 0;
  const canAnswer = Object.values(answers).some((ids) => ids.length > 0);
  if (!canDemand && !canAnswer) return undefined;
  return {
    self,
    options,
    answers,
    mortals: [...new Set([...options.mortals, ...herePresent])],
    canDemand,
    otherOf: new Map(threads.map((view) => [view.id, view.other])),
    swearable: threads.filter((view) => view.canSwear).map((view) => view.id),
  };
}

/** The practice moves on offer, in the order they are listed. */
export function offeredMoves(offer: PracticeOffer): readonly string[] {
  const moves: string[] = [];
  if (offer.canDemand) moves.push("demand");
  for (const move of ["accept", "counter", "refuse", "withdraw"] as const) {
    if (offer.answers[move].length > 0) moves.push(move);
  }
  return moves;
}

/** The schema properties a practice adds: flat, so the 4K budget holds. */
export function practiceProperties(
  offer: PracticeOffer,
): Record<string, unknown> {
  const { options } = offer;
  const properties: Record<string, unknown> = {
    move: { type: "string", enum: [...offeredMoves(offer)] },
  };
  const threadIds = [
    ...new Set(Object.values(offer.answers).flatMap((ids) => ids)),
  ];
  if (threadIds.length > 0) {
    properties.thread = { type: "string", enum: threadIds };
  }
  if (offer.canDemand) {
    properties.cause = {
      type: "string",
      enum: options.causes.map((cause) => cause.id),
    };
  }
  if (offer.swearable.length > 0) properties.swear = { type: "boolean" };
  if (offer.canDemand || offer.answers.counter.length > 0) {
    const everyone = [offer.self, ...options.gods];
    properties.term = {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: [...TERM_KINDS],
        },
        party: { type: "string", enum: everyone },
        place: { type: "string", enum: [...options.places] },
        to: { type: "string", enum: everyone },
        ...(offer.mortals.length > 0
          ? { mortal: { type: "string", enum: [...offer.mortals] } }
          : {}),
        resource: { type: "string", enum: [...options.resources] },
        amount: { type: "integer", minimum: 1 },
        deadlineTicks: {
          type: "integer",
          minimum: options.minTicks,
          maximum: options.maxTicks,
        },
      },
      required: ["kind", "party", "deadlineTicks"],
      additionalProperties: false,
    };
  }
  return properties;
}

function invalid(path: string, message: string): ParseResult<never> {
  return { ok: false, path, message };
}

function member<T extends string>(
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
      `${what} must be one of: ${allowed.join(", ") || "(none)"}`,
    );
  }
  return { ok: true, value: value as T };
}

/**
 * A term as the god offers it, against what it may name. `participants` are
 * the two gods of the thread: a term binds one of them, and a gift goes to the
 * other. A demand's participants are the god and the one it binds.
 */
function parseTerm(
  offer: PracticeOffer,
  participants: readonly EntityId[],
  raw: unknown,
  demand: boolean,
): ParseResult<PracticeTermOffer> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return invalid("term", "term must be an object");
  }
  const fields = raw as Record<string, unknown>;
  const { options } = offer;
  const kind = member(fields.kind, "term.kind", TERM_KINDS, "kind");
  if (!kind.ok) return kind;
  const party = member(
    fields.party,
    "term.party",
    demand ? participants.filter((p) => p !== offer.self) : participants,
    "party",
  );
  if (!party.ok) return party;
  const ticks = fields.deadlineTicks;
  if (
    typeof ticks !== "number" ||
    !Number.isInteger(ticks) ||
    ticks < options.minTicks ||
    ticks > options.maxTicks
  ) {
    return invalid(
      "term.deadlineTicks",
      `deadlineTicks must be a whole number from ${options.minTicks} to ${options.maxTicks}`,
    );
  }
  const base = { party: party.value as EntityId, deadlineTicks: ticks };
  // A demand is between the god and the one it binds; a counter between the thread's two gods.
  const pair = demand ? [offer.self, base.party] : participants;
  switch (kind.value) {
    case "tell-legend":
    case "be-at":
    case "stay-away": {
      const place = member(fields.place, "term.place", options.places, "place");
      if (!place.ok) return place;
      return {
        ok: true,
        value: { kind: kind.value, ...base, place: place.value as EntityId },
      };
    }
    case "bless-mortal": {
      const mortal = member(
        fields.mortal,
        "term.mortal",
        offer.mortals,
        "mortal",
      );
      if (!mortal.ok) return mortal;
      return {
        ok: true,
        value: {
          kind: "bless-mortal",
          ...base,
          mortal: mortal.value as EntityId,
        },
      };
    }
    case "ally": {
      // An alliance is between the two gods of the thread: the party and the other.
      const to = member(
        fields.to,
        "term.to",
        pair.filter((p) => p !== base.party),
        "to",
      );
      if (!to.ok) return to;
      return {
        ok: true,
        value: { kind: "ally", ...base, to: to.value as EntityId },
      };
    }
    case "give-resource":
    case "make-offering": {
      // A gift goes to the other god of the thread, who must be able to take it; an offering to any god.
      const recipients =
        kind.value === "give-resource"
          ? pair.filter((p) => p !== base.party)
          : [offer.self, ...options.gods].filter((g) => g !== base.party);
      const to = member(fields.to, "term.to", recipients, "to");
      if (!to.ok) return to;
      const resource = member(
        fields.resource,
        "term.resource",
        options.resources,
        "resource",
      );
      if (!resource.ok) return resource;
      const amount = fields.amount;
      if (
        typeof amount !== "number" ||
        !Number.isInteger(amount) ||
        amount < 1
      ) {
        return invalid("term.amount", "amount must be a positive whole number");
      }
      return {
        ok: true,
        value: {
          kind: kind.value,
          ...base,
          to: to.value as EntityId,
          resource: resource.value,
          amount,
        },
      };
    }
  }
}

/** Parses a `practice` action against the offer: the move, the thread or cause it names, and its term. */
export function parsePractice(
  offer: PracticeOffer,
  fields: Record<string, unknown>,
): ParseResult<PracticeIntent> {
  const move = member(fields.move, "move", offeredMoves(offer), "move");
  if (!move.ok) return move;
  if (move.value === "demand") {
    const cause = member(
      fields.cause,
      "cause",
      offer.options.causes.map((c) => c.id),
      "cause",
    );
    if (!cause.ok) return cause;
    // The demand binds the god it is made of: its term's party is that god.
    const term = parseTerm(
      offer,
      [offer.self, ...offer.options.gods],
      fields.term,
      true,
    );
    if (!term.ok) return term;
    return {
      ok: true,
      value: {
        action: "practice",
        move: "demand",
        cause: cause.value as EventId,
        term: term.value,
      },
    };
  }
  const answer = move.value as AnswerMove;
  const thread = member(
    fields.thread,
    "thread",
    offer.answers[answer],
    "thread",
  );
  if (!thread.ok) return thread;
  const id = thread.value as EventId;
  switch (answer) {
    case "counter": {
      const other = offer.otherOf.get(id) as EntityId;
      const term = parseTerm(offer, [offer.self, other], fields.term, false);
      if (!term.ok) return term;
      return {
        ok: true,
        value: {
          action: "practice",
          move: "counter",
          thread: id,
          term: term.value,
        },
      };
    }
    case "accept": {
      const swear = fields.swear;
      if (swear !== undefined && swear !== null && typeof swear !== "boolean") {
        return invalid("swear", "swear must be true or false");
      }
      if (swear === true && !offer.swearable.includes(id)) {
        return invalid(
          "swear",
          "you may swear only a term you must perform yourself",
        );
      }
      return {
        ok: true,
        value: {
          action: "practice",
          move: "accept",
          thread: id,
          ...(typeof swear === "boolean" ? { swear } : {}),
        },
      };
    }
    case "refuse":
    case "withdraw":
      return {
        ok: true,
        value: { action: "practice", move: answer, thread: id },
      };
  }
}
