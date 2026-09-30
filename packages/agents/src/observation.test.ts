import { expect, test } from "bun:test";
import {
  createPrng,
  getActor,
  getBuilding,
  getLocation,
  type PerceptionSnapshot,
  perceive,
  runTick,
  submitProposal,
  toEntityId,
  type WorldState,
  withBuilding,
} from "@panthea/world";
import { godIntentSchema, type ParsedGodIntent } from "./context";
import {
  buildModelProposal,
  type ModelProposalResult,
  snapshotFacts,
} from "./observation";
import {
  actorAt,
  committedEvent,
  godProfile,
  greekState,
} from "./test-fixtures";

const id = toEntityId;

function snapshotAt(state: WorldState, actor = "zeus"): PerceptionSnapshot {
  const snapshot = perceive(state, id(actor));
  if (!snapshot) throw new Error(`${actor} perceives nothing`);
  return snapshot;
}

/** Zeus on the mountain path; the authored pack gives him `divine`, so olympus-gate is open to him. */
const zeusAtMountain = () => actorAt(greekState(), "zeus", "mountain-path");

/** Zeus at the tavern, where the-tavern stands. */
const tavernState = () => actorAt(greekState(), "zeus", "tavern");

/** What a model would answer, parsed the only way an intent can be: through the god's schema against the snapshot. */
function parsed(
  snapshot: PerceptionSnapshot,
  raw: Record<string, unknown>,
  god = "zeus",
): ParsedGodIntent {
  const result = godIntentSchema(godProfile(god), snapshot).parse(raw);
  if (!result.ok) throw new Error(`${result.path}: ${result.message}`);
  return result.value;
}

function build(
  snapshot: PerceptionSnapshot,
  raw: Record<string, unknown>,
  actor = "zeus",
) {
  const result = buildModelProposal(
    id(actor),
    snapshot,
    parsed(snapshot, raw, actor),
  );
  if (!result.ok || result.kind !== "proposal") {
    throw new Error(`expected a proposal, got ${JSON.stringify(result)}`);
  }
  return result;
}

const strikeTavern = { action: "strike", target: "the-tavern", power: 3 };

const revisionsOf = (proposal: {
  expectedRevisions: readonly { entityId: string; revision: number }[];
}) =>
  proposal.expectedRevisions.map((r) => `${r.entityId}@${r.revision}`).sort();

// --- What the service sets -------------------------------------------------------

test("a strike proposal is built by the service: actor, source, observation id, targets, and revisions", () => {
  const snapshot = snapshotAt(tavernState());
  const { observation, proposal } = build(snapshot, strikeTavern);

  expect(proposal).toMatchObject({
    schemaVersion: 1,
    kind: "strike",
    actor: "zeus",
    target: "the-tavern",
    power: 3,
    targets: ["the-tavern"],
    source: "model",
    observationId: observation.id,
  });
  expect(observation).toMatchObject({
    schemaVersion: 1,
    observer: "zeus",
    stateRevision: snapshot.stateRevision,
    source: "model",
  });
  expect(revisionsOf(proposal)).toEqual(["tavern@0", "the-tavern@0", "zeus@0"]);
  // The wire parser accepts what the builder produced.
  expect(submitProposal(proposal).ok).toBe(true);
});

test('the service stamps source "model" on both the proposal and its observation; the caller cannot choose it', () => {
  const snapshot = snapshotAt(tavernState());
  const { observation, proposal } = build(snapshot, strikeTavern);
  expect(proposal.source).toBe("model");
  expect(observation.source).toBe("model");
  expect(buildModelProposal.length).toBe(3);
});

test("a move and a legend name only the actor and its location; a realm transition takes its via from the location", () => {
  const snapshot = snapshotAt(tavernState());
  const move = build(snapshot, { action: "move", to: "town-square" });
  expect(move.proposal).toMatchObject({
    kind: "move",
    to: "town-square",
    targets: [],
  });
  expect(revisionsOf(move.proposal)).toEqual(["tavern@0", "zeus@0"]);

  const legend = build(snapshot, { action: "legend", assertion: "Hear me." });
  expect(legend.proposal).toMatchObject({
    kind: "legend",
    assertion: "Hear me.",
  });
  expect(revisionsOf(legend.proposal)).toEqual(["tavern@0", "zeus@0"]);

  const atMountain = snapshotAt(zeusAtMountain());
  const transition = build(atMountain, {
    action: "realm-transition",
    to: "olympus-gate",
  });
  expect(transition.proposal).toMatchObject({
    kind: "realm-transition",
    to: "olympus-gate",
    via: "mountain-path",
  });
});

