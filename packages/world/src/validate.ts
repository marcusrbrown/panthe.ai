// Execution-time proposal validation: a pure function over a `WorldState`
// view and a `Proposal`, returning either the draft events a commit would
// append or a typed rejection from packages/contracts' shared
// `RejectionReasonCode` vocabulary. Nothing here mutates `WorldState`;
// packages/world/src/actions.ts applies the returned drafts through
// `applyEvent` after a handler approves them.
//
// Shared, kind-agnostic checks (actor exists and is alive, every
// `expectedRevisions` entry still matches) run once in `validateProposal`
// before dispatching to a kind-specific handler, so every proposal kind
// gets them for free.

import type {
  ClaimProposal,
  ConsumeProposal,
  EntityId,
  GatherProposal,
  LegendProposal,
  MoveProposal,
  ProduceProposal,
  Proposal,
  RealmTransitionProposal,
  RejectionReasonCode,
  RepairProposal,
  ResourceAmount,
  StrikeProposal,
  TradeProposal,
  WorshipProposal,
} from "@panthea/contracts";
import {
  evaluateTradeAcceptance,
  gatherAmountOf,
  getResourceAmount,
  NEUTRAL_DRIVES,
} from "./economy";
import { igniteThresholdOf } from "./fire";
import { crossesRealm, findEdge, isAdjacent } from "./geography";
import { REPAIR_RESOURCE, repairAmountPerTickOf, repairCostOf } from "./repair";
import {
  getActor,
  getBuilding,
  getEntityRevision,
  getLocation,
  toLegendId,
  type WorldEventDraft,
  type WorldState,
} from "./state";
import {
  DIVINE_CAPACITY_RESOURCE,
  FAVOR_EFFECT,
  favorDurationTicksOf,
  favorGatherBonusOf,
  hasActiveGatherFavor,
} from "./worship";

export interface RuleRejection {
  readonly ok: false;
  readonly reason: RejectionReasonCode;
  readonly message: string;
}

export interface RuleCommit {
  readonly ok: true;
  readonly events: readonly WorldEventDraft[];
}

export type RuleOutcome = RuleCommit | RuleRejection;

export function reject(
  reason: RejectionReasonCode,
  message: string,
): RuleRejection {
  return { ok: false, reason, message };
}

export function commit(events: readonly WorldEventDraft[]): RuleCommit {
  return { ok: true, events };
}

function hasCapability(
  capabilities: readonly string[],
  required: string | undefined,
): boolean {
  return required === undefined || capabilities.includes(required);
}

function actorLocationOf(
  state: WorldState,
  actorId: EntityId,
): EntityId | undefined {
  return getActor(state, actorId)?.locationId;
}

function handleMove(state: WorldState, proposal: MoveProposal): RuleOutcome {
  const from = actorLocationOf(state, proposal.actor);
  const destination = getLocation(state, proposal.to);
  if (from === undefined || !destination) {
    return reject("malformed", `unknown move destination: ${proposal.to}`);
  }
  if (!isAdjacent(state, from, proposal.to)) {
    return reject(
      "not-adjacent",
      `${proposal.to} is not adjacent to the actor's current location`,
    );
  }
  if (crossesRealm(state, from, proposal.to)) {
    return reject(
      "restricted-realm",
      "a plain move cannot cross realms; use a realm-transition proposal via an authored transport element",
    );
  }
  const actor = getActor(state, proposal.actor);
  if (
    !hasCapability(actor?.capabilities ?? [], destination.requiredCapability)
  ) {
    return reject(
      "restricted-realm",
      `${proposal.to} requires capability ${String(destination.requiredCapability)}`,
    );
  }
  return commit([
    { kind: "entity-moved", entityId: proposal.actor, to: proposal.to },
  ]);
}

