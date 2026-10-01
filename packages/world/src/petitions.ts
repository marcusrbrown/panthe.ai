// Petitions: a mortal prays at the altar about something that happened to it,
// and the named god hears it wherever it is.
//
// A prayer has a recorded cause (an event the mortal remembers in `causes`, or
// one of its open unmet needs), one god, and one request: help with what was
// lost, or punishment of an offender who owns a building. The routine walks the
// mortal to the altar and back; the validator opens the petition and routes it.
// Everything here is a pure function of world state, and a petition is state
// changed only by events, so a replay rebuilds it.
//
// Favor is the mortal's affinity toward the god. There is no separate score.

import type {
  BlessingGrantedEvent,
  EntityId,
  EventId,
  LossNoticedEvent,
  PetitionAnsweredEvent,
  PetitionLapsedEvent,
  PetitionOpenedEvent,
  PetitionRequest,
  WorldEvent,
  WorldRules,
} from "@panthea/contracts";
import { creditActorInventory } from "./economy";
import { ALTAR, nextHop } from "./geography";
import { getMemories, getRelationship } from "./memory";
import {
  type ActorState,
  getActor,
  noticedKey,
  type Petition,
  type PetitionCause,
  type WorldEventDraft,
  type WorldState,
} from "./state";

/** Defaults for `rules.petitionBalance`, in simulation ticks unless a count. */
export const DEFAULT_PETITION_BALANCE: Readonly<Record<string, number>> = {
  /**
   * How long after a petition opens a god's answer still counts. At least
   * twice the longest route from the great hall to a petition target, plus the
   * answering action, at the slowest god pace measured (one action per 25
   * ticks): 2 x (4 + 1) x 25. A test holds it to the map.
   */
  answerWindowTicks: 250,
  /** How long after it happened an event stays something a mortal will pray about. */
  causePrayableTicks: 150,
  /** Fewest ticks between two prayers by one mortal. */
  prayerCooldownTicks: 20,
  /** Divinity a god spends to bless. */
  blessDivinityCost: 2,
  /** Planks a bless grants for a damaged building. */
  blessPlanks: 3,
  /** Units of a resource a bless grants for an unmet need. */
  blessResourceAmount: 2,
  /** Most a bless returns of stock a mortal lost to theft or spoilage. */
  blessResourceCap: 4,
  /** Ticks without a consequential event before the director causes trouble. */
  directorQuietTicks: 120,
  /** Ticks a goal stays unreplaceable without a reason. */
  goalLockTicks: 40,
};

/** A petition tunable from `rules`, or its default. */
export function petitionBalanceOf(rules: WorldRules, key: string): number {
  return rules.petitionBalance?.[key] ?? DEFAULT_PETITION_BALANCE[key] ?? 0;
}

/** Most causes a mortal keeps: the newest, so state stays bounded. */
export const MAX_CAUSES = 8;

// --- Causes ------------------------------------------------------------------

/**
 * The cause as the mortal knows it, or `undefined` when it does not know of it.
 * A mortal knows a cause only through one of these, never through the world's
 * log:
 *
 * - a memory of the cause event, witnessed or told (a told one cites it), whose
 *   subjects name the offender: it knows who did it;
 * - a memory of a loss it noticed (`planNoticeStep`): it knows what it lost and
 *   not who did it, so the offender is dropped;
 * - its own unmet need, or its own grudge, which it always knows;
 * - its own stolen or spoiled stock, which it always knows it lost.
 */
export function knownCause(
  state: WorldState,
  actorId: EntityId,
  cause: PetitionCause,
): PetitionCause | undefined {
  const { offender: _unknown, ...withoutOffender } = cause;
  if (cause.kind === "need" || cause.kind === "grudge") return cause;
  const memories = getMemories(state, actorId);
  const namesOffender = memories.some(
    (memory) =>
      cause.offender !== undefined &&
      (memory.kind === "witnessed"
        ? memory.sourceEventId === cause.eventId
        : memory.kind === "told" && memory.linkedEventId === cause.eventId) &&
      memory.subjects.includes(cause.offender),
  );
  if (namesOffender) return cause;
  const noticedIt = memories.some(
    (memory) =>
      memory.kind === "noticed" && memory.causeEventId === cause.eventId,
  );
  if (noticedIt || cause.kind === "theft" || cause.kind === "spoilage") {
    return withoutOffender;
  }
  return undefined;
}

