// Shared test fixtures: the authored Greek world and god profiles, loaded from
// content/greek, so agent tests exercise the real pack rather than a copy.

import { join } from "node:path";
import {
  type GodProfile,
  loadContentPack,
  loadGodProfiles,
} from "@panthea/content";
import type { WorldEvent } from "@panthea/contracts";
import {
  createInitialWorldState,
  getActor,
  toEntityId,
  type WorldState,
  withActor,
} from "@panthea/world";

const GREEK = join(import.meta.dir, "..", "..", "..", "content", "greek");

const packResult = loadContentPack(join(GREEK, "world"));
if (!packResult.ok)
  throw new Error(`${packResult.path}: ${packResult.message}`);
const pack = packResult.value;
const godsResult = loadGodProfiles(join(GREEK, "gods"), pack);
if (!godsResult.ok)
  throw new Error(`${godsResult.path}: ${godsResult.message}`);
const gods = godsResult.value;

export function greekState(): WorldState {
  return createInitialWorldState(pack);
}

/**
 * `state` with fire unable to spread, for a test about what one strike made
 * its witnesses remember: the square now holds a woodshed beside the oak, and
 * a spread to either would be a second thing Hera saw.
 */
export function withoutFireSpread(state: WorldState): WorldState {
  return {
    ...state,
    rules: {
      ...state.rules,
      fireBalance: { ...state.rules.fireBalance, spreadChancePerTick: 0 },
    },
  };
}

export function godProfile(id: string): GodProfile {
  const profile = gods.find((god) => god.id === id);
  if (!profile) throw new Error(`no god profile for ${id}`);
  return profile;
}

export const allGodProfiles: readonly GodProfile[] = gods;

/** `state` with `actorId` standing at `locationId`. */
export function actorAt(
  state: WorldState,
  actorId: string,
  locationId: string,
): WorldState {
  const actor = getActor(state, toEntityId(actorId));
  if (!actor) throw new Error(`the Greek pack has no actor ${actorId}`);
  return withActor(state, { ...actor, locationId: toEntityId(locationId) });
}

/** `state` with `actorId` holding `amount` of `resource`. */
export function actorHolding(
  state: WorldState,
  actorId: string,
  resource: string,
  amount: number,
): WorldState {
  const actor = getActor(state, toEntityId(actorId));
  if (!actor) throw new Error(`the Greek pack has no actor ${actorId}`);
  const inventory = new Map(actor.inventory);
  inventory.set(resource, amount);
  return withActor(state, { ...actor, inventory });
}

let nextSequence = 1;

/** A committed event with a fixed envelope, for perception windows. */
export function committedEvent(
  payload: Record<string, unknown>,
  sequence = nextSequence++,
): WorldEvent {
  return {
    schemaVersion: 1,
    id: `evt-${sequence}`,
    sequence,
    simTime: sequence * 1000,
    correlationId: `obs-${sequence}`,
    causationId: `obs-${sequence}`,
    tick: 1,
    approximate: false,
    ...payload,
  } as unknown as WorldEvent;
}

/** `state` with `actorId` holding exactly `capabilities`; a test uses it for a capability-less deity, which the authored pack no longer has. */
export function actorWithCapabilities(
  state: WorldState,
  actorId: string,
  capabilities: readonly string[],
): WorldState {
  const actor = getActor(state, toEntityId(actorId));
  if (!actor) throw new Error(`the Greek pack has no actor ${actorId}`);
  return withActor(state, { ...actor, capabilities });
}
