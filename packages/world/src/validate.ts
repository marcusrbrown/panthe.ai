// Execution-time proposal validation: pure functions over a `WorldState`
// view and a `Proposal`, returning either the draft events a commit would
// append or a typed rejection from packages/contracts' shared
// `RejectionReasonCode` vocabulary. Nothing here mutates `WorldState`;
// packages/world/src/actions.ts applies the returned drafts through the
// event-reducer registry after a rule handler approves them.
//
// Shared, kind-agnostic checks (actor exists and is alive, every
// `expectedRevisions` entry still matches) run once in `validateProposal`
// before dispatching to a kind-specific handler, so every proposal kind
// gets them for free and a kind's handler only encodes what is unique to
// it. The registry is an explicit, constructible value (not a module-level
// singleton) so persistence (Unit 2) and tests can each hold an independent
// instance -- "world owns ... a registry persistence can inject."

import type {
  ClaimProposal,
  EntityId,
  MoveProposal,
  Proposal,
  RealmTransitionProposal,
  RejectionReasonCode,
} from "@panthea/contracts";
import { crossesRealm, findEdge, isAdjacent } from "./geography";
import {
  getActor,
  getEntityRevision,
  getLocation,
  type WorldEventDraft,
  type WorldState,
} from "./state";

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

export type RuleHandler<P extends Proposal = Proposal> = (
  state: WorldState,
  proposal: P,
) => RuleOutcome;

export interface RuleRegistry {
  register<K extends Proposal["kind"]>(
    kind: K,
    handler: RuleHandler<Extract<Proposal, { kind: K }>>,
  ): void;
  get(kind: Proposal["kind"]): RuleHandler | undefined;
  /**
   * Runs the shared pre-checks (actor alive, expected revisions) and then
   * the kind-specific handler. This is the single entry point
   * packages/world/src/actions.ts calls per queued proposal.
   */
  validateProposal(state: WorldState, proposal: Proposal): RuleOutcome;
}

export function createRuleRegistry(): RuleRegistry {
  const handlers = new Map<Proposal["kind"], RuleHandler>();

  return {
    register(kind, handler) {
      handlers.set(kind, handler as RuleHandler);
    },
    get(kind) {
      return handlers.get(kind);
    },
    validateProposal(state, proposal) {
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

      const handler = handlers.get(proposal.kind);
      if (!handler) {
        return reject(
          "malformed",
          `no rule handler registered for proposal kind: ${proposal.kind}`,
        );
      }
      return handler(state, proposal);
    },
  };
}

// --- Built-in handlers: move, realm-transition, claim -----------------------

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

const handleMove: RuleHandler<MoveProposal> = (state, proposal) => {
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
};

const handleRealmTransition: RuleHandler<RealmTransitionProposal> = (
  state,
  proposal,
) => {
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
};

/**
 * Claims never commit world state (Key Technical Decisions: "Claims never
 * mutate state"). A claim is an assertion for Unit 5's worship/legend
 * system to record as a rumor, optionally later linked to a verified event
 * -- it is never itself a way to acquire ownership or any other authority,
 * regardless of whether the assertion happens to be true.
 */
const handleClaim: RuleHandler<ClaimProposal> = (_state, _proposal) =>
  reject(
    "unauthorized-claim",
    "a claim is an assertion, not a committable action; record it as a legend instead",
  );

/**
 * Builds a registry with Unit 3's handlers (move, realm-transition, claim)
 * already registered. Later units register their own kinds (gather,
 * trade, strike, ...) on the same registry instance rather than a
 * hand-maintained switch, so adding a proposal kind never requires editing
 * this file.
 */
export function createDefaultRuleRegistry(): RuleRegistry {
  const registry = createRuleRegistry();
  registry.register("move", handleMove);
  registry.register("realm-transition", handleRealmTransition);
  registry.register("claim", handleClaim);
  return registry;
}