function handleRealmTransition(
  state: WorldState,
  proposal: RealmTransitionProposal,
): RuleOutcome {
  const from = actorLocationOf(state, proposal.actor);
  if (from === undefined) {
    return reject("malformed", "actor has no known current location");
  }
  if (from !== proposal.via) {
    return reject(
      "not-adjacent",
      `actor must be at the transport element ${proposal.via} to use it`,
    );
  }
  const destination = getLocation(state, proposal.to);
  if (!destination) {
    return reject(
      "malformed",
      `unknown realm-transition destination: ${proposal.to}`,
    );
  }
  const edge = findEdge(state, proposal.via, proposal.to);
  if (!edge) {
    return reject(
      "not-adjacent",
      `no transport edge from ${proposal.via} to ${proposal.to}`,
    );
  }
  if (edge.transport === "path") {
    return reject(
      "restricted-realm",
      `${proposal.via} -> ${proposal.to} is a plain path, not an authored transport element; realm transitions require a non-path transport`,
    );
  }
  const actor = getActor(state, proposal.actor);
  if (
    !hasCapability(actor?.capabilities ?? [], destination.requiredCapability)
  ) {
    return reject(
      "restricted-realm",
      `${proposal.to} requires capability ${String(destination.requiredCapability)}`,
    );
  }
  return commit([
    {
      kind: "realm-transitioned",
      entityId: proposal.actor,
      to: proposal.to,
      via: proposal.via,
    },
  ]);
}

/**
 * A claim never commits world state: it is an assertion for the
 * worship/legend system to record as a rumor, optionally later linked to
 * a verified event -- never itself a way to acquire ownership or any
 * other authority, regardless of whether the assertion happens to be
 * true.
 */
function handleClaim(
  _state: WorldState,
  _proposal: ClaimProposal,
): RuleOutcome {
  return reject(
    "unauthorized-claim",
    "a claim is an assertion, not a committable action; record it as a legend instead",
  );
}

/**
 * Commits only when the proposal names the actor's own authored gather
 * resource; an actor with no authored gather resource, or naming a
 * different one, is rejected. The committed amount is always the
 * authoritative rule's yield (`economyBalance.gatherAmount`, plus the
 * favor bonus when active) -- `proposal.amount` is never read.
 */
function handleGather(
  state: WorldState,
  proposal: GatherProposal,
): RuleOutcome {
  const actor = getActor(state, proposal.actor);
  if (!actor) {
    return reject("malformed", "actor has no known inventory");
  }
  if (actor.gathers !== proposal.resource) {
    return reject(
      "malformed",
      `actor is not authored to gather ${proposal.resource}`,
    );
  }
  const bonus = hasActiveGatherFavor(actor, state.tick)
    ? favorGatherBonusOf(state)
    : 0;
  return commit([
    {
      kind: "resource-gathered",
      entityId: proposal.actor,
      resource: proposal.resource,
      amount: gatherAmountOf(state.rules) + bonus,
    },
  ]);
}

function handleProduce(
  state: WorldState,
  proposal: ProduceProposal,
): RuleOutcome {
  const recipe = state.recipes[proposal.output];
  if (!recipe) {
    return reject("malformed", `no recipe produces ${proposal.output}`);
  }
  const actor = getActor(state, proposal.actor);
  if (!actor) {
    return reject("malformed", "actor has no known inventory");
  }
  for (const input of recipe.inputs) {
    const needed = input.amount * proposal.quantity;
    if (getResourceAmount(actor.inventory, input.resource) < needed) {
      return reject(
        "insufficient-resources",
        `actor lacks ${needed} ${input.resource} to produce ${proposal.quantity} ${proposal.output}`,
      );
    }
  }
  return commit([
    {
      kind: "resource-produced",
      entityId: proposal.actor,
      output: proposal.output,
      quantity: proposal.quantity,
    },
  ]);
}

function handleConsume(
  state: WorldState,
  proposal: ConsumeProposal,
): RuleOutcome {
  const actor = getActor(state, proposal.actor);
  if (!actor) {
    return reject("malformed", "actor has no known inventory");
  }
  if (getResourceAmount(actor.inventory, proposal.resource) < proposal.amount) {
    return reject(
      "insufficient-resources",
      `actor lacks ${proposal.amount} ${proposal.resource} to consume`,
    );
  }
  return commit([
    {
      kind: "resource-consumed",
      entityId: proposal.actor,
      resource: proposal.resource,
      amount: proposal.amount,
    },
  ]);
}

/** Sums repeated entries for the same resource into one total per resource. */
function aggregateByResource(
  items: readonly ResourceAmount[],
): ReadonlyMap<string, number> {
  const totals = new Map<string, number>();
  for (const item of items) {
    totals.set(item.resource, (totals.get(item.resource) ?? 0) + item.amount);
  }
  return totals;
}