test("factsRead is a subset of what the snapshot holds and names what the intent used", () => {
  const event = committedEvent({
    kind: "building-ignited",
    entityId: "the-tavern",
  });
  const state = tavernState();
  const snapshot = perceive(state, id("zeus"), [event]) as PerceptionSnapshot;
  const held = snapshotFacts(snapshot);

  const strike = build(snapshot, strikeTavern).observation;
  expect(strike.factsRead).toContain("building:the-tavern.status");
  expect(strike.factsRead).toContain("actor:zeus.inventory");
  const linked = build(snapshot, {
    action: "legend",
    assertion: "It burned.",
    linkedEventId: event.id,
  }).observation;
  expect(linked.factsRead).toContain(`event:${event.id}`);

  for (const observation of [strike, linked]) {
    expect(observation.factsRead.length).toBeGreaterThan(0);
    for (const fact of observation.factsRead) expect(held.has(fact)).toBe(true);
  }
  // Facts the intent did not use are not claimed.
  expect(strike.factsRead).not.toContain(`event:${event.id}`);
  // Nothing outside the snapshot is ever a fact read.
  expect(held.has("building:old-oak.status")).toBe(false);
});

test("each proposal gets a fresh observation id", () => {
  const snapshot = snapshotAt(tavernState());
  const first = build(snapshot, strikeTavern).observation.id;
  const second = build(snapshot, strikeTavern).observation.id;
  expect(first).not.toBe(second);
});

// --- Refusal before journaling ------------------------------------------------------

test("an intent parsed against another snapshot is refused when its target is not in this one", () => {
  // Parsed where the oak and the great hall are in reach, built against the tavern.
  const elsewhere = snapshotAt(actorAt(greekState(), "zeus", "town-square"));
  const tavern = snapshotAt(tavernState());
  const stale: Record<string, unknown>[] = [
    { action: "strike", target: "old-oak", power: 1 },
    { action: "move", to: "shop" },
  ];
  for (const raw of stale) {
    const result = buildModelProposal(
      id("zeus"),
      tavern,
      parsed(elsewhere, raw),
    );
    expect(result.ok).toBe(false);
  }

  const mountain = snapshotAt(zeusAtMountain());
  const transition = buildModelProposal(
    id("zeus"),
    tavern,
    parsed(mountain, { action: "realm-transition", to: "olympus-gate" }),
  );
  expect(transition.ok).toBe(false);

  const event = committedEvent({
    kind: "building-ignited",
    entityId: "the-tavern",
  });
  const withEvent = perceive(tavernState(), id("zeus"), [event]);
  if (!withEvent) throw new Error("no snapshot");
  const linked = buildModelProposal(
    id("zeus"),
    tavern,
    parsed(withEvent, {
      action: "legend",
      assertion: "x",
      linkedEventId: event.id,
    }),
  );
  expect(linked.ok).toBe(false);
});

test("a snapshot taken by another actor cannot back the proposal", () => {
  const snapshot = snapshotAt(tavernState());
  const result = buildModelProposal(
    id("hera"),
    snapshot,
    parsed(snapshot, strikeTavern),
  );
  expect(result.ok).toBe(false);
});

// --- wait -------------------------------------------------------------------------

test("a wait builds no proposal and no observation, so nothing can be journaled", () => {
  const snapshot = snapshotAt(tavernState());
  const result = buildModelProposal(
    id("zeus"),
    snapshot,
    parsed(snapshot, { action: "wait" }),
  );
  expect(result).toEqual({ ok: true, kind: "wait" });
  expect("proposal" in result).toBe(false);
  expect("observation" in result).toBe(false);
});

test("a wait from another actor's snapshot is still refused", () => {
  const snapshot = snapshotAt(tavernState());
  const result = buildModelProposal(
    id("hera"),
    snapshot,
    parsed(snapshot, { action: "wait" }),
  );
  expect(result.ok).toBe(false);
});

test("the result is a discriminated union: a wait cannot be read as a proposal", () => {
  const snapshot = snapshotAt(tavernState());
  const result: ModelProposalResult = buildModelProposal(
    id("zeus"),
    snapshot,
    parsed(snapshot, { action: "wait" }),
  );
  const readsProposalWithoutNarrowing = () => {
    if (result.ok) {
      // @ts-expect-error `ok` alone does not narrow: a wait carries no proposal
      return result.proposal;
    }
    return undefined;
  };
  expect(typeof readsProposalWithoutNarrowing).toBe("function");
  if (result.ok && result.kind === "proposal") {
    expect(result.proposal.kind).toBeDefined();
  }
});

// --- Branded intents ----------------------------------------------------------------

test("a hand-built intent cannot be passed to buildModelProposal", () => {
  const snapshot = snapshotAt(tavernState());
  const handBuilt = () =>
    buildModelProposal(
      id("zeus"),
      snapshot,
      // @ts-expect-error a hand-built intent skipped godIntentSchema's parse, and with it the power and availability checks
      { action: "strike", target: id("the-tavern"), power: 999 },
    );
  expect(typeof handBuilt).toBe("function");
});

// --- Against the real validator --------------------------------------------------

function runProposal(
  state: WorldState,
  proposal: Parameters<typeof runTick>[2][number],
) {
  return runTick(state, createPrng(1), [proposal]);
}

