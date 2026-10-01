// Unmet needs: what a mortal's routine wants and cannot get, recorded once as
// an event a prayer can cite and closed when the need is met.
//
// The scan is an environmental step of the tick, beside income and fire. It
// proposes nothing and takes no action slot, so routines keep returning their
// one proposal. It reads the same wants the routine does (`foodWant`,
// `wantedWant`, `surplusWant`), so what a mortal needs and what it records
// cannot drift apart. State changes only by events: a need opens with
// `unmet-need` and closes with `need-met`, so a replay reproduces them.

import type {
  NeedMetEvent,
  TheftEvent,
  UnmetNeedEvent,
  UnmetNeedReason,
} from "@panthea/contracts";
import { creditActorInventory, debitActorInventory } from "./economy";
import { foodWant, surplusWant, wantedWant } from "./routines";
import { needKey, type WorldEventDraft, type WorldState } from "./state";

/** Every shortfall the mortal's routine finds now, one per resource: the first reason found wins. */
export function currentNeeds(
  state: WorldState,
  actorId: string,
): readonly { readonly resource: string; readonly reason: UnmetNeedReason }[] {
  const actor = [...state.actors].find(([id]) => id === actorId)?.[1];
  if (!actor?.alive || !actor.drives) return [];
  const found = new Map<string, UnmetNeedReason>();
  for (const want of [
    foodWant(state, actor.id, actor),
    wantedWant(state, actor.id, actor),
    surplusWant(state, actor.id, actor),
  ]) {
    if (want && "unmet" in want && !found.has(want.resource)) {
      found.set(want.resource, want.unmet);
    }
  }
  return [...found].map(([resource, reason]) => ({ resource, reason }));
}

/**
 * The events this tick's scan records, in mortal order: an `unmet-need` for
 * each shortfall with no open need, and a `need-met` for each open need whose
 * shortfall is gone. A need that is still short stays open and records
 * nothing.
 */
export function planNeedStep(state: WorldState): readonly WorldEventDraft[] {
  const drafts: WorldEventDraft[] = [];
  for (const [actorId, actor] of state.actors) {
    if (!actor.alive || !actor.drives) continue;
    const current = currentNeeds(state, actorId);
    for (const need of current) {
      if (state.needs.has(needKey(actorId, need.resource))) continue;
      drafts.push({
        kind: "unmet-need",
        entityId: actorId,
        resource: need.resource,
        reason: need.reason,
      });
    }
    for (const open of state.needs.values()) {
      if (open.actor !== actorId) continue;
      if (current.some((need) => need.resource === open.resource)) continue;
      drafts.push({
        kind: "need-met",
        entityId: actorId,
        resource: open.resource,
        needEventId: open.eventId,
      });
    }
  }
  return drafts;
}

// --- Reducers -------------------------------------------------------------------

export function applyUnmetNeed(
  state: WorldState,
  event: UnmetNeedEvent,
): WorldState {
  const needs = new Map(state.needs);
  needs.set(needKey(event.entityId, event.resource), {
    actor: event.entityId,
    resource: event.resource,
    reason: event.reason,
    eventId: event.id,
    tick: event.tick,
  });
  return { ...state, needs };
}

export function applyNeedMet(
  state: WorldState,
  event: NeedMetEvent,
): WorldState {
  const key = needKey(event.entityId, event.resource);
  if (state.needs.get(key)?.eventId !== event.needEventId) return state;
  const needs = new Map(state.needs);
  needs.delete(key);
  return { ...state, needs };
}

/** The offender takes `amount` of `resource` from the victim. Never undone. */
export function applyTheft(state: WorldState, event: TheftEvent): WorldState {
  return creditActorInventory(
    debitActorInventory(state, event.victim, event.resource, event.amount),
    event.entityId,
    event.resource,
    event.amount,
  );
}