// --- Noticing a loss -----------------------------------------------------------------------

/**
 * The `loss-noticed` events this tick records: each living owner standing at its
 * own damaged, burning, or destroyed building, and each owner of stolen or
 * spoiled stock, once per loss (`state.noticed`). The loss is the owner's own
 * recorded cause (`state.causes`), so the event names the cause that made it.
 * An environmental step like the need scan: it proposes nothing and takes no
 * action slot.
 */
export function planNoticeStep(state: WorldState): readonly WorldEventDraft[] {
  const drafts: WorldEventDraft[] = [];
  for (const [owner, causes] of state.causes) {
    const actor = getActor(state, owner);
    if (!actor?.alive) continue;
    for (const cause of causes) {
      if (state.noticed.has(noticedKey(owner, cause.eventId))) continue;
      if (cause.kind === "damage" || cause.kind === "fire") {
        const building =
          cause.building === undefined
            ? undefined
            : state.buildings.get(cause.building);
        const seesIt =
          building !== undefined &&
          building.owner === owner &&
          building.locationId === actor.locationId &&
          building.status !== "operational";
        if (seesIt) {
          drafts.push({
            kind: "loss-noticed",
            entityId: owner,
            causeEventId: cause.eventId,
            building: building.id,
          });
        }
      } else if (
        (cause.kind === "theft" || cause.kind === "spoilage") &&
        cause.resource !== undefined &&
        cause.amount !== undefined
      ) {
        drafts.push({
          kind: "loss-noticed",
          entityId: owner,
          causeEventId: cause.eventId,
          resource: cause.resource,
          amount: cause.amount,
        });
      }
    }
  }
  return drafts;
}

export function applyLossNoticed(
  state: WorldState,
  event: LossNoticedEvent,
): WorldState {
  const noticed = new Map(state.noticed);
  noticed.set(noticedKey(event.entityId, event.causeEventId), {
    owner: event.entityId,
    causeEventId: event.causeEventId,
    eventId: event.id,
  });
  return { ...state, noticed };
}

/** What a mortal could pray about now, newest first: the causes it knows (`knownCause`) and its open unmet needs, minus any already prayed about or older than the prayable window. Empty during the prayer cooldown. */
export function prayableCauses(
  state: WorldState,
  actorId: EntityId,
): readonly PetitionCause[] {
  if (inCooldown(state, actorId)) return [];
  const window = petitionBalanceOf(state.rules, "causePrayableTicks");
  const prayedAbout = new Set(
    [...state.petitions.values()].map((petition) => petition.cause),
  );
  const needs: PetitionCause[] = [...state.needs.values()]
    .filter((need) => need.actor === actorId)
    .map((need) => ({
      eventId: need.eventId,
      tick: need.tick,
      kind: "need" as const,
      resource: need.resource,
    }));
  return [...(state.causes.get(actorId) ?? []), ...needs]
    .flatMap((cause) => {
      const known = knownCause(state, actorId, cause);
      return known === undefined ? [] : [known];
    })
    .filter(
      (cause) =>
        state.tick - cause.tick <= window &&
        !prayedAbout.has(cause.eventId) &&
        requestFor(state, cause) !== undefined,
    )
    .sort(
      (a, b) =>
        b.tick - a.tick ||
        (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0),
    );
}

function inCooldown(state: WorldState, actorId: EntityId): boolean {
  const cooldown = petitionBalanceOf(state.rules, "prayerCooldownTicks");
  for (const petition of state.petitions.values()) {
    if (
      petition.petitioner === actorId &&
      state.tick - petition.tick < cooldown
    ) {
      return true;
    }
  }
  return false;
}

/** The buildings `owner` holds, in id order. */
function buildingsOwnedBy(state: WorldState, owner: EntityId): EntityId[] {
  return [...state.buildings.values()]
    .filter((building) => building.owner === owner)
    .map((building) => building.id)
    .sort();
}

/**
 * What a mortal would ask for about `cause`: punishment of an offender who owns
 * a building, otherwise help with what was lost. A grudge with no such offender
 * has nothing to ask for, so it is not prayable.
 */