/**
 * Pure NPC-to-NPC trade: both parties must be at the same location and
 * must actually hold the aggregate they give or receive, once repeated
 * lines for the same resource are summed. The counterparty's acceptance
 * is a deterministic rule over its own committed drives and inventory
 * (`evaluateTradeAcceptance`), evaluated fresh here -- never against a
 * proposal-declared value.
 */
function handleTrade(state: WorldState, proposal: TradeProposal): RuleOutcome {
  if (proposal.actor === proposal.counterparty) {
    return reject("malformed", "an actor cannot trade with itself");
  }
  const actor = getActor(state, proposal.actor);
  if (!actor) {
    return reject("malformed", "actor has no known inventory");
  }
  const counterparty = getActor(state, proposal.counterparty);
  if (!counterparty?.alive) {
    return reject(
      "dead-actor",
      `counterparty ${proposal.counterparty} is not a living, known actor`,
    );
  }
  if (actor.locationId !== counterparty.locationId) {
    return reject(
      "not-adjacent",
      "a trade requires both parties to be at the same location",
    );
  }
  for (const [resource, amount] of aggregateByResource(proposal.give)) {
    if (getResourceAmount(actor.inventory, resource) < amount) {
      return reject(
        "insufficient-resources",
        `actor lacks ${amount} ${resource} to give`,
      );
    }
  }
  for (const [resource, amount] of aggregateByResource(proposal.receive)) {
    if (getResourceAmount(counterparty.inventory, resource) < amount) {
      return reject(
        "insufficient-resources",
        `counterparty lacks ${amount} ${resource}`,
      );
    }
  }
  if (
    !evaluateTradeAcceptance(
      state.rules,
      counterparty.drives ?? NEUTRAL_DRIVES,
      proposal.give,
      proposal.receive,
    )
  ) {
    return reject(
      "counterparty-declined",
      "the counterparty declines this trade under its own acceptance rule",
    );
  }
  return commit([
    {
      kind: "resource-traded",
      entityId: proposal.actor,
      counterpartyId: proposal.counterparty,
      give: proposal.give,
      receive: proposal.receive,
    },
  ]);
}

function handleStrike(
  state: WorldState,
  proposal: StrikeProposal,
): RuleOutcome {
  const actor = getActor(state, proposal.actor);
  if (!actor) {
    return reject("malformed", "actor has no known inventory");
  }
  if (!actor.isDeity) {
    return reject("unauthorized-claim", "only a deity may strike");
  }
  const available = getResourceAmount(
    actor.inventory,
    DIVINE_CAPACITY_RESOURCE,
  );
  if (available < proposal.power) {
    return reject(
      "insufficient-power",
      `actor lacks ${proposal.power} divine power to strike`,
    );
  }
  const target = getBuilding(state, proposal.target);
  if (!target) {
    return reject("malformed", `unknown strike target: ${proposal.target}`);
  }
  if (
    target.status === "burning" ||
    target.status === "destroyed" ||
    target.status === "repairing"
  ) {
    return reject(
      "malformed",
      `${target.id} cannot be struck while ${target.status}`,
    );
  }
  const events: WorldEventDraft[] = [
    {
      kind: "resource-consumed",
      entityId: proposal.actor,
      resource: DIVINE_CAPACITY_RESOURCE,
      amount: proposal.power,
    },
  ];
  if (target.combustible && proposal.power >= igniteThresholdOf(state)) {
    events.push({ kind: "building-ignited", entityId: target.id });
  } else {
    events.push({
      kind: "building-damaged",
      entityId: target.id,
      amount: proposal.power,
    });
  }
  return commit(events);
}

