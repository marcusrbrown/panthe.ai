// Builders for the committed-state frames the client tests feed through
// the same parse and decode path a live frame takes. A small three-realm
// world stands in for the authored pack: two mortal locations, one
// Olympus location, and the Underworld gate.

import type { RecentEvent, WorldRules } from "@panthea/contracts";
import {
  type ActorState,
  type BuildingState,
  encode,
  toEntityId,
  type WorldState,
  withActor,
  withBuilding,
} from "@panthea/world";

const RULES: WorldRules = {
  catchUpCapMs: 3_600_000,
  catchUpChunkMs: 60_000,
  checkpointIntervalMs: 60_000,
  maxProposalsPerTick: 50,
  fireBalance: { destroyIntensity: 3 },
  economyBalance: { repairCostPlanks: 3 },
};

function inventory(
  entries: Readonly<Record<string, number>>,
): ReadonlyMap<string, number> {
  return new Map(Object.entries(entries));
}

export function baseState(): WorldState {
  const location = (
    id: string,
    realm: "mortal" | "olympus" | "underworld",
    name: string,
    to: string,
  ) => ({
    id: toEntityId(id),
    realm,
    name,
    edges: [{ to, transport: "path" as const, bidirectional: true }],
    revision: 0,
  });
  const actor = (
    id: string,
    locationId: string,
    stock: Readonly<Record<string, number>>,
    extra: Partial<ActorState> = {},
  ): ActorState => ({
    id: toEntityId(id),
    locationId: toEntityId(locationId),
    alive: true,
    capabilities: [],
    inventory: inventory(stock),
    revision: 0,
    ...extra,
  });

  const base: WorldState = {
    tick: 3,
    simTime: 3_000,
    lastSequence: 9,
    locations: new Map([
      [
        toEntityId("town-square"),
        location("town-square", "mortal", "Town Square", "agora"),
      ],
      [
        toEntityId("agora"),
        location("agora", "mortal", "Agora", "town-square"),
      ],
      [
        toEntityId("olympus-hall"),
        location("olympus-hall", "olympus", "Hall of Olympus", "town-square"),
      ],
      [
        toEntityId("underworld-gate"),
        location("underworld-gate", "underworld", "Underworld Gate", "agora"),
      ],
    ]),
    actors: new Map(),
    buildings: new Map(),
    legends: new Map(),
    rules: RULES,
    recipes: {},
  };

  const building = (
    id: string,
    locationId: string,
    name: string,
    extra: Partial<BuildingState> = {},
  ): BuildingState => ({
    id: toEntityId(id),
    locationId: toEntityId(locationId),
    name,
    material: "wood",
    combustible: true,
    services: ["drink"],
    inventory: inventory({}),
    status: "operational",
    revision: 0,
    ...extra,
  });

  const actors = [
    actor("woodcutter", "town-square", { wood: 2, currency: 5 }),
    actor("farmer", "agora", { food: 3 }),
    actor("zeus", "olympus-hall", { divinity: 10 }, { isDeity: true }),
  ];
  const buildings = [
    building("the-tavern", "town-square", "The Tavern", {
      status: "burning",
      fireIntensity: 2,
      ticksBurning: 2,
    }),
    building("agora-shop", "agora", "Agora Shop", {
      inventory: inventory({ planks: 1 }),
      material: "stone",
      combustible: false,
    }),
  ];

  const withActors = actors.reduce<WorldState>(withActor, base);
  return buildings.reduce<WorldState>(withBuilding, withActors);
}

export function movedActor(
  state: WorldState,
  actorId: string,
  locationId: string,
): WorldState {
  const actor = state.actors.get(toEntityId(actorId));
  if (!actor) throw new Error(`fixture has no actor ${actorId}`);
  return withActor(state, {
    ...actor,
    locationId: toEntityId(locationId),
    revision: actor.revision + 1,
  });
}

export function deadActor(state: WorldState, actorId: string): WorldState {
  const actor = state.actors.get(toEntityId(actorId));
  if (!actor) throw new Error(`fixture has no actor ${actorId}`);
  return withActor(state, { ...actor, alive: false });
}

export function withoutActor(state: WorldState, actorId: string): WorldState {
  const actors = new Map(state.actors);
  actors.delete(toEntityId(actorId));
  return { ...state, actors };
}

/** The tavern after its fire is out and repair has begun, with `progress` materials committed so far. */
export function repairingTavern(
  state: WorldState,
  progress: number,
): WorldState {
  const tavern = state.buildings.get(toEntityId("the-tavern"));
  if (!tavern) throw new Error("fixture has no tavern");
  const { fireIntensity: _fire, ticksBurning: _burning, ...rest } = tavern;
  return withBuilding(state, {
    ...rest,
    status: "repairing",
    repairProgress: progress,
  });
}

export function atTick(state: WorldState, tick: number): WorldState {
  return { ...state, tick, simTime: tick * 1000 };
}

export interface FrameOptions {
  readonly sequence?: number;
  readonly sessionId?: string;
  readonly status?: "running" | "paused" | "degraded";
  readonly degradedReason?: string;
  readonly catchUpSummary?: {
    readonly appliedMs: number;
    readonly skippedMs: number;
    readonly majorOutcomes: readonly string[];
  };
  readonly recentEvents?: readonly RecentEvent[];
}

/** The JSON value the sidecar would send for `state`, exactly as it crosses the Channel. */
export function framePayload(
  state: WorldState,
  options: FrameOptions = {},
): unknown {
  const payload = {
    schemaVersion: 1,
    sequence: options.sequence ?? state.lastSequence,
    worldId: "world-1",
    sessionId: options.sessionId ?? "session-1",
    status: options.status ?? "running",
    ...(options.degradedReason === undefined
      ? {}
      : { degradedReason: options.degradedReason }),
    ...(options.catchUpSummary === undefined
      ? {}
      : { catchUpSummary: options.catchUpSummary }),
    recentEvents: options.recentEvents ?? [],
    state: encode(state),
  };
  return JSON.parse(JSON.stringify(payload));
}
