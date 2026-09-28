// The fire rule. Spread and burn-through run once per tick as an
// automatic step (`planFireStep`), separate from the proposal queue: a
// burning building keeps burning without anything proposing its
// continuation. Ignition is caused either by a `strike` proposal
// (validate.ts) or by this step's own spread roll; both produce the same
// `building-ignited` event, applied by the same reducer.
//
// Fire state (`fireIntensity`, `ticksBurning`) lives only in
// `BuildingState`, set by the events below -- never a timer, and never
// read anywhere but through those events and the reducers that apply
// them.

import type { EntityId, ResourceAmount } from "@panthea/contracts";
import { isAdjacent } from "./geography";
import {
  type BuildingState,
  getBuilding,
  nextPrngValue,
  type PrngState,
  type WorldEventDraft,
  type WorldState,
} from "./state";

function fireBalanceNumber(
  state: WorldState,
  key: string,
  fallback: number,
): number {
  return state.rules.fireBalance[key] ?? fallback;
}

/** The minimum strike power that ignites a combustible target outright, rather than merely damaging it. */
export function igniteThresholdOf(state: WorldState): number {
  return fireBalanceNumber(state, "igniteThreshold", Number.POSITIVE_INFINITY);
}

export interface FireStepResult {
  readonly prng: PrngState;
  readonly events: readonly WorldEventDraft[];
}

/**
 * Advances every currently burning building by one tick: intensity grows,
 * and a building whose intensity crosses `destroyIntensity` is destroyed
 * (its inventory disposed, per the content-authored rule) instead of
 * receiving a burn-tick. Then rolls, from the persisted PRNG, whether each
 * burning building's operational or damaged, combustible neighbors catch
 * fire too -- bounded by `maxSpreadPerTick` new ignitions total this step,
 * and a building already ignited this step is never rolled for again. A
 * non-combustible neighbor is never a candidate.
 */
export function planFireStep(
  state: WorldState,
  prng: PrngState,
): FireStepResult {
  const intensityGrowth = fireBalanceNumber(state, "intensityGrowthPerTick", 1);
  const destroyIntensity = fireBalanceNumber(state, "destroyIntensity", 3);
  const spreadChance = fireBalanceNumber(state, "spreadChancePerTick", 0);
  const maxSpread = fireBalanceNumber(state, "maxSpreadPerTick", 0);

  const events: WorldEventDraft[] = [];
  const burning = [...state.buildings.values()].filter(
    (building) => building.status === "burning",
  );

  for (const building of burning) {
    const nextIntensity = (building.fireIntensity ?? 0) + intensityGrowth;
    if (nextIntensity >= destroyIntensity) {
      const disposedInventory: ResourceAmount[] = [
        ...building.inventory.entries(),
      ].map(([resource, amount]) => ({ resource, amount }));
      events.push({
        kind: "building-destroyed",
        entityId: building.id,
        disposedInventory,
      });
    } else {
      events.push({
        kind: "building-burn-ticked",
        entityId: building.id,
        fireIntensity: nextIntensity,
        ticksBurning: (building.ticksBurning ?? 0) + 1,
      });
    }
  }

  let currentPrng = prng;
  let spreadCount = 0;
  const ignitedThisStep = new Set<EntityId>();

  spreadLoop: for (const source of burning) {
    for (const [candidateId, candidate] of state.buildings) {
      if (spreadCount >= maxSpread) break spreadLoop;
      if (candidateId === source.id) continue;
      if (ignitedThisStep.has(candidateId)) continue;
      if (!candidate.combustible) continue;
      if (candidate.status !== "operational" && candidate.status !== "damaged")
        continue;
      const adjacent =
        candidate.locationId === source.locationId ||
        isAdjacent(state, source.locationId, candidate.locationId);
      if (!adjacent) continue;

      const draw = nextPrngValue(currentPrng);
      currentPrng = draw.state;
      if (draw.value < spreadChance) {
        events.push({ kind: "building-ignited", entityId: candidateId });
        ignitedThisStep.add(candidateId);
        spreadCount += 1;
      }
    }
  }

  return { prng: currentPrng, events };
}

function setBuilding(state: WorldState, building: BuildingState): WorldState {
  const buildings = new Map(state.buildings);
  buildings.set(building.id, building);
  return { ...state, buildings };
}

export function applyBuildingDamaged(
  state: WorldState,
  entityId: EntityId,
): WorldState {
  const building = getBuilding(state, entityId);
  if (!building) return state;
  return setBuilding(state, {
    ...building,
    status: "damaged",
    revision: building.revision + 1,
  });
}

export function applyBuildingIgnited(
  state: WorldState,
  entityId: EntityId,
): WorldState {
  const building = getBuilding(state, entityId);
  if (!building) return state;
  return setBuilding(state, {
    ...building,
    status: "burning",
    fireIntensity: 0,
    ticksBurning: 0,
    revision: building.revision + 1,
  });
}

export function applyBuildingBurnTicked(
  state: WorldState,
  entityId: EntityId,
  fireIntensity: number,
  ticksBurning: number,
): WorldState {
  const building = getBuilding(state, entityId);
  if (!building) return state;
  return setBuilding(state, {
    ...building,
    fireIntensity,
    ticksBurning,
    revision: building.revision + 1,
  });
}

/** Disposes the building's entire inventory (a declared sink) and stops its services and income. */
export function applyBuildingDestroyed(
  state: WorldState,
  entityId: EntityId,
): WorldState {
  const building = getBuilding(state, entityId);
  if (!building) return state;
  return setBuilding(state, {
    id: building.id,
    locationId: building.locationId,
    name: building.name,
    material: building.material,
    combustible: building.combustible,
    services: building.services,
    inventory: new Map(),
    ...(building.owner === undefined ? {} : { owner: building.owner }),
    status: "destroyed",
    revision: building.revision + 1,
  });
}
