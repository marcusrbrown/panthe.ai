// Practices: gods settle disputes through threads the world holds and judges.
//
// A demand opens a settlement thread between two gods. It rests on a cause the
// demander knows, and holds one term the world can check: a performance by a
// named party before a deadline. The other god answers (accept, counter,
// refuse), and the thread ends only in a ruling the world makes from committed
// events: fulfilled when the obligated party is seen performing after it
// accepted, breached when the deadline passes unperformed, refused when the
// counteroffer budget runs out, expired when the negotiation window closes,
// withdrawn when a party dies. A god's words never end a thread; only its
// moves bind and only the world rules.
//
// A thread is state changed only by events (`practice-opened`,
// `practice-moved`, `practice-ended`), so a replay rebuilds it. Rulings are
// planned by `judgePractices` at the end of the tick's environment step and
// are primary events of that tick, so memories derived afterwards see them.
// Deadlines are world ticks, judged identically in live play and catch-up.

import type {
  AccessRestoredEvent,
  EntityId,
  EventId,
  MotifAppliedEvent,
  PracticeEndedEvent,
  PracticeEndReason,
  PracticeMovedEvent,
  PracticeOpenedEvent,
  PracticeOutcome,
  PracticeProposal,
  PracticeTerm,
  PracticeTermOffer,
  PracticeTermSpec,
  RejectionReasonCode,
  WorldEvent,
  WorldRules,
} from "@panthea/contracts";
import { debitActorInventory, getResourceAmount } from "./economy";
import { routeLength } from "./geography";
import { getMemories } from "./memory";
import { inAnswerWindow, petitionBalanceOf } from "./petitions";
import {
  type ActorState,
  DIVINE_CAPABILITY,
  getActor,
  getLocation,
  isThreadOpen,
  type PracticeThread,
  type WorldEventDraft,
  type WorldState,
} from "./state";
import { DIVINE_CAPACITY_RESOURCE } from "./worship";

/** Defaults for `rules.practiceBalance`, in world ticks unless a count. */
export const DEFAULT_PRACTICE_BALANCE: Readonly<Record<string, number>> = {
  /** How long a demand stays open to answers: a god decides about once in 25 ticks, so this allows several turns each. */
  negotiationTicks: 200,
  /** Counteroffers a thread allows. The counter that spends the last one ends the thread refused. */
  counterBudget: 3,
  /** Fewest ticks a term may allow. One decision at the slowest god pace measured. */
  minTermTicks: 25,
  /** Most ticks a term may allow. */
  maxTermTicks: 500,
  /** Divinity a sworn breach costs. Hesiod's penalty is a year without nectar and ambrosia, so it is a loss of the god's own substance; bounded by what the god holds. */
  oathDivinityLoss: 3,
  /** Ticks a sworn breacher is shut out of Olympus: four decisions at the slowest god pace measured. Banishment is M3 (M08). */
  oathAccessTicks: 100,
  /** What a recorded gain or loss of standing at a place weighs. Standing itself is a later unit's state. */
  standingDelta: 1,
};

/** A practice tunable from `rules`, or its default. */
export function practiceBalanceOf(rules: WorldRules, key: string): number {
  return rules.practiceBalance?.[key] ?? DEFAULT_PRACTICE_BALANCE[key] ?? 0;
}

// --- Reducers -------------------------------------------------------------------------------

function withThread(state: WorldState, thread: PracticeThread): WorldState {
  const threads = new Map(state.threads);
  threads.set(thread.id, thread);
  return { ...state, threads };
}

export function applyPracticeOpened(
  state: WorldState,
  event: PracticeOpenedEvent,
): WorldState {
  let next = withThread(state, {
    id: event.id,
    practice: event.practice,
    demander: event.entityId,
    obligated: event.counterparty,
    causes: event.causes,
    term: event.term,
    offeredBy: event.entityId,
    ...(event.stake === undefined ? {} : { stake: event.stake }),
    status: "open",
    openedTick: event.tick,
    openedSequence: event.sequence,
    negotiationDeadline: event.negotiationDeadline,
    counterBudgetLeft: event.counterBudget,
    revision: 0,
  });
  // The thread this one follows from learns its successor, and its revision
  // moves with the link; it stays closed.
  const earlier =
    event.succeeds === undefined
      ? undefined
      : state.threads.get(event.succeeds);
  if (earlier !== undefined && earlier.successor === undefined) {
    next = withThread(next, {
      ...earlier,
      successor: event.id,
      revision: earlier.revision + 1,
    });
  }
  return next;
}