test("unchanged since the snapshot, the proposal commits; positive control for the stale cases", () => {
  const state = tavernState();
  const { proposal } = build(snapshotAt(state), strikeTavern);

  const tick = runProposal(state, proposal);
  expect(tick.rejected).toEqual([]);
  expect(tick.committed).toHaveLength(1);
  expect(tick.events.map((event) => event.kind)).toContain("building-ignited");
});

test("the target changed after the snapshot: the proposal is rejected stale-target", () => {
  const state = tavernState();
  const { proposal } = build(snapshotAt(state), strikeTavern);

  // Hera damages the tavern first, through the real tick.
  const heraStrike = build(
    snapshotAt(actorAt(state, "hera", "tavern"), "hera"),
    { action: "strike", target: "the-tavern", power: 1 },
    "hera",
  ).proposal;
  const afterHera = runProposal(actorAt(state, "hera", "tavern"), heraStrike);
  expect(afterHera.committed).toHaveLength(1);
  const damaged = getBuilding(afterHera.state, id("the-tavern"));
  expect(damaged?.revision).toBeGreaterThan(0);

  const late = runProposal(afterHera.state, proposal);
  expect(late.committed).toEqual([]);
  expect(late.rejected).toHaveLength(1);
  expect(late.rejected[0]?.reason).toBe("stale-target");
  expect(late.rejected[0]?.message).toContain("the-tavern");
});

test("the location's occupancy changed after the snapshot: the proposal is rejected stale-target", () => {
  const state = tavernState();
  const { proposal } = build(snapshotAt(state), {
    action: "legend",
    assertion: "Hear me.",
  });

  // The farmer walks into the tavern, through the real tick.
  const farmerAtSquare = actorAt(state, "farmer", "town-square");
  const walk = submitProposal({
    schemaVersion: 1,
    kind: "move",
    actor: "farmer",
    to: "tavern",
    targets: [],
    expectedRevisions: [],
    source: "fixture",
    observationId: "obs-walk",
  });
  if (!walk.ok) throw new Error(walk.rejection.message);
  const moved = runProposal(farmerAtSquare, walk.proposal);
  expect(moved.committed).toHaveLength(1);
  expect(getLocation(moved.state, id("tavern"))?.revision).toBeGreaterThan(0);

  const late = runProposal(moved.state, proposal);
  expect(late.rejected[0]?.reason).toBe("stale-target");
});

test("Zeus's own goods changed after the snapshot: the proposal is rejected stale-target", () => {
  const state = tavernState();
  const { proposal } = build(snapshotAt(state), strikeTavern);
  const zeus = getActor(state, id("zeus"));
  if (!zeus) throw new Error("no zeus");
  const spent = {
    ...state,
    actors: new Map(state.actors).set(id("zeus"), {
      ...zeus,
      revision: zeus.revision + 1,
    }),
  };
  expect(runProposal(spent, proposal).rejected[0]?.reason).toBe("stale-target");
});

test("a building's revision bump alone makes the proposal stale", () => {
  const state = tavernState();
  const { proposal } = build(snapshotAt(state), strikeTavern);
  const tavern = getBuilding(state, id("the-tavern"));
  if (!tavern) throw new Error("no tavern building");
  const bumped = withBuilding(state, {
    ...tavern,
    revision: tavern.revision + 1,
  });
  expect(runProposal(bumped, proposal).rejected[0]?.reason).toBe(
    "stale-target",
  );
});

test("a mortal is still refused restricted-realm for the same transition; positive control for the deity's commit below", () => {
  const state = actorAt(greekState(), "farmer", "mountain-path");
  const attempt = submitProposal({
    schemaVersion: 1,
    kind: "realm-transition",
    actor: "farmer",
    to: "olympus-gate",
    via: "mountain-path",
    targets: [],
    expectedRevisions: [],
    source: "fixture",
    observationId: "obs-mortal",
  });
  if (!attempt.ok) throw new Error(attempt.rejection.message);
  const tick = runProposal(state, attempt.proposal);
  expect(tick.committed).toEqual([]);
  expect(tick.rejected[0]?.reason).toBe("restricted-realm");
});

test("a model-built realm transition commits through the real tick from the authored pack alone; positive control for moving between realms", () => {
  const state = zeusAtMountain();
  const { proposal } = build(snapshotAt(state), {
    action: "realm-transition",
    to: "olympus-gate",
  });
  expect(proposal).toMatchObject({
    kind: "realm-transition",
    via: "mountain-path",
  });

  const tick = runProposal(state, proposal);
  expect(tick.rejected).toEqual([]);
  expect(tick.committed).toHaveLength(1);
  expect(tick.events.map((event) => event.kind)).toContain(
    "realm-transitioned",
  );
  expect(getActor(tick.state, id("zeus"))?.locationId).toBe(id("olympus-gate"));
});
