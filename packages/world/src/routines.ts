// Scripted inhabitant routines: given the last committed state and one
// living, drive-bearing actor, decide the single proposal (if any) that
// actor submits this tick, and the observation it made to justify it. Pure
// over `WorldState`; no SQLite, no telemetry, no wall clock. The caller
// persists the returned observation.
//
// The same decision runs whether the world is on screen or not: there is
// no separate, reduced-detail offscreen path.

import {
  createObservationId,
  type EntityId,
  type ObservationRecord,
  type Proposal,
  type ProposalBase,
} from "@panthea/contracts";
import {
  evaluateTradeAcceptance,
  getResourceAmount,
  NEUTRAL_DRIVES,
  resourceValue,
} from "./economy";
import { actorHoldsEnoughToRepair, findRepairableBuilding } from "./repair";
import { type ActorState, getActor, type WorldState } from "./state";

export interface RoutineResult {
  readonly observation: ObservationRecord;
  readonly proposal: Proposal;
}

function gatherAmountOf(state: WorldState): number {
  return state.rules.economyBalance.gatherAmount ?? 1;
}

function consumeAmountOf(state: WorldState): number {
  return state.rules.economyBalance.consumeAmount ?? 1;
}

/** The first other living actor at `actorId`'s location satisfying `predicate`, in `state.actors`' deterministic iteration order. */
function findCounterparty(
  state: WorldState,
  actorId: EntityId,
  actor: ActorState,
  predicate: (candidate: ActorState) => boolean,
): EntityId | undefined {
  for (const [candidateId, candidate] of state.actors) {
    if (candidateId === actorId) continue;
    if (!candidate.alive) continue;
    if (candidate.locationId !== actor.locationId) continue;
    if (predicate(candidate)) return candidateId;
  }
  return undefined;
}

function firstSatisfiedRecipe(
  state: WorldState,
  actor: ActorState,
): string | undefined {
  for (const [output, recipe] of Object.entries(state.recipes)) {
    const satisfied = recipe.inputs.every(
      (input) =>
        getResourceAmount(actor.inventory, input.resource) >= input.amount,
    );
    if (satisfied) return output;
  }
  return undefined;
}

/** `Omit<T, K>`, applied separately to each member of a union `T`. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never;

/** The proposal-kind-specific fields a candidate contributes; the shared envelope fields are filled in once the winning candidate is chosen. */
type ProposalDetails = DistributiveOmit<Proposal, keyof ProposalBase>;

interface Candidate {
  readonly utility: number;
  readonly factsRead: readonly string[];
  build(): ProposalDetails;
}

/** The entities a candidate's proposal targets, for `Proposal.targets`. */
function deriveTargets(built: ProposalDetails): readonly EntityId[] {
  switch (built.kind) {
    case "trade":
      return [built.counterparty];
    case "repair":
      return [built.structure];
    default:
      return [];
  }
}

/**
 * Decides the one proposal `actorId` submits this tick, or `undefined` if
 * it is dead, unknown, or not routine-driven (has no authored drives).
 * Candidates are ranked by a drive-weighted utility and the highest
 * *eligible* one wins; ties keep whichever candidate is listed first below.
 */