export function applyPracticeMoved(
  state: WorldState,
  event: PracticeMovedEvent,
): WorldState {
  const thread = state.threads.get(event.threadId);
  if (thread === undefined || !isThreadOpen(thread)) return state;
  const revision = thread.revision + 1;
  switch (event.move) {
    case "counter":
      return withThread(state, {
        ...thread,
        term: event.term,
        offeredBy: event.entityId,
        status: "countered",
        counterBudgetLeft: Math.max(0, thread.counterBudgetLeft - 1),
        revision,
      });
    case "accept":
      return withThread(state, {
        ...thread,
        status: "accepted",
        acceptance: {
          tick: event.tick,
          sequence: event.sequence,
          sworn: event.sworn,
        },
        revision,
      });
    case "refuse":
      return withThread(state, {
        ...thread,
        status: "refused",
        closedTick: event.tick,
        revision,
      });
    case "withdraw":
      return withThread(state, {
        ...thread,
        status: "withdrawn",
        closedTick: event.tick,
        revision,
      });
  }
}

export function applyPracticeEnded(
  state: WorldState,
  event: PracticeEndedEvent,
): WorldState {
  const thread = state.threads.get(event.threadId);
  if (thread === undefined || !isThreadOpen(thread)) return state;
  return withThread(state, {
    ...thread,
    status: event.outcome,
    closedTick: event.tick,
    revision: thread.revision + 1,
  });
}

/**
 * A motif's change, applied. An oath penalty takes divinity (never more than
 * the god holds) and withholds a capability until its period ends; a
 * transformation changes form and capabilities and nothing else, so identity,
 * memory, and relationships stay with the actor. Both bump the actor's
 * revision, so a proposal it made before the change goes stale. A standing
 * record changes no state: standing itself is a later unit's.
 */
export function applyMotifApplied(
  state: WorldState,
  event: MotifAppliedEvent,
): WorldState {
  const actor = getActor(state, event.entityId);
  if (actor === undefined) return state;
  switch (event.effect) {
    case "oath-penalty": {
      const paid = debitActorInventory(
        state,
        event.entityId,
        DIVINE_CAPACITY_RESOURCE,
        Math.min(
          event.divinityLost,
          getResourceAmount(actor.inventory, DIVINE_CAPACITY_RESOURCE),
        ),
      );
      const paidActor = getActor(paid, event.entityId) as typeof actor;
      const withheld = [
        ...(paidActor.withheld ?? []).filter(
          (held) => held.capability !== event.capability,
        ),
        {
          capability: event.capability,
          restoreAt: event.accessRestoredAt,
          eventId: event.id,
        },
      ];
      return withActorState(paid, {
        ...paidActor,
        capabilities: paidActor.capabilities.filter(
          (capability) => capability !== event.capability,
        ),
        withheld,
        revision: paidActor.revision + 1,
      });
    }
    case "transformation": {
      const kept = actor.capabilities.filter(
        (capability) => !event.capabilitiesLost.includes(capability),
      );
      return withActorState(state, {
        ...actor,
        form: event.form,
        capabilities: [
          ...kept,
          ...event.capabilitiesGained.filter(
            (capability) => !kept.includes(capability),
          ),
        ],
        revision: actor.revision + 1,
      });
    }
    case "standing":
      return state;
  }
}

/** A withheld capability comes back: the penalty's period is over. */
export function applyAccessRestored(
  state: WorldState,
  event: AccessRestoredEvent,
): WorldState {
  const actor = getActor(state, event.entityId);
  if (actor === undefined) return state;
  const { withheld = [], ...rest } = actor;
  const remaining = withheld.filter(
    (held) =>
      !(
        held.capability === event.capability &&
        held.eventId === event.motifEventId
      ),
  );
  return withActorState(state, {
    ...rest,
    capabilities: actor.capabilities.includes(event.capability)
      ? actor.capabilities
      : [...actor.capabilities, event.capability],
    ...(remaining.length === 0 ? {} : { withheld: remaining }),
    revision: actor.revision + 1,
  });
}