export function requestFor(
  state: WorldState,
  cause: PetitionCause,
): PetitionRequest | undefined {
  const owned =
    cause.offender === undefined ? [] : buildingsOwnedBy(state, cause.offender);
  if (cause.offender !== undefined && owned.length > 0) {
    return { kind: "punish", offender: cause.offender, buildings: owned };
  }
  switch (cause.kind) {
    case "damage":
    case "fire":
      return cause.building === undefined
        ? undefined
        : {
            kind: "help",
            need: { kind: "building", building: cause.building },
          };
    case "theft":
    case "spoilage":
      return cause.resource === undefined
        ? undefined
        : {
            kind: "help",
            need: {
              kind: "resource",
              resource: cause.resource,
              ...(cause.amount === undefined ? {} : { amount: cause.amount }),
            },
          };
    case "need":
      return cause.resource === undefined
        ? undefined
        : {
            kind: "help",
            need: { kind: "resource", resource: cause.resource },
          };
    case "grudge":
      return undefined;
  }
}

// --- Routing and opening ---------------------------------------------------------------

/** Petitions ever addressed to `god`: the tie-break when a mortal favors two gods equally. */
function petitionsReceivedBy(state: WorldState, god: EntityId): number {
  let count = 0;
  for (const petition of state.petitions.values()) {
    if (petition.god === god) count += 1;
  }
  return count;
}

/** The god `mortal` prays to: the living deity it has the highest affinity toward; on a tie, the one that has received the fewest petitions; then by id. */
export function routePetition(
  state: WorldState,
  mortal: EntityId,
): EntityId | undefined {
  const gods = [...state.actors.values()]
    .filter((actor) => actor.alive && actor.isDeity === true)
    .map((actor) => actor.id)
    .sort();
  let best: EntityId | undefined;
  let bestAffinity = Number.NEGATIVE_INFINITY;
  let bestReceived = Number.POSITIVE_INFINITY;
  for (const god of gods) {
    const affinity = getRelationship(state, mortal, god)?.affinity ?? 0;
    const received = petitionsReceivedBy(state, god);
    if (
      affinity > bestAffinity ||
      (affinity === bestAffinity && received < bestReceived)
    ) {
      best = god;
      bestAffinity = affinity;
      bestReceived = received;
    }
  }
  return best;
}

/** The petition `mortal` would open citing `causeId` now, or `undefined` when the cause is not one it can pray about. */
export function petitionFor(
  state: WorldState,
  mortal: EntityId,
  causeId: EventId,
): { readonly god: EntityId; readonly request: PetitionRequest } | undefined {
  const cause = prayableCauses(state, mortal).find(
    (c) => c.eventId === causeId,
  );
  if (cause === undefined) return undefined;
  const request = requestFor(state, cause);
  const god = routePetition(state, mortal);
  return request === undefined || god === undefined
    ? undefined
    : { god, request };
}

/** Whether `actor` may pray: a living mortal. */
export function canPray(actor: ActorState | undefined): actor is ActorState {
  return actor !== undefined && actor.alive && actor.isDeity !== true;
}

/** The petitions addressed to `god` that are still open. This is the divine sense: the god's own petitions, read from world state, whatever it can perceive. */
export function openPetitionsFor(
  state: WorldState,
  god: EntityId,
): readonly Petition[] {
  return [...state.petitions.values()]
    .filter((petition) => petition.god === god && petition.status === "open")
    .sort((a, b) => a.tick - b.tick || (a.id < b.id ? -1 : 1));
}

// --- The routine's part -----------------------------------------------------------------

/** What a mortal's routine does about prayer this tick, if anything: pray, or take one step toward the altar or home. */
export type PrayerStep =
  | { readonly kind: "pray"; readonly cause: EventId }
  | {
      readonly kind: "walk";
      readonly to: EntityId;
      readonly purpose: "altar" | "home";
    };

