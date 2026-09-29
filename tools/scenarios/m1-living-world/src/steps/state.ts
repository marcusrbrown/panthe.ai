// Lookups over a decoded world state that fail the run, naming the missing
// entity, instead of returning undefined.

import {
  getActor,
  getBuilding,
  toEntityId,
  type WorldState,
} from "@panthea/world";
import { check } from "../helpers";

export function building(state: WorldState, id: string) {
  const found = getBuilding(state, toEntityId(id));
  check(found !== undefined, `building ${id} exists`, "not in state");
  return found;
}

export function actor(state: WorldState, id: string) {
  const found = getActor(state, toEntityId(id));
  check(found !== undefined, `actor ${id} exists`, "not in state");
  return found;
}

export const amountOf = (
  inventory: ReadonlyMap<string, number>,
  resource: string,
): number => inventory.get(resource) ?? 0;
