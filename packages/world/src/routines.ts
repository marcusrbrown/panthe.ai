// Scripted inhabitant routines: given the last committed state and one
// living, drive-bearing actor, decide the single proposal (if any) that
// actor submits this tick, and the observation it made to justify it. Pure
// over `WorldState`; no SQLite, no telemetry, no wall clock. The service
// layer persists the returned observation (Unit 6's concern).
//
// The same decision runs whether the world is on screen or not: there is
// no separate, reduced-detail offscreen path.

import {
  createObservationId,
  type EntityId,
  type ObservationRecord,
  type Proposal,
} from "@panthea/contracts";
import { getResourceAmount, resourceValue } from "./economy";
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

/** The proposal-kind-specific fields a candidate contributes; the shared envelope fields are filled in once the winning candidate is chosen. */
type ProposalDetails = { readonly kind: Proposal["kind"] } & Record<
  string,
  unknown
>;

interface Candidate {
  readonly utility: number;
  readonly factsRead: readonly string[];
  build(): ProposalDetails;
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
      const seller = findCounterparty(
        state,
        actorId,
        actor,
        (candidate) =>
          getResourceAmount(candidate.inventory, "food") >= consumeAmount,
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
            give: [{ resource: "currency", amount: askPrice }],
            receive: [{ resource: "food", amount: consumeAmount }],
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
    const buyer = findCounterparty(
      state,
      actorId,
      actor,
      (candidate) =>
        getResourceAmount(candidate.inventory, "currency") >= askPrice,
    );
    if (buyer) {
      candidates.push({
        utility: drives.greed * 0.6 + drives.thrift * 0.4,
        factsRead: [`actor:${actorId}.inventory`, `actor:${buyer}.inventory`],
        build: () => ({
          kind: "trade",
          counterparty: buyer,
          give: [{ resource, amount: gatherAmount }],
          receive: [{ resource: "currency", amount: askPrice }],
        }),
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
      const buyer = findCounterparty(
        state,
        actorId,
        actor,
        (candidate) =>
          getResourceAmount(candidate.inventory, "currency") >= askPrice,
      );
      if (buyer) {
        candidates.push({
          utility: drives.thrift * 0.5,
          factsRead: [`actor:${actorId}.inventory`, `actor:${buyer}.inventory`],
          build: () => ({
            kind: "trade",
            counterparty: buyer,
            give: [{ resource: output.resource, amount: 1 }],
            receive: [{ resource: "currency", amount: askPrice }],
          }),
        });
      }
    }
  }

  // Buy a wanted resource this actor cannot produce or gather itself.
  if (actor.wants && getResourceAmount(actor.inventory, actor.wants) < 1) {
    const wanted = actor.wants;
    const askPrice = resourceValue(state.rules, wanted);
    if (getResourceAmount(actor.inventory, "currency") >= askPrice) {
      const seller = findCounterparty(
        state,
        actorId,
        actor,
        (candidate) => getResourceAmount(candidate.inventory, wanted) >= 1,
      );
      if (seller) {
        candidates.push({
          utility: drives.thrift * 0.3,
          factsRead: [
            `actor:${actorId}.inventory`,
            `actor:${seller}.inventory`,
          ],
          build: () => ({
            kind: "trade",
            counterparty: seller,
            give: [{ resource: "currency", amount: askPrice }],
            receive: [{ resource: wanted, amount: 1 }],
          }),
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
  const targets: readonly EntityId[] =
    "counterparty" in built ? [built.counterparty as EntityId] : [];

  return {
    observation,
    proposal: {
      schemaVersion: 1,
      actor: actorId,
      targets,
      expectedRevisions: [],
      source: "routine",
      observationId: observation.id,
      ...built,
    } as unknown as Proposal,
  };
}
