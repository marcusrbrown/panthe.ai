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
    default:
      return reject("malformed", `no rule for proposal kind: ${proposal.kind}`);
  }
}