export function decideRoutineProposal(
  state: WorldState,
  actorId: EntityId,
): RoutineResult | undefined {
  const actor = getActor(state, actorId);
  if (!actor?.alive || !actor.drives) return undefined;

  const drives = actor.drives;
  const gatherAmount = gatherAmountOf(state);
  const consumeAmount = consumeAmountOf(state);
  const candidates: Candidate[] = [];

  const heldFood = getResourceAmount(actor.inventory, "food");
  if (heldFood >= consumeAmount) {
    candidates.push({
      utility: drives.appetite,
      factsRead: [`actor:${actorId}.inventory`],
      build: () => ({
        kind: "consume",
        resource: "food",
        amount: consumeAmount,
      }),
    });
  }

  if (heldFood < consumeAmount) {
    const askPrice = consumeAmount * resourceValue(state.rules, "food");
    const heldCurrency = getResourceAmount(actor.inventory, "currency");
    if (heldCurrency >= askPrice) {
      const give = [{ resource: "currency", amount: askPrice }];
      const receive = [{ resource: "food", amount: consumeAmount }];
      const seller = findCounterparty(
        state,
        actorId,
        actor,
        (candidate) =>
          getResourceAmount(candidate.inventory, "food") >= consumeAmount &&
          evaluateTradeAcceptance(
            state.rules,
            candidate.drives ?? NEUTRAL_DRIVES,
            give,
            receive,
          ),
      );
      if (seller) {
        candidates.push({
          utility: drives.appetite,
          factsRead: [
            `actor:${actorId}.inventory`,
            `actor:${seller}.inventory`,
          ],
          build: () => ({
            kind: "trade",
            counterparty: seller,
            give,
            receive,
          }),
        });
      }
    }
  }

  if (
    actor.gathers &&
    getResourceAmount(actor.inventory, actor.gathers) >= gatherAmount
  ) {
    const resource = actor.gathers;
    const askPrice = gatherAmount * resourceValue(state.rules, resource);
    const give = [{ resource, amount: gatherAmount }];
    const receive = [{ resource: "currency", amount: askPrice }];
    const buyer = findCounterparty(
      state,
      actorId,
      actor,
      (candidate) =>
        getResourceAmount(candidate.inventory, "currency") >= askPrice &&
        evaluateTradeAcceptance(
          state.rules,
          candidate.drives ?? NEUTRAL_DRIVES,
          give,
          receive,
        ),
    );
    if (buyer) {
      candidates.push({
        utility: drives.greed * 0.6 + drives.thrift * 0.4,
        factsRead: [`actor:${actorId}.inventory`, `actor:${buyer}.inventory`],
        build: () => ({ kind: "trade", counterparty: buyer, give, receive }),
      });
    }
  }

  // Sell surplus of a recipe's output (currently the only produced good is
  // planks): symmetric to selling a gathered surplus, but keyed by what a
  // recipe actually put in this actor's hands rather than what it gathers.
  for (const recipe of Object.values(state.recipes)) {
    for (const output of recipe.outputs) {
      const held = getResourceAmount(actor.inventory, output.resource);
      if (held < 1) continue;
      const askPrice = resourceValue(state.rules, output.resource);
      const give = [{ resource: output.resource, amount: 1 }];
      const receive = [{ resource: "currency", amount: askPrice }];
      const buyer = findCounterparty(
        state,
        actorId,
        actor,
        (candidate) =>
          getResourceAmount(candidate.inventory, "currency") >= askPrice &&
          evaluateTradeAcceptance(
            state.rules,
            candidate.drives ?? NEUTRAL_DRIVES,
            give,
            receive,
          ),
      );
      if (buyer) {
        candidates.push({
          utility: drives.thrift * 0.5,
          factsRead: [`actor:${actorId}.inventory`, `actor:${buyer}.inventory`],
          build: () => ({ kind: "trade", counterparty: buyer, give, receive }),
        });
      }
    }
  }

  // Buy a wanted resource this actor cannot produce or gather itself.
  if (actor.wants && getResourceAmount(actor.inventory, actor.wants) < 1) {
    const wanted = actor.wants;
    const askPrice = resourceValue(state.rules, wanted);
    if (getResourceAmount(actor.inventory, "currency") >= askPrice) {
      const give = [{ resource: "currency", amount: askPrice }];
      const receive = [{ resource: wanted, amount: 1 }];
      const seller = findCounterparty(
        state,
        actorId,
        actor,
        (candidate) =>
          getResourceAmount(candidate.inventory, wanted) >= 1 &&
          evaluateTradeAcceptance(
            state.rules,
            candidate.drives ?? NEUTRAL_DRIVES,
            give,
            receive,
          ),
      );
      if (seller) {
        candidates.push({
          utility: drives.thrift * 0.3,
          factsRead: [
            `actor:${actorId}.inventory`,
            `actor:${seller}.inventory`,
          ],
          build: () => ({ kind: "trade", counterparty: seller, give, receive }),
        });
      }
    }
  }

  const recipeOutput = firstSatisfiedRecipe(state, actor);
  if (recipeOutput) {
    candidates.push({
      utility: drives.thrift,
      factsRead: [`actor:${actorId}.inventory`, `recipe:${recipeOutput}`],
      build: () => ({ kind: "produce", output: recipeOutput, quantity: 1 }),
    });
  }

  // Repair a destroyed or mid-repair building this actor owns, once it
  // holds enough materials -- urgent enough to outrank any ordinary trade
  // or production choice below.
  const repairable = findRepairableBuilding(state, actorId);
  if (repairable && actorHoldsEnoughToRepair(state, actorId)) {
    const structureId = repairable.id;
    candidates.push({
      utility: 1 + drives.thrift,
      factsRead: [
        `actor:${actorId}.inventory`,
        `building:${structureId}.status`,
      ],
      build: () => ({ kind: "repair", structure: structureId }),
    });
  }

  if (actor.gathers) {
    const resource = actor.gathers;
    candidates.push({
      utility: 0.1,
      factsRead: [`actor:${actorId}.inventory`],
      build: () => ({ kind: "gather", resource, amount: gatherAmount }),
    });
  }

  if (candidates.length === 0) return undefined;

  const chosen = candidates.reduce((best, candidate) =>
    candidate.utility > best.utility ? candidate : best,
  );

  const observation: ObservationRecord = {
    schemaVersion: 1,
    id: createObservationId(),
    observer: actorId,
    stateRevision: state.lastSequence,
    factsRead: chosen.factsRead,
    source: "routine",
  };

  const built = chosen.build();
  const proposal: Proposal = {
    schemaVersion: 1,
    actor: actorId,
    targets: deriveTargets(built),
    expectedRevisions: [],
    source: "routine",
    observationId: observation.id,
    ...built,
  };

  return { observation, proposal };
}
