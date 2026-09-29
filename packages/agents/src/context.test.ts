import { expect, test } from "bun:test";
import type { GodProfile } from "@panthea/content";
import { type PerceptionSnapshot, perceive, toEntityId } from "@panthea/world";
import {
  buildGodContext,
  GOD_INTENT_ACTIONS,
  type GodIntent,
  godAvailableActions,
  godIntentSchema,
  type ParsedGodIntent,
} from "./context";
import {
  actorAt,
  actorCapable,
  actorHolding,
  allGodProfiles,
  committedEvent,
  godProfile,
  greekState,
} from "./test-fixtures";

const zeus = godProfile("zeus");

function snapshotOf(
  actor: string,
  at: string,
  events: Parameters<typeof perceive>[2] = [],
  prepare = (state: ReturnType<typeof greekState>) => state,
): PerceptionSnapshot {
  const snapshot = perceive(
    prepare(actorAt(greekState(), actor, at)),
    toEntityId(actor),
    events,
  );
  if (!snapshot) throw new Error(`${actor} perceives nothing`);
  return snapshot;
}

function withoutAbility(profile: GodProfile, action: string): GodProfile {
  return {
    ...profile,
    abilities: profile.abilities.filter((ability) => ability.action !== action),
  };
}

const atTavern = () => snapshotOf("zeus", "tavern");
const atSquare = () => snapshotOf("zeus", "town-square");

const properties = (schema: { readonly jsonSchema: unknown }) =>
  (schema.jsonSchema as { properties: Record<string, { enum?: string[] }> })
    .properties;

// --- godIntentSchema ---------------------------------------------------------

test("a valid strike on a building in view parses", () => {
  const schema = godIntentSchema(zeus, atTavern());
  expect(
    schema.parse({
      action: "strike",
      target: "the-tavern",
      power: 3,
    }) as unknown,
  ).toEqual({
    ok: true,
    value: { action: "strike", target: "the-tavern", power: 3 },
  });
});

test("a valid legend parses, with and without a linked event from the snapshot", () => {
  const event = committedEvent({
    kind: "building-ignited",
    entityId: "the-tavern",
  });
  const schema = godIntentSchema(zeus, snapshotOf("zeus", "tavern", [event]));

  expect(
    schema.parse({
      action: "legend",
      assertion: "Fire took it.",
    }) as unknown,
  ).toEqual({
    ok: true,
    value: { action: "legend", assertion: "Fire took it." },
  });
  expect(
    schema.parse({
      action: "legend",
      assertion: "Fire took it.",
      linkedEventId: event.id,
    }) as unknown,
  ).toEqual({
    ok: true,
    value: {
      action: "legend",
      assertion: "Fire took it.",
      linkedEventId: event.id,
    },
  });
});

test("a strike on a building outside the snapshot fails; the same strike parses once Zeus stands there", () => {
  const intent = { action: "strike", target: "old-oak", power: 2 };

  const tavern = godIntentSchema(zeus, atTavern());
  const refused = tavern.parse(intent);
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.path).toBe("target");
  expect(properties(tavern).target?.enum).not.toContain("old-oak");

  const square = godIntentSchema(zeus, atSquare());
  expect(square.parse(intent).ok).toBe(true);
  expect(properties(square).target?.enum).toContain("old-oak");
});

