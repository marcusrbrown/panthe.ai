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
import { getMemories } from "./memory";
import { petitionBalanceOf } from "./petitions";
import {
  type ActiveGoal,
  getActor,
  type WorldEventDraft,
  type WorldState,
} from "./state";

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
    tick: event.tick,
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
/** Text compared as a goal's identity: trimmed, lowercased, whitespace collapsed. */
function normalized(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Whether the god may now drop its active goal for another reason than having
 * met or failed it: the lock (ticks since the set) has passed, or since the
 * set it has a memory involving the goal's target, or a petition has been
 * addressed to it. Nothing here judges the goal; it only asks whether the god
 * has had cause to change its mind.
 */
function unlocked(
  state: WorldState,
  actor: EntityId,
  goal: ActiveGoal,
): boolean {
  if (
    state.tick - goal.tick >=
    petitionBalanceOf(state.rules, "goalLockTicks")
  ) {
    return true;
  }
  const remembers = getMemories(state, actor).some(
    (memory) =>
      memory.recordedAt > goal.sequence &&
      memory.subjects.includes(goal.target),
  );
  if (remembers) return true;
  for (const petition of state.petitions.values()) {
    if (petition.god === actor && petition.sequence > goal.sequence)
      return true;
  }
  return false;
}

/**
 * The goal events one goal change records, in order: an end first, then a set.
 *
 * With the petition features on (the pack states `petitionBalance`) a goal
 * sticks: setting the identical goal again records nothing, ending a goal as
 * achieved or failed is always allowed, and replacing or abandoning one needs
 * `unlocked`; otherwise nothing of the change is applied and a private
 * `goal-change-refused` event records that the goal is locked, and for how
 * long. Without the tunables a goal change is never refused.
 */
export function planGoalEvents(
  state: WorldState,
  actor: EntityId,
  change: GoalChange,
): readonly WorldEventDraft[] {
  if (!getActor(state, actor)?.alive) return [];
  const drafts: WorldEventDraft[] = [];
  let active = getGoal(state, actor);
  const gate = state.rules.petitionBalance !== undefined;

  if (gate && active !== undefined) {
    const identical =
      change.end === undefined &&
      change.set !== undefined &&
      change.set.target === active.target &&
      normalized(change.set.text) === normalized(active.text);
    if (identical) return [];
    const settled =
      change.end !== undefined && change.end.outcome !== "abandoned";
    const dropping =
      change.end?.outcome === "abandoned" ||
      (!settled && change.set !== undefined);
    if (dropping && !unlocked(state, actor, active)) {
      const lock = petitionBalanceOf(state.rules, "goalLockTicks");
      return [
        {
          kind: "goal-change-refused",
          entityId: actor,
          reason: "locked",
          attempted: change.set === undefined ? "abandon" : "replace",
          unlocksInTicks: Math.max(0, lock - (state.tick - active.tick)),
        },
      ];
    }
  }

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
