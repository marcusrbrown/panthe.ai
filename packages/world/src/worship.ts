// The worship rule: a worship act credits the deity's divine capacity and
// grants the worshiper a favor -- a source, an effect, and a
// content-authored duration. A favor's one effect increases the gather
// yield of an actor holding it, applied by `validate.ts`'s `handleGather`
// and checked against the current tick each time (`isFavorActive`); an
// expired favor stays in `ActorState.favors` but grants nothing.

import type { EntityId, ResourceAmount } from "@panthea/contracts";
import { creditActorInventory, debitActorInventory } from "./economy";
import {
  type ActorState,
  activeFavors,
  type WorldEventDraft,
  type WorldState,
} from "./state";

/** The one favor effect worship grants. */
export const FAVOR_EFFECT = "divine-favor";

/** The resource a deity's divine capacity is tracked as, spent by `strike` and replenished by `worship`. */
export const DIVINE_CAPACITY_RESOURCE = "divinity";

export function worshipCapacityGainOf(state: WorldState): number {
  return state.rules.economyBalance.worshipCapacityGain ?? 1;
}

export function favorDurationTicksOf(state: WorldState): number {
  return state.rules.economyBalance.favorDurationTicks ?? 1;
}

/** The extra amount a gather yields while the actor holds an active favor. */
export function favorGatherBonusOf(state: WorldState): number {
  return state.rules.economyBalance.favorGatherBonus ?? 0;
}

/** Whether `actor` currently holds an active favor granting the gather bonus. */
export function hasActiveGatherFavor(
  actor: ActorState,
  currentTick: number,
): boolean {
  return activeFavors(actor, currentTick).some(
    (favor) => favor.effect === FAVOR_EFFECT,
  );
}

/**
 * The worship a mortal offers when a god answers it: no offering, the usual
 * favor. Drafted by the tick from the answer, so it credits the god's divinity
 * and grants the favor through the one worship reducer.
 */
export function answeredWorshipDraft(
  state: WorldState,
  worshiper: EntityId,
  deity: EntityId,
): WorldEventDraft {
  return {
    kind: "worship-performed",
    entityId: worshiper,
    deity,
    favorEffect: FAVOR_EFFECT,
    favorExpiresAtTick: state.tick + favorDurationTicksOf(state),
  };
}

/**
 * Credits the deity's divine capacity, debits the worshiper's offering (a
 * declared sink), and grants the worshiper a favor with the given effect
 * and expiry.
 */
export function applyWorshipPerformed(
  state: WorldState,
  actorId: EntityId,
  deityId: EntityId,
  offering: ResourceAmount | undefined,
  favorEffect: string,
  favorExpiresAtTick: number,
): WorldState {
  let next = creditActorInventory(
    state,
    deityId,
    DIVINE_CAPACITY_RESOURCE,
    worshipCapacityGainOf(state),
  );
  if (offering) {
    next = debitActorInventory(
      next,
      actorId,
      offering.resource,
      offering.amount,
    );
  }
  const actor = next.actors.get(actorId);
  if (!actor) return next;
  const actors = new Map(next.actors);
  actors.set(actorId, {
    ...actor,
    favors: [
      ...(actor.favors ?? []),
      {
        source: deityId,
        effect: favorEffect,
        expiresAtTick: favorExpiresAtTick,
      },
    ],
    revision: actor.revision + 1,
  });
  return { ...next, actors };
}
