// The repair rule: a damaged, destroyed, or repairing building is
// restored by an actor spending planks against it, incrementally, over
// however many ticks its full cost takes at the content-authored rate.
// Nothing but a `repair` proposal advances it -- unlike fire, repair has
// no automatic per-tick step.

import type { EntityId } from "@panthea/contracts";
import { debitActorInventory, getResourceAmount } from "./economy";
import {
  type ActorState,
  type BuildingState,
  buildingBase,
  getActor,
  getBuilding,
  type WorldState,
} from "./state";

/** The one resource repair consumes; a code-level constant, not an authored field, since every repair in this content spends the same material. */
export const REPAIR_RESOURCE = "planks";

export function repairCostOf(state: WorldState): number {
  return state.rules.economyBalance.repairCostPlanks ?? 0;
}

export function repairAmountPerTickOf(state: WorldState): number {
  return state.rules.economyBalance.repairAmountPerTick ?? 1;
}

/** The first building `actorId` owns that is damaged, destroyed, or mid-repair, or `undefined` if it owns none. */
export function findRepairableBuilding(
  state: WorldState,
  actorId: EntityId,
): BuildingState | undefined {
  for (const building of state.buildings.values()) {
    if (building.owner !== actorId) continue;
    if (
      building.status === "damaged" ||
      building.status === "destroyed" ||
      building.status === "repairing"
    ) {
      return building;
    }
  }
  return undefined;
}

/** Debits `amount` of the repair resource from the repairer's inventory and credits it toward the building's progress; the building enters (or stays in) "repairing". */
export function applyRepairProgressed(
  state: WorldState,
  actorId: EntityId,
  structureId: EntityId,
  resource: string,
  amount: number,
): WorldState {
  const building = getBuilding(state, structureId);
  if (!building) return state;
  const debited = debitActorInventory(state, actorId, resource, amount);
  const buildings = new Map(debited.buildings);
  buildings.set(structureId, {
    ...buildingBase(building),
    status: "repairing",
    repairProgress: (building.repairProgress ?? 0) + amount,
    revision: building.revision + 1,
  });
  return { ...debited, buildings };
}

/** Completes a repair: the building returns to "operational" with services and income restored, and its repair progress cleared. */
export function applyBuildingRepaired(
  state: WorldState,
  entityId: EntityId,
): WorldState {
  const building = getBuilding(state, entityId);
  if (!building) return state;
  const buildings = new Map(state.buildings);
  buildings.set(entityId, {
    id: building.id,
    locationId: building.locationId,
    name: building.name,
    material: building.material,
    combustible: building.combustible,
    services: building.services,
    inventory: building.inventory,
    ...(building.owner === undefined ? {} : { owner: building.owner }),
    status: "operational",
    revision: building.revision + 1,
  });
  return { ...state, buildings };
}

/** The repairing actor's held amount of the repair resource, for validation and routine decisions. */
export function heldRepairResource(actor: ActorState): number {
  return getResourceAmount(actor.inventory, REPAIR_RESOURCE);
}

export function actorHoldsEnoughToRepair(
  state: WorldState,
  actorId: EntityId,
): boolean {
  const actor = getActor(state, actorId);
  if (!actor) return false;
  return heldRepairResource(actor) >= repairAmountPerTickOf(state);
}