function withActorState(state: WorldState, actor: ActorState): WorldState {
  const actors = new Map(state.actors);
  actors.set(actor.id, actor);
  return { ...state, actors };
}

// --- Terms: what can be offered ---------------------------------------------------------------

/** What stands in the way of a term, in the rejection vocabulary the validator uses. */
export interface Obstacle {
  readonly reason: RejectionReasonCode;
  readonly message: string;
}

const obstacle = (reason: RejectionReasonCode, message: string): Obstacle => ({
  reason,
  message,
});

/** The ticks `party` needs to perform `term` at best, one action per tick: the moves to get there, and the act itself. `undefined` when no route reaches. */
function ticksNeeded(
  state: WorldState,
  term: PracticeTermSpec,
): number | undefined {
  const party = getActor(state, term.party);
  if (party === undefined) return undefined;
  const hops = (to: EntityId | undefined) => {
    const place = to === undefined ? undefined : getActor(state, to);
    return place === undefined
      ? undefined
      : routeLength(
          state,
          party.locationId,
          place.locationId,
          party.capabilities,
        );
  };
  const hopsToPlace = (place: EntityId) =>
    routeLength(state, party.locationId, place, party.capabilities);
  switch (term.kind) {
    case "tell-legend": {
      const length = hopsToPlace(term.place);
      return length === undefined ? undefined : length + 1;
    }
    case "be-at":
      return hopsToPlace(term.place);
    case "stay-away":
    case "ally":
      return 0;
    case "give-resource": {
      const length = hops(term.to);
      return length === undefined ? undefined : length + 1;
    }
    case "bless-mortal": {
      const length = hops(term.mortal);
      return length === undefined ? undefined : length + 1;
    }
    case "make-offering":
      // Worship needs no place.
      return 1;
  }
}

/** Whether `holder` can have `amount` of `resource` by the deadline: it holds it now, or it is what the holder gathers. */
function canHave(
  state: WorldState,
  holder: EntityId,
  resource: string,
  amount: number,
): boolean {
  const actor = getActor(state, holder);
  if (actor === undefined) return false;
  return (
    getResourceAmount(actor.inventory, resource) >= amount ||
    actor.gathers === resource
  );
}

/**
 * What stops `term` from being performed by its party in `remaining` more
 * ticks, or `undefined` when nothing does. One rule for the offer, the
 * acceptance, and the digest of an accepted obligation, so what could be
 * offered and what can still be performed cannot drift apart. It looks at the
 * world as it stands: no one is assumed to earn, gather, or be given anything.
 */