function handleRepair(
  state: WorldState,
  proposal: RepairProposal,
): RuleOutcome {
  const actor = getActor(state, proposal.actor);
  if (!actor) {
    return reject("malformed", "actor has no known inventory");
  }
  const building = getBuilding(state, proposal.structure);
  if (!building) {
    return reject("malformed", `unknown repair target: ${proposal.structure}`);
  }
  if (
    building.status !== "damaged" &&
    building.status !== "destroyed" &&
    building.status !== "repairing"
  ) {
    return reject(
      "malformed",
      `${proposal.structure} is not in need of repair`,
    );
  }
  const amount = repairAmountPerTickOf(state);
  if (getResourceAmount(actor.inventory, REPAIR_RESOURCE) < amount) {
    return reject(
      "insufficient-resources",
      `actor lacks ${amount} ${REPAIR_RESOURCE} to repair`,
    );
  }
  const events: WorldEventDraft[] = [
    {
      kind: "repair-progressed",
      entityId: proposal.actor,
      structureId: proposal.structure,
      resource: REPAIR_RESOURCE,
      amount,
    },
  ];
  const projectedProgress = (building.repairProgress ?? 0) + amount;
  if (projectedProgress >= repairCostOf(state)) {
    events.push({ kind: "building-repaired", entityId: proposal.structure });
  }
  return commit(events);
}

function handleWorship(
  state: WorldState,
  proposal: WorshipProposal,
): RuleOutcome {
  if (proposal.actor === proposal.deity) {
    return reject("unauthorized-claim", "an actor cannot worship itself");
  }
  const actor = getActor(state, proposal.actor);
  if (!actor) {
    return reject("malformed", "actor has no known inventory");
  }
  const deity = getActor(state, proposal.deity);
  if (!deity?.isDeity) {
    return reject(
      "unauthorized-claim",
      `${proposal.deity} is not an authored deity`,
    );
  }
  if (
    proposal.offering &&
    getResourceAmount(actor.inventory, proposal.offering.resource) <
      proposal.offering.amount
  ) {
    return reject(
      "insufficient-resources",
      `actor lacks the offered ${proposal.offering.resource}`,
    );
  }
  return commit([
    {
      kind: "worship-performed",
      entityId: proposal.actor,
      deity: proposal.deity,
      ...(proposal.offering ? { offering: proposal.offering } : {}),
      favorEffect: FAVOR_EFFECT,
      favorExpiresAtTick: state.tick + favorDurationTicksOf(state),
    },
  ]);
}

/**
 * A legend commits regardless of whether its assertion is true -- it
 * records that someone told the story, never that the story is fact.
 * `legendId` is derived from the proposal's own `observationId`, so the
 * same proposal always yields the same legend id.
 */
function handleLegend(
  _state: WorldState,
  proposal: LegendProposal,
): RuleOutcome {
  const legendId = toLegendId(`legend-${proposal.observationId}`);
  return commit([
    {
      kind: "legend-recorded",
      entityId: proposal.actor,
      legendId,
      assertion: proposal.assertion,
      ...(proposal.linkedEventId
        ? { linkedEventId: proposal.linkedEventId }
        : {}),
      verified: proposal.linkedEventId !== undefined,
    },
  ]);
}

/**
 * Runs the shared pre-checks (actor alive, expected revisions) and then
 * the kind-specific handler.
 */
export function validateProposal(
  state: WorldState,
  proposal: Proposal,
): RuleOutcome {
  const actor = getActor(state, proposal.actor);
  if (!actor?.alive) {
    return reject(
      "dead-actor",
      `actor ${proposal.actor} is not a living, known actor`,
    );
  }

  for (const expected of proposal.expectedRevisions) {
    const current = getEntityRevision(state, expected.entityId);
    if (current === undefined || current !== expected.revision) {
      return reject(
        "stale-target",
        `expected ${expected.entityId} at revision ${expected.revision}, found ${String(current)}`,
      );
    }
  }

  switch (proposal.kind) {
    case "move":
      return handleMove(state, proposal);
    case "realm-transition":
      return handleRealmTransition(state, proposal);
    case "claim":
      return handleClaim(state, proposal);
    case "gather":
      return handleGather(state, proposal);
    case "produce":
      return handleProduce(state, proposal);
    case "trade":
      return handleTrade(state, proposal);
    case "consume":
      return handleConsume(state, proposal);
    case "strike":
      return handleStrike(state, proposal);
    case "repair":
      return handleRepair(state, proposal);
    case "worship":
      return handleWorship(state, proposal);
    case "legend":
      return handleLegend(state, proposal);
    default: {
      const exhaustiveCheck: never = proposal;
      return reject(
        "malformed",
        `no rule for proposal kind: ${(exhaustiveCheck as Proposal).kind}`,
      );
    }
  }
}