export function prayerStep(
  state: WorldState,
  actorId: EntityId,
): PrayerStep | undefined {
  const actor = getActor(state, actorId);
  if (!canPray(actor)) return undefined;
  const [cause] = prayableCauses(state, actorId);
  if (cause !== undefined) {
    if (actor.locationId === ALTAR)
      return { kind: "pray", cause: cause.eventId };
    const hop = nextHop(state, actor.locationId, ALTAR, actor.capabilities);
    return hop === undefined
      ? undefined
      : { kind: "walk", to: hop, purpose: "altar" };
  }
  // The walk home belongs to the prayer trip: a mortal still within its prayer
  // cooldown of its last prayer is on its way back. One placed elsewhere any
  // other time stays put.
  if (
    actor.home !== undefined &&
    actor.locationId !== actor.home &&
    inCooldown(state, actorId)
  ) {
    const hop = nextHop(
      state,
      actor.locationId,
      actor.home,
      actor.capabilities,
    );
    return hop === undefined
      ? undefined
      : { kind: "walk", to: hop, purpose: "home" };
  }
  return undefined;
}

// --- Reducers ----------------------------------------------------------------------------

/** Records `cause` for `owner`, keeping only the newest `MAX_CAUSES`. */
function recordCause(
  state: WorldState,
  owner: EntityId | undefined,
  cause: PetitionCause,
): WorldState {
  if (owner === undefined || !getActor(state, owner)) return state;
  const causes = new Map(state.causes);
  causes.set(
    owner,
    [...(state.causes.get(owner) ?? []), cause].slice(-MAX_CAUSES),
  );
  return { ...state, causes };
}

/**
 * What an event that happened to a mortal leaves in its memory of causes:
 * damage or fire to its building, a theft from it, spoiled stock, a grudge. Run
 * against the state just before the event is applied.
 */
export function recordCauses(state: WorldState, event: WorldEvent): WorldState {
  switch (event.kind) {
    case "building-damaged":
      return recordCause(state, state.buildings.get(event.entityId)?.owner, {
        eventId: event.id,
        tick: event.tick,
        kind: "damage",
        offender: event.actor,
        building: event.entityId,
      });
    case "building-ignited":
      return recordCause(state, state.buildings.get(event.entityId)?.owner, {
        eventId: event.id,
        tick: event.tick,
        kind: "fire",
        ...(event.cause.kind === "director" || event.cause.actor === undefined
          ? {}
          : { offender: event.cause.actor }),
        building: event.entityId,
      });
    case "theft":
      return recordCause(state, event.victim, {
        eventId: event.id,
        tick: event.tick,
        kind: "theft",
        offender: event.entityId,
        resource: event.resource,
        amount: event.amount,
      });
    case "stock-spoiled":
      return recordCause(state, event.entityId, {
        eventId: event.id,
        tick: event.tick,
        kind: "spoilage",
        resource: event.resource,
        amount: event.amount,
      });
    case "relationship-changed":
      return event.grudgeDelta > 0
        ? recordCause(state, event.entityId, {
            eventId: event.id,
            tick: event.tick,
            kind: "grudge",
            offender: event.toward,
          })
        : state;
    default:
      return state;
  }
}

export function applyPetitionOpened(
  state: WorldState,
  event: PetitionOpenedEvent,
): WorldState {
  const petitions = new Map(state.petitions);
  petitions.set(event.id, {
    id: event.id,
    petitioner: event.entityId,
    god: event.god,
    cause: event.cause,
    request: event.request,
    tick: event.tick,
    sequence: event.sequence,
    status: "open",
  });
  return { ...state, petitions };
}

export function applyBlessingGranted(
  state: WorldState,
  event: BlessingGrantedEvent,
): WorldState {
  const granted = creditActorInventory(
    state,
    event.recipient,
    event.resource,
    event.amount,
  );
  if (event.building === undefined) return granted;
  const repairGrants = new Map(granted.repairGrants);
  repairGrants.set(event.recipient, event.building);
  return { ...granted, repairGrants };
}

function closePetition(
  state: WorldState,
  petitionId: EventId,
  status: "answered" | "lapsed",
): WorldState {
  const petition = state.petitions.get(petitionId);
  if (petition === undefined || petition.status !== "open") return state;
  const petitions = new Map(state.petitions);
  petitions.set(petitionId, { ...petition, status });
  return { ...state, petitions };
}

export function applyPetitionAnswered(
  state: WorldState,
  event: PetitionAnsweredEvent,
): WorldState {
  return closePetition(state, event.petitionId, "answered");
}