export function termObstacle(
  state: WorldState,
  term: PracticeTermSpec,
  remaining: number,
): Obstacle | undefined {
  const party = getActor(state, term.party);
  if (!party?.alive) {
    return obstacle("dead-actor", `${term.party} is not a living actor`);
  }
  if (
    (term.kind === "tell-legend" ||
      term.kind === "be-at" ||
      term.kind === "stay-away") &&
    getLocation(state, term.place) === undefined
  ) {
    return obstacle("malformed", `unknown place: ${term.place}`);
  }
  if (term.kind === "give-resource") {
    const to = getActor(state, term.to);
    if (!to?.alive) {
      return obstacle("dead-actor", `${term.to} is not a living actor`);
    }
    if (!canHave(state, term.party, term.resource, term.amount)) {
      return obstacle(
        "insufficient-resources",
        `${term.party} cannot have ${term.amount} ${term.resource} by the deadline`,
      );
    }
  }
  if (term.kind === "ally") {
    const to = getActor(state, term.to);
    if (!to?.alive) {
      return obstacle("dead-actor", `${term.to} is not a living actor`);
    }
    if (!party.isDeity || !to.isDeity) {
      return obstacle("unauthorized-claim", "only gods ally");
    }
  }
  if (term.kind === "make-offering") {
    if (
      !getActor(state, term.to)?.isDeity ||
      !getActor(state, term.to)?.alive
    ) {
      return obstacle(
        "unauthorized-claim",
        `${term.to} is not a living deity to offer to`,
      );
    }
    if (!canHave(state, term.party, term.resource, term.amount)) {
      return obstacle(
        "insufficient-resources",
        `${term.party} cannot have ${term.amount} ${term.resource} to offer by the deadline`,
      );
    }
  }
  if (term.kind === "bless-mortal") {
    const mortal = getActor(state, term.mortal);
    if (!mortal?.alive || mortal.isDeity) {
      return obstacle("dead-actor", `${term.mortal} is not a living mortal`);
    }
    if (!party.isDeity) {
      return obstacle("unauthorized-claim", "only a deity may bless");
    }
    const cost = petitionBalanceOf(state.rules, "blessDivinityCost");
    if (getResourceAmount(party.inventory, DIVINE_CAPACITY_RESOURCE) < cost) {
      return obstacle(
        "insufficient-power",
        `${term.party} lacks the ${cost} divinity a blessing costs`,
      );
    }
    const asked = [...state.petitions.values()].some(
      (petition) =>
        petition.status === "open" &&
        petition.god === term.party &&
        petition.petitioner === term.mortal &&
        inAnswerWindow(state, petition, state.tick),
    );
    if (!asked) {
      return obstacle(
        "malformed",
        `${term.mortal} has no open petition before ${term.party}, so a blessing cannot answer anything`,
      );
    }
  }
  const needed = ticksNeeded(state, term);
  if (needed === undefined) {
    return obstacle("not-adjacent", `${term.party} has no route to do this`);
  }
  if (needed > remaining) {
    return obstacle(
      "not-adjacent",
      `${term.party} needs ${needed} ticks to do this and has ${remaining}`,
    );
  }
  return undefined;
}

/** Whether an open thread's term can still be performed by its party in the time left. False once the thread has ended. */
export function canStillPerform(
  state: WorldState,
  thread: PracticeThread,
): boolean {
  if (!isThreadOpen(thread)) return false;
  return (
    termObstacle(state, thread.term, thread.term.deadline - state.tick) ===
    undefined
  );
}

// --- Opening and moving ------------------------------------------------------------------------

export type PracticeVerdict =
  | { readonly ok: true; readonly events: readonly WorldEventDraft[] }
  | ({ readonly ok: false } & Obstacle);

const deny = (
  reason: RejectionReasonCode,
  message: string,
): PracticeVerdict => ({
  ok: false,
  reason,
  message,
});

/**
 * Whether `actor` knows the event `cause` happened: it remembers it (witnessed,
 * or told of it, whether the report itself or the event a report cites), it
 * noticed it as a loss, or it is its own open need or recorded loss. Nothing
 * the world's log holds that the actor never learned counts.
 */
export function knowsCause(
  state: WorldState,
  actor: EntityId,
  cause: EventId,
): boolean {
  if (
    getMemories(state, actor).some(
      (memory) =>
        memory.sourceEventId === cause ||
        (memory.kind === "told" && memory.linkedEventId === cause) ||
        (memory.kind === "noticed" && memory.causeEventId === cause),
    )
  ) {
    return true;
  }
  if (
    [...state.needs.values()].some(
      (need) => need.actor === actor && need.eventId === cause,
    )
  ) {
    return true;
  }
  return (state.causes.get(actor) ?? []).some((c) => c.eventId === cause);
}

/** An offered term as a committed one: its deadline counted from the tick it commits in. */
function committedTerm(
  state: WorldState,
  offer: PracticeTermOffer,
): PracticeTerm {
  const { deadlineTicks, ...spec } = offer;
  return { ...spec, deadline: state.tick + deadlineTicks } as PracticeTerm;
}

/** Checks an offered term against the world's bounds and its party's reach; the parties it may name are the caller's to check. */
function offerObstacle(
  state: WorldState,
  offer: PracticeTermOffer,
): Obstacle | undefined {
  const min = practiceBalanceOf(state.rules, "minTermTicks");
  const max = practiceBalanceOf(state.rules, "maxTermTicks");
  if (offer.deadlineTicks < min || offer.deadlineTicks > max) {
    return obstacle(
      "malformed",
      `a term allows between ${min} and ${max} ticks, not ${offer.deadlineTicks}`,
    );
  }
  return termObstacle(state, offer, offer.deadlineTicks);
}