test("a legend citing an event outside the snapshot fails", () => {
  const remote = committedEvent({
    kind: "building-ignited",
    entityId: "old-oak",
  });
  const schema = godIntentSchema(zeus, snapshotOf("zeus", "tavern", [remote]));
  const result = schema.parse({
    action: "legend",
    assertion: "The oak burned.",
    linkedEventId: remote.id,
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.path).toBe("linkedEventId");
});

test("an action outside the god's abilities fails, and the schema never offers it", () => {
  const noStrike = withoutAbility(zeus, "strike");
  const schema = godIntentSchema(noStrike, atTavern());
  const result = schema.parse({
    action: "strike",
    target: "the-tavern",
    power: 1,
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.path).toBe("action");
  expect(properties(schema).action?.enum).not.toContain("strike");

  // An action no profile grants is refused whatever the profile says.
  expect(
    godIntentSchema(zeus, atTavern()).parse({
      action: "gather",
      resource: "wood",
    }).ok,
  ).toBe(false);
});

test("the schema offers exactly the god's ability actions that can be used here plus the movement actions that apply", () => {
  expect(properties(godIntentSchema(zeus, atTavern())).action?.enum).toEqual([
    "move",
    "strike",
    "legend",
    "wait",
  ]);
  const atMountain = snapshotOf("zeus", "mountain-path", [], blessed);
  expect(properties(godIntentSchema(zeus, atMountain)).action?.enum).toEqual([
    "move",
    "realm-transition",
    "legend",
    "wait",
  ]);
  expect(godAvailableActions(zeus, atMountain)).toEqual([
    "move",
    "realm-transition",
    "legend",
    "wait",
  ]);
});

test("strike power above the ability's power fails; power up to it parses", () => {
  const schema = godIntentSchema(zeus, atTavern());
  const over = schema.parse({
    action: "strike",
    target: "the-tavern",
    power: 4,
  });
  expect(over.ok).toBe(false);
  if (!over.ok) expect(over.path).toBe("power");
  expect(
    schema.parse({ action: "strike", target: "the-tavern", power: 1 }).ok,
  ).toBe(true);
  const power = properties(schema).power as {
    maximum?: number;
    minimum?: number;
  };
  expect(power.maximum).toBe(3);
  expect(power.minimum).toBe(1);
});

test("strike power above the divinity Zeus holds fails; with none held, strike is not offered", () => {
  const poor = snapshotOf("zeus", "tavern", [], (state) =>
    actorHolding(state, "zeus", "divinity", 2),
  );
  const schema = godIntentSchema(zeus, poor);
  expect(
    schema.parse({ action: "strike", target: "the-tavern", power: 3 }).ok,
  ).toBe(false);
  expect(
    schema.parse({ action: "strike", target: "the-tavern", power: 2 }).ok,
  ).toBe(true);

  const spent = snapshotOf("zeus", "tavern", [], (state) =>
    actorHolding(state, "zeus", "divinity", 0),
  );
  expect(properties(godIntentSchema(zeus, spent)).action?.enum).not.toContain(
    "strike",
  );
  expect(
    godIntentSchema(zeus, spent).parse({
      action: "strike",
      target: "the-tavern",
      power: 1,
    }).ok,
  ).toBe(false);
});

test("a non-integer, zero, or missing strike power fails", () => {
  const schema = godIntentSchema(zeus, atTavern());
  for (const power of [0, 1.5, "3", undefined]) {
    expect(
      schema.parse({ action: "strike", target: "the-tavern", power }).ok,
    ).toBe(false);
  }
});

test("moves are limited to the exits of the current location", () => {
  const square = godIntentSchema(zeus, atSquare());
  expect(square.parse({ action: "move", to: "tavern" }).ok).toBe(true);
  const refused = square.parse({ action: "move", to: "great-hall" });
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.path).toBe("to");

  // A realm transition is offered only where a transport leads to another realm.
  expect(
    square.parse({ action: "realm-transition", to: "olympus-gate" }).ok,
  ).toBe(false);
  const mountain = godIntentSchema(
    zeus,
    snapshotOf("zeus", "mountain-path", [], blessed),
  );
  expect(
    mountain.parse({
      action: "realm-transition",
      to: "olympus-gate",
    }) as unknown,
  ).toEqual({
    ok: true,
    value: { action: "realm-transition", to: "olympus-gate" },
  });
  expect(mountain.parse({ action: "move", to: "olympus-gate" }).ok).toBe(false);
});

test("non-object, unknown, and empty-assertion candidates fail", () => {
  const schema = godIntentSchema(zeus, atTavern());
  for (const candidate of [
    null,
    "strike",
    [],
    {},
    { action: "smite" },
    { action: "legend", assertion: "   " },
    { action: "legend" },
  ]) {
    expect(schema.parse(candidate).ok).toBe(false);
  }
});

test("every ability the authored gods have maps to an action a god intent supports", () => {
  for (const god of allGodProfiles) {
    for (const ability of god.abilities) {
      expect(GOD_INTENT_ACTIONS as readonly string[]).toContain(ability.action);
    }
  }
});

// --- buildGodContext -----------------------------------------------------------

test("the context carries the god's profile and only what Zeus perceives at the tavern", () => {
  const events = [
    committedEvent({ kind: "building-ignited", entityId: "the-tavern" }),
    committedEvent({ kind: "building-ignited", entityId: "old-oak" }),
    committedEvent({
      kind: "resource-gathered",
      entityId: "woodcutter",
      resource: "wood",
      amount: 2,
    }),
  ];
  const context = buildGodContext(zeus, snapshotOf("zeus", "tavern", events));
  const text = `${context.instructions}\n${context.prompt}`;

  expect(text).toContain("Zeus");
  expect(text).toContain("sovereignty");
  expect(text).toContain("Thunderbolt");
  expect(text).toContain(zeus.lore[0]?.statement ?? "missing");
  expect(text).toContain("hera");
  expect(text).toContain("The Tavern");
  expect(text).toContain("the-tavern");
  expect(text).toContain("divinity");

  // Elsewhere: unseen. Neither the actor, the building, nor the events.
  for (const remote of ["woodcutter", "farmer", "old-oak", "The Old Oak"]) {
    expect(text).not.toContain(remote);
  }
  expect(text).toContain("building-ignited");
});

test("positive control: with Zeus in the square the oak, the woodcutter, and their events appear", () => {
  const events = [
    committedEvent({ kind: "building-ignited", entityId: "old-oak" }),
    committedEvent({
      kind: "resource-gathered",
      entityId: "woodcutter",
      resource: "wood",
      amount: 2,
    }),
  ];
  const context = buildGodContext(
    zeus,
    snapshotOf("zeus", "town-square", events),
  );
  const text = `${context.instructions}\n${context.prompt}`;

  for (const present of ["woodcutter", "farmer", "old-oak", "The Old Oak"]) {
    expect(text).toContain(present);
  }
  expect(text).toContain("resource-gathered");
  expect(text).not.toContain("the-tavern");
});

test("the context states the strike limits the schema enforces", () => {
  const poor = snapshotOf("zeus", "tavern", [], (state) =>
    actorHolding(state, "zeus", "divinity", 2),
  );
  const text = buildGodContext(zeus, poor).instructions;
  expect(text).toMatch(/power (?:of )?(?:at most|up to) 2/);
});

test("each god's context speaks in that god's own voice and drives", () => {
  const hera = godProfile("hera");
  const context = buildGodContext(hera, snapshotOf("hera", "great-hall"));
  const text = `${context.instructions}\n${context.prompt}`;
  expect(text).toContain("Hera");
  expect(text).toContain("fidelity");
  expect(text).toContain("Wrath of Hera");
  expect(text).not.toContain("Thunderbolt");
  // Zeus stands in the hall with her.
  expect(text).toContain("zeus");
});

// --- wait ---------------------------------------------------------------------

test("wait parses and is always offered, even with nothing else to do", () => {
  const schema = godIntentSchema(zeus, atTavern());
  expect(schema.parse({ action: "wait" }) as unknown).toEqual({
    ok: true,
    value: { action: "wait" },
  });

  // No divinity, no legend ability, no exits: only waiting is left.
  const spent = snapshotOf("zeus", "tavern", [], (state) =>
    actorHolding(state, "zeus", "divinity", 0),
  );
  const bare: GodProfile = { ...zeus, abilities: [] };
  const stuck = godIntentSchema(bare, spent);
  expect(properties(stuck).action?.enum).toContain("wait");
  expect(godAvailableActions(bare, spent)).toContain("wait");
  expect(stuck.parse({ action: "wait" }).ok).toBe(true);
});

test("the prompt tells the god that waiting is allowed", () => {
  const context = buildGodContext(zeus, atTavern());
  expect(context.instructions).toMatch(/wait/i);
  expect(context.instructions).toContain('action "wait"');
});

// --- Branded intents -----------------------------------------------------------

test("only the schema's parse produces a ParsedGodIntent; a hand-built one does not compile", () => {
  const parsed = godIntentSchema(zeus, atTavern()).parse({ action: "wait" });
  if (!parsed.ok) throw new Error(parsed.message);
  const fromParse: ParsedGodIntent = parsed.value;
  expect(fromParse.action).toBe("wait");

  const handBuilt: GodIntent = { action: "wait" };
  // @ts-expect-error a plain GodIntent has not been through godIntentSchema's parse
  const notParsed: ParsedGodIntent = handBuilt;
  expect(notParsed as unknown).toBe(handBuilt);
});

// --- Perceived events in the schema and the prompt ------------------------------------

test("the linkedEventId enum lists only perceived event ids, and is absent when none are perceived", () => {
  const local = committedEvent({
    kind: "building-ignited",
    entityId: "the-tavern",
  });
  const remote = committedEvent({
    kind: "building-ignited",
    entityId: "old-oak",
  });

  const some = godIntentSchema(
    zeus,
    snapshotOf("zeus", "tavern", [remote, local]),
  );
  const linked = (
    some.jsonSchema as { properties: Record<string, { enum?: string[] }> }
  ).properties.linkedEventId;
  expect(linked?.enum).toEqual([local.id]);
  expect(linked?.enum).not.toContain(remote.id);

  const none = godIntentSchema(zeus, snapshotOf("zeus", "tavern", [remote]));
  expect(properties(none).linkedEventId).toBeUndefined();
});

test("an income event at a visible building does not put a remote owner in the prompt; positive control: co-located, it does", () => {
  // The farmer owns the tavern and works in the square.
  const income = committedEvent({
    kind: "income-earned",
    entityId: "farmer",
    buildingId: "the-tavern",
    amount: 1,
  });
  const apart = buildGodContext(zeus, snapshotOf("zeus", "tavern", [income]));
  const apartText = `${apart.instructions}\n${apart.prompt}`;
  expect(apartText).toContain("income-earned");
  expect(apartText).toContain("the-tavern");
  expect(apartText).not.toContain("farmer");

  const together = buildGodContext(
    zeus,
    snapshotOf("zeus", "tavern", [income], (state) =>
      actorAt(state, "farmer", "tavern"),
    ),
  );
  const line = (text: string) =>
    text.split("\n").find((row) => row.includes("income-earned")) ?? "";
  // The event line itself names the owner, not merely the actor list.
  expect(line(together.prompt)).toContain("farmer");
  expect(line(apart.prompt)).not.toContain("farmer");
});

// --- Capability-gated exits ------------------------------------------------------------

const blessed = (state: ReturnType<typeof greekState>) =>
  actorCapable(state, "zeus", "divine");

test("without the required capability a god is not offered the restricted exits; positive control: with `divine` it is", () => {
  const plain = snapshotOf("zeus", "mountain-path");
  const withoutDivine = godIntentSchema(zeus, plain);
  expect(properties(withoutDivine).action?.enum).not.toContain(
    "realm-transition",
  );
  expect(godAvailableActions(zeus, plain)).not.toContain("realm-transition");
  expect(properties(withoutDivine).to?.enum ?? []).not.toContain(
    "olympus-gate",
  );
  const refused = withoutDivine.parse({
    action: "realm-transition",
    to: "olympus-gate",
  });
  expect(refused.ok).toBe(false);

  const divine = snapshotOf("zeus", "mountain-path", [], blessed);
  const withDivine = godIntentSchema(zeus, divine);
  expect(properties(withDivine).action?.enum).toContain("realm-transition");
  expect(godAvailableActions(zeus, divine)).toContain("realm-transition");
  expect(properties(withDivine).to?.enum).toContain("olympus-gate");
  expect(
    withDivine.parse({ action: "realm-transition", to: "olympus-gate" }).ok,
  ).toBe(true);
});

test("a plain move to a restricted place is not offered either, since the world would refuse it", () => {
  // olympus-gate is reached from the great hall by a plain path.
  const hall = snapshotOf("zeus", "great-hall");
  const without = godIntentSchema(zeus, hall);
  expect(without.parse({ action: "move", to: "olympus-gate" }).ok).toBe(false);

  const withDivine = godIntentSchema(
    zeus,
    snapshotOf("zeus", "great-hall", [], blessed),
  );
  expect(withDivine.parse({ action: "move", to: "olympus-gate" }).ok).toBe(
    true,
  );
});

test("the prompt does not list ways out the god cannot take", () => {
  const plain = buildGodContext(zeus, snapshotOf("zeus", "mountain-path"));
  expect(plain.prompt).not.toContain("olympus-gate");
  const divine = buildGodContext(
    zeus,
    snapshotOf("zeus", "mountain-path", [], blessed),
  );
  expect(divine.prompt).toContain("olympus-gate");
});
