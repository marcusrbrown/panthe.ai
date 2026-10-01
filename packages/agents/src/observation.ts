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
import {
  NOTHING_REMEMBERED,
  type ParsedGodIntent,
  type Remembered,
  shownIds,
} from "./context";

/**
 * What a parsed intent becomes. Discriminated on `kind`, so a caller must
 * narrow to `"proposal"` before it can journal anything: a `wait` carries no
 * proposal and no observation, and a refusal carries neither.
 */
/** The proposal source of every model-built proposal. */
const MODEL_SOURCE: ProposalSource = "model";

export type ModelProposalResult =
  | {
      readonly ok: true;
      readonly kind: "proposal";
      readonly observation: ObservationRecord;
      readonly proposal: Proposal;
    }
  | { readonly ok: true; readonly kind: "wait" }
  | { readonly ok: false; readonly message: string };

const refuse = (message: string): ModelProposalResult => ({
  ok: false,
  message,
});

/**
 * Every fact a snapshot holds, named the way an observation's `factsRead`
 * names them. An observation may cite only these.
 */
export function snapshotFacts(
  snapshot: PerceptionSnapshot,
  remembered: Remembered = NOTHING_REMEMBERED,
): Set<string> {
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
  for (const memory of remembered.memories) facts.add(`memory:${memory.id}`);
  for (const feeling of remembered.relationships) {
    facts.add(`feeling:${feeling.toward}`);
  }
  return facts;
}

/** The fact an observation cites for a goal's target: the scene fact when it is here, or the remembered account or feeling that named it. */
function goalTargetFact(
  snapshot: PerceptionSnapshot,
  remembered: Remembered,
  target: EntityId,
): string {
  if (snapshot.actors.some((actor) => actor.id === target)) {
    return `actor:${target}.location`;
  }
  if (snapshot.buildings.some((building) => building.id === target)) {
    return `building:${target}.status`;
  }
  if (
    snapshot.location.id === target ||
    snapshot.exits.some((e) => e.to === target)
  ) {
    return `location:${target}`;
  }
  const memory = remembered.memories.find(
    (m) =>
      m.subjects.includes(target) ||
      m.consequence?.agent === target ||
      m.consequence?.target === target ||
      (m.kind === "told" && m.teller === target),
  );
  if (memory !== undefined) return `memory:${memory.id}`;
  return `feeling:${target}`;
}

/**
 * Builds the observation and proposal for `intent`, made by `actorId` from
 * `snapshot`. `intent` must come from `godIntentSchema`'s parse, which is the
 * only thing that checks the action and strike power; this builder re-checks
 * that every target is in `snapshot`, since the intent may have been parsed
 * against an older one. The service stamps the `model` source on
 * both records; neither the model nor the caller chooses it.
 */
export function buildModelProposal(
  actorId: EntityId,
  snapshot: PerceptionSnapshot,
  intent: ParsedGodIntent,
  remembered: Remembered = NOTHING_REMEMBERED,
): ModelProposalResult {
  if (snapshot.observer !== actorId) {
    return refuse(
      `the snapshot was taken by ${snapshot.observer}, not ${actorId}`,
    );
  }

  // A goal's target is checked against the ids the god was shown, the same set
  // the parser used: the scene plus what its prompt remembered.
  const goalTarget = intent.goal?.set?.target;
  if (
    goalTarget !== undefined &&
    !shownIds(snapshot, remembered).includes(goalTarget)
  ) {
    return refuse(`${goalTarget} is not an id the god was shown`);
  }

  // A wait with nothing to change claims nothing: no observation, no proposal.
  if (intent.action === "wait" && intent.goal === undefined) {
    return { ok: true, kind: "wait" };
  }

  const factsRead = [`actor:${actorId}.inventory`, `actor:${actorId}.location`];
  if (goalTarget !== undefined) {
    factsRead.push(goalTargetFact(snapshot, remembered, goalTarget));
  }
  const expectedRevisions: EntityRevision[] = [
    { entityId: actorId, revision: snapshot.self.revision },
    { entityId: snapshot.location.id, revision: snapshot.location.revision },
  ];
  const observationId = createObservationId();
  const base = {
    schemaVersion: 1,
    actor: actorId,
    expectedRevisions,
    source: MODEL_SOURCE,
    observationId,
    ...(intent.goal === undefined ? {} : { goal: intent.goal }),
  };

  let proposal: Proposal;
  switch (intent.action) {
    case "wait": {
      // A goal-only turn has no action to protect, so it pins no revisions: a
      // world that moved while the god thought must not refuse its declaration.
      if (intent.goal === undefined) return refuse("a wait carries no goal");
      proposal = {
        ...base,
        expectedRevisions: [],
        targets: [],
        kind: "goal",
        goal: intent.goal,
      };
      break;
    }
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
    case "report": {
      const listener = snapshot.actors.find(
        (actor) => actor.id === intent.listener,
      );
      if (!listener) {
        return refuse(`${intent.listener} is not an actor in the snapshot`);
      }
      factsRead.push(`actor:${listener.id}.location`);
      expectedRevisions.push({
        entityId: listener.id,
        revision: listener.revision,
      });
      proposal = {
        ...base,
        targets: [listener.id],
        kind: "report",
        listener: listener.id,
        content: intent.content,
        ...(intent.claim === undefined ? {} : { claim: intent.claim }),
        ...(intent.linkedEventId === undefined
          ? {}
          : { linkedEventId: intent.linkedEventId }),
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
        ...(intent.claim === undefined ? {} : { claim: intent.claim }),
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
    source: MODEL_SOURCE,
  };
  return { ok: true, kind: "proposal", observation, proposal };
}