/** Who a term may bind and benefit: the two gods of the thread, never a third. */
function bindsOutsiders(
  term: PracticeTermSpec,
  participants: readonly EntityId[],
): boolean {
  return (
    !participants.includes(term.party) ||
    ((term.kind === "give-resource" || term.kind === "ally") &&
      (!participants.includes(term.to) || term.to === term.party))
  );
}

function openDemand(
  state: WorldState,
  proposal: Extract<PracticeProposal, { move: "demand" }>,
): PracticeVerdict {
  const actor = getActor(state, proposal.actor);
  if (!actor?.isDeity) {
    return deny("unauthorized-claim", "only a god may make a demand");
  }
  if (proposal.counterparty === proposal.actor) {
    return deny("malformed", "a god cannot make a demand of itself");
  }
  const other = getActor(state, proposal.counterparty);
  if (other === undefined) {
    return deny("malformed", `unknown counterparty: ${proposal.counterparty}`);
  }
  if (!other.alive) {
    return deny("dead-actor", `${proposal.counterparty} is no longer living`);
  }
  if (!other.isDeity) {
    return deny(
      "unauthorized-claim",
      "a settlement is between gods; a mortal petitions instead",
    );
  }
  if (!knowsCause(state, proposal.actor, proposal.cause)) {
    return deny(
      "unauthorized-claim",
      `${proposal.actor} knows of no ${proposal.cause}, so cannot demand over it`,
    );
  }
  const { term } = proposal;
  if (
    term.party !== proposal.counterparty ||
    bindsOutsiders(term, [proposal.actor, proposal.counterparty])
  ) {
    return deny(
      "unauthorized-claim",
      "a demand binds the god it is made of, and no one promises a third god's cooperation",
    );
  }
  const stopped = offerObstacle(state, term);
  if (stopped !== undefined) return deny(stopped.reason, stopped.message);
  return {
    ok: true,
    events: [
      {
        kind: "practice-opened",
        entityId: proposal.actor,
        practice: "settlement",
        counterparty: proposal.counterparty,
        causes: [proposal.cause],
        term: committedTerm(state, term),
        negotiationDeadline:
          state.tick + practiceBalanceOf(state.rules, "negotiationTicks"),
        counterBudget: practiceBalanceOf(state.rules, "counterBudget"),
      },
    ],
  };
}

function answer(
  state: WorldState,
  proposal: Exclude<PracticeProposal, { move: "demand" }>,
): PracticeVerdict {
  const thread = state.threads.get(proposal.thread);
  if (thread === undefined) {
    return deny("malformed", `${proposal.thread} is not a practice thread`);
  }
  const participants = [thread.demander, thread.obligated];
  if (!participants.includes(proposal.actor)) {
    return deny(
      "unauthorized-claim",
      `${proposal.actor} is not a party to ${thread.id}`,
    );
  }
  if (!isThreadOpen(thread)) {
    return deny("malformed", `${thread.id} has ended: ${thread.status}`);
  }
  if (proposal.move === "withdraw") {
    if (thread.status === "accepted") {
      return deny(
        "malformed",
        "an accepted obligation ends by performance or breach, not by withdrawal",
      );
    }
    return {
      ok: true,
      events: [
        {
          kind: "practice-moved",
          entityId: proposal.actor,
          threadId: thread.id,
          move: "withdraw",
        },
      ],
    };
  }
  // Counter, accept, and refuse answer the offer on the table.
  if (thread.status === "accepted") {
    return deny("malformed", `${thread.id} is already accepted`);
  }
  if (state.tick > thread.negotiationDeadline) {
    return deny(
      "malformed",
      `the negotiation of ${thread.id} closed at tick ${thread.negotiationDeadline}`,
    );
  }
  if (thread.offeredBy === proposal.actor) {
    return deny(
      "unauthorized-claim",
      "the other god answers an offer; its maker may only withdraw",
    );
  }
  const other = participants.find((p) => p !== proposal.actor) as EntityId;
  if (proposal.move !== "refuse" && !getActor(state, other)?.alive) {
    return deny("dead-actor", `${other} is no longer living`);
  }
  switch (proposal.move) {
    case "refuse":
      return {
        ok: true,
        events: [
          {
            kind: "practice-moved",
            entityId: proposal.actor,
            threadId: thread.id,
            move: "refuse",
          },
        ],
      };
    case "accept": {
      if (proposal.swear === true && proposal.actor !== thread.term.party) {
        return deny(
          "unauthorized-claim",
          "only the god who must perform the term may swear it",
        );
      }
      const stopped = termObstacle(
        state,
        thread.term,
        thread.term.deadline - state.tick,
      );
      if (stopped !== undefined) return deny(stopped.reason, stopped.message);
      return {
        ok: true,
        events: [
          {
            kind: "practice-moved",
            entityId: proposal.actor,
            threadId: thread.id,
            move: "accept",
            sworn: proposal.swear === true,
          },
        ],
      };
    }
    case "counter": {
      if (thread.counterBudgetLeft < 1) {
        return deny("malformed", `${thread.id} has no counteroffers left`);
      }
      if (bindsOutsiders(proposal.term, participants)) {
        return deny(
          "unauthorized-claim",
          "a term binds only the two gods of the thread, and no one promises a third god's cooperation",
        );
      }
      const stopped = offerObstacle(state, proposal.term);
      if (stopped !== undefined) return deny(stopped.reason, stopped.message);
      return {
        ok: true,
        events: [
          {
            kind: "practice-moved",
            entityId: proposal.actor,
            threadId: thread.id,
            move: "counter",
            term: committedTerm(state, proposal.term),
          },
        ],
      };
    }
  }
}

