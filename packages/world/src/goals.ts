// A god's goal: private world state changed only by `goal-set` and
// `goal-ended` events. The world records what a god declares and never judges
// it: it does not check that a target is alive or reachable, and it never ends
// a goal on its own. The goal events of a proposal are planned by the tick
// (`planGoalEvents`) from the proposal's goal change and the actor's active
// goal, so replaying the log rebuilds exactly each god's active goal.

import type {
  EntityId,
  GoalChange,
  GoalEndedEvent,
  GoalSetEvent,
} from "@panthea/contracts";
import type { WorldEventDraft } from "./state";
import { type ActiveGoal, getActor, type WorldState } from "./state";

/** `actor`'s active goal, if it has one. */
export function getGoal(
  state: WorldState,
  actor: EntityId,
): ActiveGoal | undefined {
  return state.goals.get(actor);
}

export function applyGoalSet(
  state: WorldState,
  event: GoalSetEvent,
): WorldState {
  const goals = new Map(state.goals);
  goals.set(event.entityId, {
    text: event.text,
    target: event.target,
    eventId: event.id,
    sequence: event.sequence,
  });
  return { ...state, goals };
}

export function applyGoalEnded(
  state: WorldState,
  event: GoalEndedEvent,
): WorldState {
  const active = state.goals.get(event.entityId);
  // Ending a goal other than the active one (a replayed log out of order) leaves
  // the active one alone; the event names exactly the goal it ends.
  if (active === undefined || active.eventId !== event.goalEventId)
    return state;
  const goals = new Map(state.goals);
  goals.delete(event.entityId);
  return { ...state, goals };
}

/**
 * The goal events a proposal's goal change gives, in the order they commit:
 * an explicit end first (when a goal is active), then a set; a set while a
 * goal is still active first ends it as abandoned. Nothing for an actor that
 * is not a living, known actor, or when there is nothing to end.
 */
export function planGoalEvents(
  state: WorldState,
  actor: EntityId,
  change: GoalChange,
): readonly WorldEventDraft[] {
  if (!getActor(state, actor)?.alive) return [];
  const drafts: WorldEventDraft[] = [];
  let active = getGoal(state, actor);
  if (change.end !== undefined && active !== undefined) {
    drafts.push({
      kind: "goal-ended",
      entityId: actor,
      outcome: change.end.outcome,
      goalEventId: active.eventId,
    });
    active = undefined;
  }
  if (change.set !== undefined) {
    if (active !== undefined) {
      drafts.push({
        kind: "goal-ended",
        entityId: actor,
        outcome: "abandoned",
        goalEventId: active.eventId,
      });
    }
    drafts.push({
      kind: "goal-set",
      entityId: actor,
      text: change.set.text,
      target: change.set.target,
    });
  }
  return drafts;
}
