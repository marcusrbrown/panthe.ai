// The trusted observation builder: the service, not the model, decides what a
// model-made proposal claims about the world. The model supplies an intent;
// this module sets the actor, a fresh observation id, `factsRead` (a subset of
// what the actor's snapshot holds), `stateRevision`, and `expectedRevisions`
// for every entity the intent touches. A world that moved between the
// snapshot and the tick therefore rejects the proposal as `stale-target`.
//
// It refuses an intent whose target is not in the snapshot before anything is
// journaled, so a hallucinated target never becomes a stored proposal.

import {
  createObservationId,
  type EntityId,
  type EntityRevision,
  type ObservationRecord,
  type Proposal,
  type ProposalSource,
} from "@panthea/contracts";
import type { PerceptionSnapshot } from "@panthea/world";
import type { GodIntent } from "./context";

export type ModelProposalResult =
  | {
      readonly ok: true;
      readonly observation: ObservationRecord;
      readonly proposal: Proposal;
    }
  | { readonly ok: false; readonly message: string };

const refuse = (message: string): ModelProposalResult => ({
  ok: false,
  message,
});

/**
 * Every fact a snapshot holds, named the way an observation's `factsRead`
 * names them. An observation may cite only these.
 */
export function snapshotFacts(snapshot: PerceptionSnapshot): Set<string> {
  const facts = new Set<string>([
    `actor:${snapshot.self.id}.inventory`,
    `actor:${snapshot.self.id}.location`,
    `location:${snapshot.location.id}`,
  ]);
  for (const exit of snapshot.exits) facts.add(`location:${exit.to}`);
  for (const actor of snapshot.actors) facts.add(`actor:${actor.id}.location`);
  for (const building of snapshot.buildings) {
    facts.add(`building:${building.id}.status`);
  }
  for (const event of snapshot.events) facts.add(`event:${event.id}`);
  return facts;
}

/**
 * Builds the observation and proposal for `intent`, made by `actorId` from
 * `snapshot`. `source` is the proposal source the service stamps; the model
 * never supplies it.
 */
export function buildModelProposal(
  actorId: EntityId,
  snapshot: PerceptionSnapshot,
  intent: GodIntent,
  source: ProposalSource,
): ModelProposalResult {
  if (snapshot.observer !== actorId) {
    return refuse(
      `the snapshot was taken by ${snapshot.observer}, not ${actorId}`,
    );
  }

  const factsRead = [`actor:${actorId}.inventory`, `actor:${actorId}.location`];
  const expectedRevisions: EntityRevision[] = [
    { entityId: actorId, revision: snapshot.self.revision },
    { entityId: snapshot.location.id, revision: snapshot.location.revision },
  ];
  const observationId = createObservationId();
  const base = {
    schemaVersion: 1,
    actor: actorId,
    expectedRevisions,
    source,
    observationId,
  };

  let proposal: Proposal;
  switch (intent.action) {
    case "move": {
      if (!snapshot.exits.some((exit) => exit.to === intent.to)) {
        return refuse(`${intent.to} is not an exit in the snapshot`);
      }
      factsRead.push(`location:${intent.to}`);
      proposal = { ...base, targets: [], kind: "move", to: intent.to };
      break;
    }
    case "realm-transition": {
      if (!snapshot.exits.some((exit) => exit.to === intent.to)) {
        return refuse(`${intent.to} is not an exit in the snapshot`);
      }
      factsRead.push(`location:${intent.to}`);
      proposal = {
        ...base,
        targets: [],
        kind: "realm-transition",
        to: intent.to,
        via: snapshot.location.id,
      };
      break;
    }
    case "strike": {
      const target = snapshot.buildings.find(
        (building) => building.id === intent.target,
      );
      if (!target) {
        return refuse(`${intent.target} is not a building in the snapshot`);
      }
      factsRead.push(`building:${target.id}.status`);
      expectedRevisions.push({
        entityId: target.id,
        revision: target.revision,
      });
      proposal = {
        ...base,
        targets: [target.id],
        kind: "strike",
        target: target.id,
        power: intent.power,
      };
      break;
    }
    case "legend": {
      if (
        intent.linkedEventId !== undefined &&
        !snapshot.events.some((event) => event.id === intent.linkedEventId)
      ) {
        return refuse(
          `${intent.linkedEventId} is not an event in the snapshot`,
        );
      }
      if (intent.linkedEventId !== undefined) {
        factsRead.push(`event:${intent.linkedEventId}`);
      }
      proposal = {
        ...base,
        targets: [],
        kind: "legend",
        assertion: intent.assertion,
        ...(intent.linkedEventId === undefined
          ? {}
          : { linkedEventId: intent.linkedEventId }),
      };
      break;
    }
  }

  const observation: ObservationRecord = {
    schemaVersion: 1,
    id: observationId,
    observer: actorId,
    stateRevision: snapshot.stateRevision,
    factsRead,
    source,
  };
  return { ok: true, observation, proposal };
}