/** The events a practice proposal would commit, or why the world refuses it. */
export function validatePractice(
  state: WorldState,
  proposal: PracticeProposal,
): PracticeVerdict {
  return proposal.move === "demand"
    ? openDemand(state, proposal)
    : answer(state, proposal);
}

// --- Judging ---------------------------------------------------------------------------------

interface Ruling {
  readonly thread: PracticeThread;
  readonly outcome: PracticeOutcome;
  readonly reason: PracticeEndReason;
  readonly performedBy?: EventId;
}

/** What `event`, seen in the world as it stood just before it (`running`), settles of an accepted `term`, or nothing. */
function observe(
  running: WorldState,
  term: PracticeTerm,
  event: WorldEvent,
): { outcome: PracticeOutcome; reason: PracticeEndReason } | undefined {
  if (event.tick > term.deadline) return undefined;
  const performed = { outcome: "fulfilled", reason: "performed" } as const;
  switch (term.kind) {
    case "tell-legend": {
      if (event.kind !== "legend-recorded" || event.entityId !== term.party) {
        return undefined;
      }
      if (running.actors.get(term.party)?.locationId !== term.place) {
        return undefined;
      }
      const toMortals = event.hearers.some((hearer) => {
        const listener = running.actors.get(hearer);
        return listener?.alive === true && listener.isDeity !== true;
      });
      return toMortals ? performed : undefined;
    }
    case "stay-away":
      return (event.kind === "entity-moved" ||
        event.kind === "realm-transitioned") &&
        event.entityId === term.party &&
        event.to === term.place
        ? { outcome: "breached", reason: "entered" }
        : undefined;
    case "give-resource": {
      if (event.kind !== "resource-traded") return undefined;
      const given =
        event.entityId === term.party && event.counterpartyId === term.to
          ? event.give
          : event.counterpartyId === term.party && event.entityId === term.to
            ? event.receive
            : [];
      const total = given
        .filter((line) => line.resource === term.resource)
        .reduce((sum, line) => sum + line.amount, 0);
      return total >= term.amount ? performed : undefined;
    }
    case "make-offering":
      return event.kind === "worship-performed" &&
        event.entityId === term.party &&
        event.deity === term.to &&
        event.offering?.resource === term.resource &&
        event.offering.amount >= term.amount
        ? performed
        : undefined;
    case "bless-mortal":
      return event.kind === "blessing-granted" &&
        event.entityId === term.party &&
        event.recipient === term.mortal
        ? performed
        : undefined;
    case "be-at":
      // Judged from where the party stands once the tick's events are in.
      return undefined;
    case "ally":
      // Sealed by agreement, ruled below.
      return undefined;
  }
}

