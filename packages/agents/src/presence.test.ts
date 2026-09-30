// Presence, end to end: events come from real ticks, and a god sees an event
// only if it stood there when it happened. Checked in the snapshot, the
// prompt, and the linkedEventId enum, since all three are built from it.

import { expect, test } from "bun:test";
import type { WorldEvent } from "@panthea/contracts";
import {
  createPrng,
  perceive,
  runTick,
  submitProposal,
  toEntityId,
  type WorldState,
} from "@panthea/world";
import { buildGodContext, godIntentSchema } from "./context";
import { actorAt, godProfile, greekState } from "./test-fixtures";

const id = toEntityId;
const zeus = godProfile("zeus");

/** One real tick of `proposals`, returning the new state and the events it committed. */
function tick(
  state: WorldState,
  proposals: readonly Record<string, unknown>[],
): { state: WorldState; events: readonly WorldEvent[] } {
  const queue = proposals.map((raw, index) => {
    const submitted = submitProposal({
      schemaVersion: 1,
      targets: [],
      expectedRevisions: [],
      source: "fixture",
      observationId: `obs-${state.tick}-${index}`,
      ...raw,
    });
    if (!submitted.ok) throw new Error(submitted.rejection.message);
    return submitted.proposal;
  });
  const result = runTick(state, createPrng(1), queue);
  if (result.rejected.length > 0) {
    throw new Error(`rejected: ${JSON.stringify(result.rejected[0])}`);
  }
  return { state: result.state, events: result.events };
}

const gather = { kind: "gather", actor: "farmer", resource: "food", amount: 1 };
const walkIn = { kind: "move", actor: "zeus", to: "tavern" };

/** The farmer is at the tavern gathering while Zeus stands in the square. */
function farmerGathersWithZeusOutside() {
  const start = actorAt(
    actorAt(greekState(), "farmer", "tavern"),
    "zeus",
    "town-square",
  );
  const first = tick(start, [gather]);
  const gathered = first.events.find((e) => e.kind === "resource-gathered");
  if (!gathered) throw new Error("the farmer did not gather");
  return { first, gathered };
}

function surfaces(state: WorldState, window: readonly WorldEvent[]) {
  const snapshot = perceive(state, id("zeus"), window);
  if (!snapshot) throw new Error("zeus perceives nothing");
  const context = buildGodContext(zeus, snapshot);
  const schema = godIntentSchema(zeus, snapshot);
  const linked = (
    schema.jsonSchema as {
      properties: Record<string, { enum?: string[] }>;
    }
  ).properties.linkedEventId?.enum;
  return {
    snapshot,
    text: `${context.instructions}\n${context.prompt}`,
    linked,
    schema,
  };
}

test("a private event in the tavern, then Zeus arrives: absent from the snapshot, the prompt, and the linkedEventId enum", () => {
  const { first, gathered } = farmerGathersWithZeusOutside();
  const second = tick(first.state, [walkIn]);
  const window = [...first.events, ...second.events];

  const seen = surfaces(second.state, window);
  expect(seen.snapshot.location.id).toBe(id("tavern"));
  expect(seen.snapshot.events.map((e) => e.id)).not.toContain(gathered.id);
  expect(seen.text).not.toContain(gathered.id);
  expect(seen.text).not.toContain("resource-gathered");
  expect(seen.linked ?? []).not.toContain(gathered.id);
  expect(
    seen.schema.parse({
      action: "legend",
      assertion: "I saw the farmer gather.",
      linkedEventId: gathered.id,
    }).ok,
  ).toBe(false);

  // His own arrival is witnessed, and he can cite it.
  const arrival = second.events.find((e) => e.kind === "entity-moved");
  expect(arrival).toBeDefined();
  expect(seen.snapshot.events.map((e) => e.id)).toContain(arrival?.id as never);
  expect(seen.linked).toContain(arrival?.id);
});

test("positive control: Zeus already in the tavern when the farmer gathers sees it, in all three", () => {
  const start = actorAt(
    actorAt(greekState(), "farmer", "tavern"),
    "zeus",
    "town-square",
  );
  const arrived = tick(start, [walkIn]);
  const gathering = tick(arrived.state, [gather]);
  const gathered = gathering.events.find((e) => e.kind === "resource-gathered");
  if (!gathered) throw new Error("the farmer did not gather");

  const seen = surfaces(gathering.state, [
    ...arrived.events,
    ...gathering.events,
  ]);
  expect(seen.snapshot.events.map((e) => e.id)).toContain(gathered.id);
  expect(seen.text).toContain(gathered.id);
  expect(seen.linked).toContain(gathered.id);
  expect(
    seen.schema.parse({
      action: "legend",
      assertion: "I saw the farmer gather.",
      linkedEventId: gathered.id,
    }).ok,
  ).toBe(true);
});