export function applyPetitionLapsed(
  state: WorldState,
  event: PetitionLapsedEvent,
): WorldState {
  return closePetition(state, event.petitionId, "lapsed");
}

// --- Judging ----------------------------------------------------------------------------

/** Whether `tick` is still inside `petition`'s answer window: inclusive, so the last tick of the window answers. */
export function inAnswerWindow(
  state: WorldState,
  petition: Petition,
  tick: number,
): boolean {
  return (
    tick - petition.tick <= petitionBalanceOf(state.rules, "answerWindowTicks")
  );
}

/** What a request asks of a bless: planks for a building, or an amount of a resource. */
export function blessingFor(
  state: WorldState,
  request: PetitionRequest,
): { resource: string; amount: number; building?: EntityId } | undefined {
  if (request.kind !== "help") return undefined;
  if (request.need.kind === "building") {
    return {
      resource: "planks",
      amount: petitionBalanceOf(state.rules, "blessPlanks"),
      building: request.need.building,
    };
  }
  // Lost stock is returned up to the cap; an unmet need gets the standing amount.
  return {
    resource: request.need.resource,
    amount:
      request.need.amount === undefined
        ? petitionBalanceOf(state.rules, "blessResourceAmount")
        : Math.min(
            request.need.amount,
            petitionBalanceOf(state.rules, "blessResourceCap"),
          ),
  };
}

/** A judged answer: the petition it answers and the event that answered it. */
export interface Answer {
  readonly petition: Petition;
  readonly answeredBy: WorldEvent;
}

/**
 * The petitions this tick's primary events answer, in event order. `before` is
 * the world at the start of the tick and each event is judged against it with
 * the events before it applied (`applyEvent`), so a strike is judged on the
 * building as it stood. `petitions` is the world the petitions live in now.
 *
 * A strike by the named god on an operational building the offender owns
 * answers every open punish petition against that offender that lists it. A
 * blessing answers the one petition it names. An answer inside the window
 * counts; the lapse check runs afterwards, so an answer on a petition's last
 * tick wins over its lapse.
 */
export function judgeAnswers(
  before: WorldState,
  primary: readonly WorldEvent[],
  petitions: WorldState,
  apply: (state: WorldState, event: WorldEvent) => WorldState,
): readonly Answer[] {
  const answers: Answer[] = [];
  const answered = new Set<EventId>();
  let running = before;
  for (const event of primary) {
    const open = (petition: Petition) =>
      !answered.has(petition.id) &&
      petitions.petitions.get(petition.id)?.status === "open" &&
      inAnswerWindow(petitions, petition, event.tick);
    const answer = (petition: Petition) => {
      answered.add(petition.id);
      answers.push({ petition, answeredBy: event });
    };
    if (event.kind === "blessing-granted") {
      const petition = petitions.petitions.get(event.petitionId);
      if (petition && open(petition)) answer(petition);
    } else if (
      event.kind === "building-damaged" ||
      event.kind === "building-ignited"
    ) {
      const striker =
        event.kind === "building-damaged"
          ? event.actor
          : event.cause.kind === "strike"
            ? event.cause.actor
            : undefined;
      const building = running.buildings.get(event.entityId);
      if (striker !== undefined && building?.status === "operational") {
        for (const petition of petitions.petitions.values()) {
          if (
            petition.god === striker &&
            petition.request.kind === "punish" &&
            petition.request.buildings.includes(event.entityId) &&
            open(petition)
          ) {
            answer(petition);
          }
        }
      }
    }
    running = apply(running, event);
  }
  return answers;
}

/** The open petitions whose window ends at or before `state.tick`: the lapse check, run after answers. */
export function lapsingPetitions(state: WorldState): readonly Petition[] {
  const window = petitionBalanceOf(state.rules, "answerWindowTicks");
  return [...state.petitions.values()].filter(
    (petition) =>
      petition.status === "open" && state.tick - petition.tick >= window,
  );
}

/** The draft of a `petition-answered` event. */
export function answeredDraft(answer: Answer): WorldEventDraft {
  return {
    kind: "petition-answered",
    entityId: answer.petition.petitioner,
    god: answer.petition.god,
    petitionId: answer.petition.id,
    answeredBy: answer.answeredBy.id,
  };
}