/**
 * The rulings this tick's primary events and the clock give, in the order the
 * world makes them: performances observed after acceptance, then negotiation
 * deadlines, then spent counteroffer budgets, then obligation deadlines, then
 * the death of a party. A thread gets at most one ruling a tick, the first
 * that applies, so a performance on a deadline's last tick wins over its
 * breach and a breach already due wins over a death. `before` is the world at
 * the start of the tick and each event is judged against it with the events
 * before it applied (`apply`), so a legend is judged at the place its teller
 * stood when it spoke. `after` is the world the threads live in now.
 */
export function judgePractices(
  before: WorldState,
  primary: readonly WorldEvent[],
  after: WorldState,
  apply: (state: WorldState, event: WorldEvent) => WorldState,
): readonly WorldEventDraft[] {
  const live = [...after.threads.values()]
    .filter(isThreadOpen)
    .sort((a, b) => a.openedSequence - b.openedSequence);
  const rulings = new Map<EventId, Ruling>();
  const rule = (
    thread: PracticeThread,
    outcome: PracticeOutcome,
    reason: PracticeEndReason,
    performedBy?: EventId,
  ) => {
    if (rulings.has(thread.id)) return;
    rulings.set(thread.id, {
      thread,
      outcome,
      reason,
      ...(performedBy === undefined ? {} : { performedBy }),
    });
  };
  const accepted = live.filter(
    (thread) => thread.status === "accepted" && thread.acceptance !== undefined,
  );
  const unfinished = (thread: PracticeThread) => !rulings.has(thread.id);
  const isDead = (id: EntityId) => after.actors.get(id)?.alive !== true;

  // 1. Performances seen after acceptance, event by event.
  let running = before;
  for (const event of primary) {
    for (const thread of accepted.filter(unfinished)) {
      if (event.sequence <= (thread.acceptance?.sequence ?? Infinity)) continue;
      const seen = observe(running, thread.term, event);
      if (seen !== undefined) rule(thread, seen.outcome, seen.reason, event.id);
    }
    running = apply(running, event);
  }
  // An alliance is sealed by agreement: accepted, it needs no performance, if both gods live.
  for (const thread of accepted.filter(unfinished)) {
    const { term } = thread;
    if (term.kind === "ally" && !isDead(term.party) && !isDead(term.to)) {
      rule(thread, "fulfilled", "sealed");
    }
  }
  // Being at a place is read from where the party stands now.
  for (const thread of accepted.filter(unfinished)) {
    const { term } = thread;
    if (
      term.kind === "be-at" &&
      after.tick <= term.deadline &&
      after.actors.get(term.party)?.alive === true &&
      after.actors.get(term.party)?.locationId === term.place
    ) {
      let arrival: WorldEvent | undefined;
      for (const event of primary) {
        if (
          (event.kind === "entity-moved" ||
            event.kind === "realm-transitioned") &&
          event.entityId === term.party &&
          event.to === term.place &&
          event.sequence > (thread.acceptance?.sequence ?? Infinity)
        ) {
          arrival = event;
        }
      }
      rule(thread, "fulfilled", "performed", arrival?.id);
    }
  }

  // 2. A negotiation nobody answered in time.
  for (const thread of live) {
    if (
      unfinished(thread) &&
      (thread.status === "open" || thread.status === "countered") &&
      after.tick > thread.negotiationDeadline
    ) {
      rule(thread, "expired", "negotiation-deadline");
    }
  }
  // 3. A negotiation that spent its last counteroffer.
  for (const thread of live) {
    if (
      unfinished(thread) &&
      thread.status === "countered" &&
      thread.counterBudgetLeft === 0
    ) {
      rule(thread, "refused", "budget-exhausted");
    }
  }
  // 4. An obligation whose deadline has passed.
  for (const thread of accepted.filter(unfinished)) {
    const { term } = thread;
    if (after.tick <= term.deadline) continue;
    if (term.kind === "stay-away") {
      // A party that is gone kept nothing; the death below rules it.
      if (isDead(term.party)) continue;
      const there = after.actors.get(term.party)?.locationId === term.place;
      if (there) rule(thread, "breached", "entered");
      else rule(thread, "fulfilled", "kept-away");
    } else {
      rule(thread, "breached", "obligation-deadline");
    }
  }
  // 5. A party who died takes the thread with it, with no consequence.
  for (const thread of live) {
    if (
      unfinished(thread) &&
      (isDead(thread.demander) || isDead(thread.obligated))
    ) {
      rule(thread, "withdrawn", "party-died");
    }
  }

  return live.flatMap((thread) => {
    const ruling = rulings.get(thread.id);
    if (ruling === undefined) return [];
    const draft: WorldEventDraft = {
      kind: "practice-ended",
      entityId: thread.demander,
      counterparty: thread.obligated,
      threadId: thread.id,
      outcome: ruling.outcome,
      reason: ruling.reason,
      ...(ruling.performedBy === undefined
        ? {}
        : { performedBy: ruling.performedBy }),
    };
    return [draft];
  });
}

// --- Consequences ----------------------------------------------------------------------------

/**
 * What the world does to the gods because threads ended, as primary events
 * citing the ending that called for each (`endings`, already committed and
 * applied in `after`). A breach costs the one who breached: the bounded oath
 * penalty when it swore, the transformation the demand staked, and standing at
 * the term's place; a performance at a place earns standing there. Only an
 * accepted thread has a breacher or a performer, so a refusal, a lapse, and a
 * death change no one but through the feelings the memories of them give.
 */
export function planConsequences(
  after: WorldState,
  endings: readonly PracticeEndedEvent[],
): readonly WorldEventDraft[] {
  const drafts: WorldEventDraft[] = [];
  const standing = practiceBalanceOf(after.rules, "standingDelta");
  for (const ending of endings) {
    const thread = after.threads.get(ending.threadId);
    if (thread?.acceptance === undefined) continue;
    const { term } = thread;
    const party = after.actors.get(term.party);
    const about = {
      threadId: thread.id,
      cause: ending.id,
      entityId: term.party,
    };
    const place =
      term.kind === "tell-legend" ||
      term.kind === "be-at" ||
      term.kind === "stay-away"
        ? term.place
        : undefined;
    if (ending.outcome === "breached") {
      if (party?.alive) {
        if (thread.acceptance.sworn && party.isDeity) {
          drafts.push({
            kind: "motif-applied",
            ...about,
            motif: "oath-penalty",
            effect: "oath-penalty",
            divinityLost: Math.min(
              practiceBalanceOf(after.rules, "oathDivinityLoss"),
              getResourceAmount(party.inventory, DIVINE_CAPACITY_RESOURCE),
            ),
            capability: DIVINE_CAPABILITY,
            accessRestoredAt:
              after.tick + practiceBalanceOf(after.rules, "oathAccessTicks"),
          });
        }
        if (thread.stake !== undefined) {
          drafts.push({
            kind: "motif-applied",
            ...about,
            motif: "transformation-punishment",
            effect: "transformation",
            intent: "punishment",
            ...thread.stake,
          });
        }
      }
      if (place !== undefined && standing > 0) {
        drafts.push({
          kind: "motif-applied",
          ...about,
          motif: "standing-lost",
          effect: "standing",
          place,
          delta: -standing,
        });
      }
    } else if (
      ending.outcome === "fulfilled" &&
      place !== undefined &&
      term.kind !== "stay-away" &&
      standing > 0
    ) {
      drafts.push({
        kind: "motif-applied",
        ...about,
        motif: "standing-won",
        effect: "standing",
        place,
        delta: standing,
      });
    }
  }
  return drafts;
}

/** The capabilities whose withheld period is over at `state.tick`, each returning by an event the world records. */
export function planAccessRestorations(
  state: WorldState,
): readonly WorldEventDraft[] {
  const drafts: WorldEventDraft[] = [];
  const actors = [...state.actors.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const actor of actors) {
    for (const held of actor.withheld ?? []) {
      if (state.tick >= held.restoreAt) {
        drafts.push({
          kind: "access-restored",
          entityId: actor.id,
          capability: held.capability,
          motifEventId: held.eventId,
        });
      }
    }
  }
  return drafts;
}
