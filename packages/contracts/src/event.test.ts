import { expect, test } from "bun:test";
import {
  causalChain,
  eventCause,
  eventSubjects,
  LATEST_EVENT_SCHEMA_VERSION,
  MAX_GOAL_LENGTH,
  MAX_REPORT_LENGTH,
  parseEvent,
  UNPLACED_EVENT_KINDS,
  WITNESSED_EVENT_KINDS,
  WORLD_EVENT_KINDS,
  type WorldEvent,
} from "./event";

function envelope(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: LATEST_EVENT_SCHEMA_VERSION,
    id: "evt-1",
    sequence: 0,
    simTime: 0,
    correlationId: "corr-1",
    causationId: "cause-1",
    approximate: false,
    ...overrides,
  };
}

test("a valid entity-moved event parses", () => {
  const result = parseEvent(
    envelope({ kind: "entity-moved", entityId: "npc-1", to: "loc-2" }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      schemaVersion: LATEST_EVENT_SCHEMA_VERSION,
      id: "evt-1",
      sequence: 0,
      simTime: 0,
      correlationId: "corr-1",
      causationId: "cause-1",
      approximate: false,
      kind: "entity-moved",
      entityId: "npc-1",
      to: "loc-2",
    });
  }
});

test("a valid realm-transitioned event parses", () => {
  const result = parseEvent(
    envelope({
      kind: "realm-transitioned",
      entityId: "npc-1",
      to: "underworld-gate",
      via: "styx",
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "realm-transitioned",
      entityId: "npc-1",
      to: "underworld-gate",
      via: "styx",
    });
  }
});

test("a valid resource-gathered event parses", () => {
  const result = parseEvent(
    envelope({
      kind: "resource-gathered",
      entityId: "npc-1",
      resource: "wood",
      amount: 2,
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "resource-gathered",
      entityId: "npc-1",
      resource: "wood",
      amount: 2,
    });
  }
});

test("a valid resource-produced event parses", () => {
  const result = parseEvent(
    envelope({
      kind: "resource-produced",
      entityId: "npc-1",
      output: "planks",
      quantity: 3,
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "resource-produced",
      entityId: "npc-1",
      output: "planks",
      quantity: 3,
    });
  }
});

test("a valid resource-traded event parses with give and receive lines", () => {
  const result = parseEvent(
    envelope({
      kind: "resource-traded",
      entityId: "woodcutter",
      counterpartyId: "farmer",
      give: [{ resource: "wood", amount: 2 }],
      receive: [{ resource: "currency", amount: 2 }],
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "resource-traded",
      entityId: "woodcutter",
      counterpartyId: "farmer",
      give: [{ resource: "wood", amount: 2 }],
      receive: [{ resource: "currency", amount: 2 }],
    });
  }
});

test("a valid resource-consumed event parses", () => {
  const result = parseEvent(
    envelope({
      kind: "resource-consumed",
      entityId: "npc-1",
      resource: "food",
      amount: 1,
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "resource-consumed",
      entityId: "npc-1",
      resource: "food",
      amount: 1,
    });
  }
});

test("a valid building-damaged event parses", () => {
  const result = parseEvent(
    envelope({
      kind: "building-damaged",
      entityId: "old-oak",
      amount: 1,
      actor: "zeus",
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "building-damaged",
      entityId: "old-oak",
      amount: 1,
      actor: "zeus",
    });
  }
});

test("a valid building-ignited event parses, carrying the strike that started the fire", () => {
  const result = parseEvent(
    envelope({
      kind: "building-ignited",
      entityId: "the-tavern",
      cause: { kind: "strike", actor: "zeus" },
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "building-ignited",
      entityId: "the-tavern",
      cause: { kind: "strike", actor: "zeus" },
    });
  }
});

test("a spread ignition names the source building's ignition event and the actor who started the fire", () => {
  const result = parseEvent(
    envelope({
      kind: "building-ignited",
      entityId: "old-oak",
      cause: { kind: "spread", from: "evt-4", actor: "zeus" },
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      cause: { kind: "spread", from: "evt-4", actor: "zeus" },
    });
  }
});

test("an ignition without a cause, or with a malformed one, is rejected", () => {
  const missing = parseEvent(
    envelope({ kind: "building-ignited", entityId: "the-tavern" }),
  );
  expect(missing.ok).toBe(false);
  for (const cause of [
    { kind: "lightning", actor: "zeus" },
    { kind: "strike" },
    { kind: "spread", actor: "zeus" },
    "evt-4",
  ]) {
    const result = parseEvent(
      envelope({ kind: "building-ignited", entityId: "the-tavern", cause }),
    );
    expect(result.ok).toBe(false);
  }
});

test("a valid building-burn-ticked event parses", () => {
  const result = parseEvent(
    envelope({
      kind: "building-burn-ticked",
      entityId: "the-tavern",
      fireIntensity: 2,
      ticksBurning: 1,
      cause: "evt-3",
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "building-burn-ticked",
      entityId: "the-tavern",
      fireIntensity: 2,
      ticksBurning: 1,
      cause: "evt-3",
    });
  }
});

test("a valid building-destroyed event parses with its disposed inventory", () => {
  const result = parseEvent(
    envelope({
      kind: "building-destroyed",
      entityId: "the-tavern",
      disposedInventory: [{ resource: "wine", amount: 3 }],
      cause: "evt-3",
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "building-destroyed",
      entityId: "the-tavern",
      disposedInventory: [{ resource: "wine", amount: 3 }],
      cause: "evt-3",
    });
  }
});

test("burn and destruction events without the ignition they follow from are rejected", () => {
  expect(
    parseEvent(
      envelope({
        kind: "building-burn-ticked",
        entityId: "the-tavern",
        fireIntensity: 1,
        ticksBurning: 1,
      }),
    ).ok,
  ).toBe(false);
  expect(
    parseEvent(
      envelope({
        kind: "building-destroyed",
        entityId: "the-tavern",
        disposedInventory: [],
      }),
    ).ok,
  ).toBe(false);
});

test("a valid repair-progressed event parses", () => {
  const result = parseEvent(
    envelope({
      kind: "repair-progressed",
      entityId: "farmer",
      structureId: "the-tavern",
      resource: "planks",
      amount: 1,
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "repair-progressed",
      entityId: "farmer",
      structureId: "the-tavern",
      resource: "planks",
      amount: 1,
    });
  }
});

test("a valid building-repaired event parses", () => {
  const result = parseEvent(
    envelope({ kind: "building-repaired", entityId: "the-tavern" }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "building-repaired",
      entityId: "the-tavern",
    });
  }
});

test("a valid worship-performed event parses with an offering and a favor", () => {
  const result = parseEvent(
    envelope({
      kind: "worship-performed",
      entityId: "farmer",
      deity: "zeus",
      offering: { resource: "wine", amount: 1 },
      favorEffect: "trade-favor",
      favorExpiresAtTick: 20,
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "worship-performed",
      entityId: "farmer",
      deity: "zeus",
      offering: { resource: "wine", amount: 1 },
      favorEffect: "trade-favor",
      favorExpiresAtTick: 20,
    });
  }
});

test("a valid worship-performed event parses without an offering", () => {
  const result = parseEvent(
    envelope({
      kind: "worship-performed",
      entityId: "farmer",
      deity: "zeus",
      favorEffect: "trade-favor",
      favorExpiresAtTick: 20,
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({ kind: "worship-performed" });
    if (result.value.kind === "worship-performed") {
      expect(result.value.offering).toBeUndefined();
    }
  }
});

test("a valid income-earned event parses", () => {
  const result = parseEvent(
    envelope({
      kind: "income-earned",
      entityId: "farmer",
      buildingId: "agora-shop",
      amount: 2,
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "income-earned",
      entityId: "farmer",
      buildingId: "agora-shop",
      amount: 2,
    });
  }
});

test("a legend-recorded event carries an attributed assertion and, optionally, an evidence link -- and no truth flag", () => {
  const unlinked = parseEvent(
    envelope({
      kind: "legend-recorded",
      entityId: "bard",
      assertion: "Zeus struck down the old oak",
      hearers: [],
    }),
  );
  expect(unlinked.ok).toBe(true);
  if (unlinked.ok && unlinked.value.kind === "legend-recorded") {
    expect(unlinked.value).toMatchObject({
      entityId: "bard",
      assertion: "Zeus struck down the old oak",
    });
    expect(unlinked.value.linkedEventId).toBeUndefined();
    expect("verified" in unlinked.value).toBe(false);
    expect("legendId" in unlinked.value).toBe(false);
  }

  const linked = parseEvent(
    envelope({
      kind: "legend-recorded",
      entityId: "bard",
      assertion: "Zeus destroyed the entire Underworld",
      linkedEventId: "evt-9",
      hearers: [],
    }),
  );
  expect(linked.ok).toBe(true);
  if (linked.ok && linked.value.kind === "legend-recorded") {
    expect(String(linked.value.linkedEventId)).toBe("evt-9");
    expect("verified" in linked.value).toBe(false);
  }
});

test("a legend-recorded event with a non-string linkedEventId is rejected", () => {
  const result = parseEvent(
    envelope({
      kind: "legend-recorded",
      entityId: "bard",
      assertion: "Zeus struck down the old oak",
      linkedEventId: 9,
      hearers: [],
    }),
  );
  expect(result.ok).toBe(false);
});

function subjectsOf(event: WorldEvent): readonly string[] {
  return eventSubjects(event);
}

function parsedEvent(overrides: Record<string, unknown>): WorldEvent {
  const result = parseEvent(envelope(overrides));
  if (!result.ok) {
    throw new Error(`fixture failed to parse: ${result.message}`);
  }
  return result.value;
}

test("eventSubjects lists every entity a movement touches", () => {
  expect(
    subjectsOf(
      parsedEvent({ kind: "entity-moved", entityId: "npc-1", to: "loc-2" }),
    ),
  ).toEqual(["npc-1", "loc-2"]);
  expect(
    subjectsOf(
      parsedEvent({
        kind: "realm-transitioned",
        entityId: "npc-1",
        to: "underworld-gate",
        via: "styx",
      }),
    ),
  ).toEqual(["npc-1", "underworld-gate", "styx"]);
});

test("eventSubjects lists the counterparty, structure, deity, and building an event names", () => {
  expect(
    subjectsOf(
      parsedEvent({
        kind: "resource-traded",
        entityId: "npc-1",
        counterpartyId: "npc-2",
        give: [],
        receive: [],
      }),
    ),
  ).toEqual(["npc-1", "npc-2"]);
  expect(
    subjectsOf(
      parsedEvent({
        kind: "repair-progressed",
        entityId: "npc-1",
        structureId: "tavern",
        resource: "planks",
        amount: 1,
      }),
    ),
  ).toEqual(["npc-1", "tavern"]);
  expect(
    subjectsOf(
      parsedEvent({
        kind: "worship-performed",
        entityId: "npc-1",
        deity: "zeus",
        favorEffect: "gather-bonus",
        favorExpiresAtTick: 12,
      }),
    ),
  ).toEqual(["npc-1", "zeus"]);
  expect(
    subjectsOf(
      parsedEvent({
        kind: "income-earned",
        entityId: "npc-1",
        buildingId: "tavern",
        amount: 1,
      }),
    ),
  ).toEqual(["npc-1", "tavern"]);
});

test("eventSubjects lists only the building for building-scoped events", () => {
  expect(
    subjectsOf(
      parsedEvent({
        kind: "building-ignited",
        entityId: "tavern",
        cause: { kind: "strike", actor: "zeus" },
      }),
    ),
  ).toEqual(["tavern"]);
  expect(
    subjectsOf(
      parsedEvent({
        kind: "building-burn-ticked",
        entityId: "tavern",
        fireIntensity: 1,
        ticksBurning: 1,
        cause: "evt-3",
      }),
    ),
  ).toEqual(["tavern"]);
});

test("eventSubjects never repeats an id an event names twice", () => {
  expect(
    subjectsOf(
      parsedEvent({
        kind: "resource-traded",
        entityId: "npc-1",
        counterpartyId: "npc-1",
        give: [],
        receive: [],
      }),
    ),
  ).toEqual(["npc-1"]);
});

test("WORLD_EVENT_KINDS lists every kind parseEvent accepts", () => {
  expect(WORLD_EVENT_KINDS).toContain("entity-moved");
  expect(WORLD_EVENT_KINDS).toContain("legend-recorded");
  expect(new Set(WORLD_EVENT_KINDS).size).toBe(WORLD_EVENT_KINDS.length);
  expect(WORLD_EVENT_KINDS).toContain("memory-recorded");
  expect(WORLD_EVENT_KINDS).toContain("report-told");
  expect(WORLD_EVENT_KINDS).toContain("relationship-changed");
  expect(WORLD_EVENT_KINDS).toHaveLength(20);
});

test("an unknown event kind is rejected with reason unknown-kind", () => {
  const result = parseEvent(
    envelope({ kind: "teleported", entityId: "npc-1" }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe("unknown-kind");
  }
});

test("an unsupported schema version is rejected distinctly from a malformed payload", () => {
  const result = parseEvent(
    envelope({
      schemaVersion: 99,
      kind: "entity-moved",
      entityId: "npc-1",
      to: "loc-2",
    }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe("unsupported-version");
  }

  const malformedInput = envelope({
    kind: "entity-moved",
    entityId: "npc-1",
    to: "loc-2",
  });
  delete malformedInput.id;
  const malformed = parseEvent(malformedInput);
  expect(malformed.ok).toBe(false);
  if (!malformed.ok) {
    expect(malformed.reason).toBe("malformed");
    expect(malformed.path).toBe("id");
  }
});

// --- Social events: memory, reports, relationships -----------------------------

const WITNESSED = {
  kind: "memory-recorded",
  memoryKind: "witnessed",
  entityId: "farmer",
  sourceEventId: "evt-4",
  eventKind: "building-ignited",
  subjects: ["the-tavern"],
  salience: 8,
  consequence: { effect: "harm", agent: "zeus", target: "farmer" },
};

const TOLD = {
  kind: "memory-recorded",
  memoryKind: "told",
  entityId: "hera",
  sourceEventId: "evt-9",
  teller: "farmer",
  content: "Zeus burned the whole agora down",
  linkedEventId: "evt-4",
  subjects: ["farmer", "the-tavern"],
  salience: 4,
  consequence: { effect: "harm", agent: "zeus", target: "farmer" },
};

test("a witnessed memory parses with the event it rests on, what was seen, and its consequence", () => {
  const result = parseEvent(envelope(WITNESSED));
  expect(result.ok).toBe(true);
  if (result.ok && result.value.kind === "memory-recorded") {
    expect(result.value.memoryKind).toBe("witnessed");
    expect(String(result.value.sourceEventId)).toBe("evt-4");
    expect(result.value.salience).toBe(8);
    expect(result.value.consequence as unknown).toEqual({
      effect: "harm",
      agent: "zeus",
      target: "farmer",
    });
  }
});

test("a told memory parses attributed to its teller, with the content as told and the event the teller cited", () => {
  const result = parseEvent(envelope(TOLD));
  expect(result.ok).toBe(true);
  if (
    result.ok &&
    result.value.kind === "memory-recorded" &&
    result.value.memoryKind === "told"
  ) {
    expect(String(result.value.teller)).toBe("farmer");
    expect(result.value.content).toBe("Zeus burned the whole agora down");
    expect(String(result.value.linkedEventId)).toBe("evt-4");
  }
  // A told memory needs no cited event and no consequence: a bare story.
  const bare = parseEvent(
    envelope({
      ...TOLD,
      linkedEventId: undefined,
      consequence: undefined,
    }),
  );
  expect(bare.ok).toBe(true);
});

test("a memory missing what its kind requires, or with a malformed field, is rejected", () => {
  const broken: Record<string, unknown>[] = [
    { ...WITNESSED, eventKind: undefined },
    { ...WITNESSED, eventKind: "not-a-kind" },
    { ...WITNESSED, sourceEventId: undefined },
    { ...WITNESSED, salience: 0 },
    { ...WITNESSED, salience: 1.5 },
    { ...WITNESSED, subjects: "the-tavern" },
    { ...WITNESSED, consequence: { effect: "worship", agent: "zeus" } },
    { ...WITNESSED, consequence: { effect: "harm" } },
    { ...TOLD, teller: undefined },
    { ...TOLD, content: undefined },
    { ...TOLD, content: "" },
    { ...WITNESSED, memoryKind: "dreamed" },
    { ...WITNESSED, memoryKind: undefined },
  ];
  for (const overrides of broken) {
    expect(parseEvent(envelope(overrides)).ok).toBe(false);
  }
});

test("a report-told event names the teller, the listener, the content told, and any event the teller cited", () => {
  const result = parseEvent(
    envelope({
      kind: "report-told",
      entityId: "farmer",
      listenerId: "hera",
      content: "Zeus burned the whole agora down",
      linkedEventId: "evt-4",
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok && result.value.kind === "report-told") {
    expect(String(result.value.listenerId)).toBe("hera");
    expect(String(result.value.linkedEventId)).toBe("evt-4");
    expect("verified" in result.value).toBe(false);
  }
  expect(
    parseEvent(
      envelope({
        kind: "report-told",
        entityId: "farmer",
        listenerId: "hera",
      }),
    ).ok,
  ).toBe(false);
});

test("a relationship-changed event names who feels it, toward whom, the change, and the memory that caused it", () => {
  const result = parseEvent(
    envelope({
      kind: "relationship-changed",
      entityId: "hera",
      toward: "zeus",
      affinityDelta: -1,
      grudgeDelta: 0,
      allied: false,
      memoryEventId: "evt-10",
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok && result.value.kind === "relationship-changed") {
    expect(result.value.affinityDelta).toBe(-1);
    expect(result.value.allied).toBe(false);
    expect(String(result.value.memoryEventId)).toBe("evt-10");
  }
  // `allied` is present only when the change flipped it.
  expect(
    parseEvent(
      envelope({
        kind: "relationship-changed",
        entityId: "hera",
        toward: "zeus",
        affinityDelta: 1,
        grudgeDelta: 0,
        memoryEventId: "evt-10",
      }),
    ).ok,
  ).toBe(true);
});

test("a relationship-changed event without a cause, with a fractional delta, or with a negative grudge change is rejected", () => {
  const good = {
    kind: "relationship-changed",
    entityId: "hera",
    toward: "zeus",
    affinityDelta: -1,
    grudgeDelta: 0,
    memoryEventId: "evt-10",
  };
  for (const overrides of [
    { memoryEventId: undefined },
    { affinityDelta: -0.5 },
    { grudgeDelta: -1 },
    { toward: undefined },
    { allied: "yes" },
  ]) {
    expect(parseEvent(envelope({ ...good, ...overrides })).ok).toBe(false);
  }
});

test("eventSubjects lists the owner of a memory, both ends of a report, and both ends of a relationship", () => {
  expect(subjectsOf(parsedEvent(WITNESSED))).toEqual(["farmer"]);
  expect(
    subjectsOf(
      parsedEvent({
        kind: "report-told",
        entityId: "farmer",
        listenerId: "hera",
        content: "x",
      }),
    ),
  ).toEqual(["farmer", "hera"]);
  expect(
    subjectsOf(
      parsedEvent({
        kind: "relationship-changed",
        entityId: "hera",
        toward: "zeus",
        affinityDelta: -1,
        grudgeDelta: 0,
        memoryEventId: "evt-10",
      }),
    ),
  ).toEqual(["hera", "zeus"]);
});

// --- Causal chains ---------------------------------------------------------------

function log(...events: Record<string, unknown>[]): Map<string, WorldEvent> {
  const byId = new Map<string, WorldEvent>();
  for (const [index, overrides] of events.entries()) {
    const event = parsedEvent({
      id: `evt-${index + 1}`,
      sequence: index + 1,
      ...overrides,
    });
    byId.set(event.id, event);
  }
  return byId;
}

test("eventCause is the event a fire event, a memory, a report, or a relationship change follows from", () => {
  const events = log(
    {
      kind: "building-ignited",
      entityId: "the-tavern",
      cause: { kind: "strike", actor: "zeus" },
    },
    {
      kind: "building-ignited",
      entityId: "old-oak",
      cause: { kind: "spread", from: "evt-1", actor: "zeus" },
    },
    {
      kind: "building-burn-ticked",
      entityId: "old-oak",
      fireIntensity: 1,
      ticksBurning: 1,
      cause: "evt-2",
    },
    {
      kind: "building-destroyed",
      entityId: "old-oak",
      disposedInventory: [],
      cause: "evt-2",
    },
    { ...WITNESSED, sourceEventId: "evt-4" },
    {
      kind: "report-told",
      entityId: "farmer",
      listenerId: "hera",
      content: "x",
      linkedEventId: "evt-1",
    },
    {
      kind: "relationship-changed",
      entityId: "farmer",
      toward: "zeus",
      affinityDelta: -2,
      grudgeDelta: 1,
      memoryEventId: "evt-5",
    },
    {
      kind: "report-told",
      entityId: "farmer",
      listenerId: "hera",
      content: "an uncited story",
    },
  );
  const cause = (n: number) => {
    const event = events.get(`evt-${n}`);
    return event === undefined ? undefined : eventCause(event);
  };
  // A strike ignition is a root: its own proposal, not another event, caused it.
  expect(cause(1)).toBeUndefined();
  expect(String(cause(2))).toBe("evt-1");
  expect(String(cause(3))).toBe("evt-2");
  expect(String(cause(4))).toBe("evt-2");
  expect(String(cause(5))).toBe("evt-4");
  expect(String(cause(6))).toBe("evt-1");
  expect(String(cause(7))).toBe("evt-5");
  // A bare story cites nothing.
  expect(cause(8)).toBeUndefined();
});

test("causalChain walks a destruction back through spread and ignition to the strike, root first", () => {
  const events = log(
    {
      kind: "building-ignited",
      entityId: "the-tavern",
      cause: { kind: "strike", actor: "zeus" },
    },
    {
      kind: "building-ignited",
      entityId: "old-oak",
      cause: { kind: "spread", from: "evt-1", actor: "zeus" },
    },
    {
      kind: "building-destroyed",
      entityId: "old-oak",
      disposedInventory: [],
      cause: "evt-2",
    },
  );
  const chain = causalChain((id) => events.get(id), "evt-3" as never);
  expect(chain.map((event) => String(event.id))).toEqual([
    "evt-1",
    "evt-2",
    "evt-3",
  ]);
});

test("causalChain of a root event, or of one whose cause is not in the log, ends where the log does", () => {
  const events = log(
    {
      kind: "building-ignited",
      entityId: "the-tavern",
      cause: { kind: "strike", actor: "zeus" },
    },
    {
      kind: "building-burn-ticked",
      entityId: "the-tavern",
      fireIntensity: 1,
      ticksBurning: 1,
      cause: "evt-404",
    },
  );
  expect(
    causalChain((id) => events.get(id), "evt-1" as never).map((e) =>
      String(e.id),
    ),
  ).toEqual(["evt-1"]);
  expect(
    causalChain((id) => events.get(id), "evt-2" as never).map((e) =>
      String(e.id),
    ),
  ).toEqual(["evt-2"]);
  expect(causalChain((id) => events.get(id), "evt-404" as never)).toEqual([]);
});

// --- Claims, text limits, and what can be witnessed ---------------------------

test("a report-told event may carry the claim its teller asserted, shape-checked and never judged", () => {
  const result = parseEvent(
    envelope({
      kind: "report-told",
      entityId: "farmer",
      listenerId: "hera",
      content: "Zeus wronged me",
      claim: { effect: "harm", agent: "zeus", target: "farmer" },
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok && result.value.kind === "report-told") {
    expect(result.value.claim as unknown).toEqual({
      effect: "harm",
      agent: "zeus",
      target: "farmer",
    });
  }
  expect(
    parseEvent(
      envelope({
        kind: "report-told",
        entityId: "farmer",
        listenerId: "hera",
        content: "x",
        claim: { effect: "harm" },
      }),
    ).ok,
  ).toBe(false);
});

test("report text is bounded in the event and in the belief it becomes", () => {
  const atLimit = "x".repeat(MAX_REPORT_LENGTH);
  const over = `${atLimit}x`;
  const told = (content: string) =>
    parseEvent(
      envelope({
        kind: "report-told",
        entityId: "farmer",
        listenerId: "hera",
        content,
      }),
    ).ok;
  expect(told(atLimit)).toBe(true);
  expect(told(over)).toBe(false);
  const belief = (content: string) =>
    parseEvent(envelope({ ...TOLD, content })).ok;
  expect(belief(atLimit)).toBe(true);
  expect(belief(over)).toBe(false);
});

test("only kinds someone can perceive are witnessable: a memory of a report, a memory, or a feeling is rejected", () => {
  for (const eventKind of [
    "report-told",
    "memory-recorded",
    "relationship-changed",
  ]) {
    expect(parseEvent(envelope({ ...WITNESSED, eventKind })).ok).toBe(false);
    expect(WITNESSED_EVENT_KINDS as readonly string[]).not.toContain(eventKind);
  }
  // Control: every other kind can be witnessed.
  for (const eventKind of WITNESSED_EVENT_KINDS) {
    expect(parseEvent(envelope({ ...WITNESSED, eventKind })).ok).toBe(true);
  }
  expect(WITNESSED_EVENT_KINDS).toHaveLength(WORLD_EVENT_KINDS.length - 5);
});

// --- Legend tellings: a claim and the recorded hearers ------------------------------------

test("a legend-recorded event records who heard it and may carry a claim shaped like a report's", () => {
  const result = parseEvent(
    envelope({
      kind: "legend-recorded",
      entityId: "hera",
      assertion: "Zeus cheated me.",
      claim: { effect: "harm", agent: "zeus", target: "hera" },
      hearers: ["farmer", "zeus"],
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok && result.value.kind === "legend-recorded") {
    expect(result.value.hearers.map(String)).toEqual(["farmer", "zeus"]);
    expect(result.value.claim as unknown).toEqual({
      effect: "harm",
      agent: "zeus",
      target: "hera",
    });
  }
  // A legend told to no one is still a legend: an empty audience is valid.
  expect(
    parseEvent(
      envelope({
        kind: "legend-recorded",
        entityId: "hera",
        assertion: "Alone.",
        hearers: [],
      }),
    ).ok,
  ).toBe(true);
});

test("a legend-recorded event without its hearers, or with a malformed hearer list or claim, is rejected", () => {
  const good = {
    kind: "legend-recorded",
    entityId: "hera",
    assertion: "x",
    hearers: ["farmer"],
  };
  expect(parseEvent(envelope(good)).ok).toBe(true);
  for (const overrides of [
    { hearers: undefined },
    { hearers: "farmer" },
    { hearers: [3] },
    { claim: { effect: "worship", agent: "zeus" } },
    { claim: { effect: "harm" } },
  ]) {
    expect(parseEvent(envelope({ ...good, ...overrides })).ok).toBe(false);
  }
});

// --- Goal events ---------------------------------------------------------------------------

test("a goal-set event names the god, its words, and its one target", () => {
  const result = parseEvent(
    envelope({
      kind: "goal-set",
      entityId: "hera",
      text: "Make Zeus admit his deceit.",
      target: "zeus",
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok && result.value.kind === "goal-set") {
    expect(result.value.text).toBe("Make Zeus admit his deceit.");
    expect(String(result.value.target)).toBe("zeus");
  }
});

test("a goal-ended event names the god, the outcome, and the goal-set event it ends", () => {
  for (const outcome of ["achieved", "failed", "abandoned"]) {
    const result = parseEvent(
      envelope({
        kind: "goal-ended",
        entityId: "hera",
        outcome,
        goalEventId: "evt-3",
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === "goal-ended") {
      expect(result.value.outcome as string).toBe(outcome);
      expect(String(result.value.goalEventId)).toBe("evt-3");
    }
  }
});

test("goal events with empty or over-long text, an unknown outcome, or a missing field are rejected", () => {
  const set = {
    kind: "goal-set",
    entityId: "hera",
    text: "Win the farmer's devotion.",
    target: "farmer",
  };
  expect(parseEvent(envelope(set)).ok).toBe(true);
  expect(
    parseEvent(envelope({ ...set, text: "x".repeat(MAX_GOAL_LENGTH) })).ok,
  ).toBe(true);
  for (const overrides of [
    { text: "" },
    { text: "x".repeat(MAX_GOAL_LENGTH + 1) },
    { text: undefined },
    { target: undefined },
    { entityId: undefined },
  ]) {
    expect(parseEvent(envelope({ ...set, ...overrides })).ok).toBe(false);
  }
  const ended = {
    kind: "goal-ended",
    entityId: "hera",
    outcome: "achieved",
    goalEventId: "evt-3",
  };
  expect(parseEvent(envelope(ended)).ok).toBe(true);
  for (const overrides of [
    { outcome: "won" },
    { outcome: undefined },
    { goalEventId: undefined },
  ]) {
    expect(parseEvent(envelope({ ...ended, ...overrides })).ok).toBe(false);
  }
});

test("goal events are private and unplaced: in the unplaced set, out of the witnessed set; and a legend stays witnessable", () => {
  for (const kind of ["goal-set", "goal-ended"]) {
    expect(UNPLACED_EVENT_KINDS as readonly string[]).toContain(kind);
    expect(WITNESSED_EVENT_KINDS as readonly string[]).not.toContain(kind);
    // A witnessed memory cannot name them.
    expect(
      parseEvent(
        envelope({
          kind: "memory-recorded",
          memoryKind: "witnessed",
          entityId: "farmer",
          sourceEventId: "evt-2",
          eventKind: kind,
          subjects: [],
          salience: 4,
        }),
      ).ok,
    ).toBe(false);
  }
  // Control: the legend event is placed and witnessable.
  expect(UNPLACED_EVENT_KINDS as readonly string[]).not.toContain(
    "legend-recorded",
  );
  expect(WITNESSED_EVENT_KINDS as readonly string[]).toContain(
    "legend-recorded",
  );
});

test("a goal-ended event follows the goal it ends; a goal-set is a root; subjects name the god and the target", () => {
  const events = new Map<string, WorldEvent>();
  for (const [index, overrides] of [
    {
      kind: "goal-set",
      entityId: "hera",
      text: "Win devotion.",
      target: "farmer",
    },
    {
      kind: "goal-ended",
      entityId: "hera",
      outcome: "abandoned",
      goalEventId: "evt-1",
    },
  ].entries()) {
    const event = parsedEvent({
      id: `evt-${index + 1}`,
      sequence: index + 1,
      ...overrides,
    });
    events.set(event.id, event);
  }
  const set = events.get("evt-1");
  const ended = events.get("evt-2");
  if (!set || !ended) throw new Error("fixture");
  expect(eventCause(set)).toBeUndefined();
  expect(String(eventCause(ended))).toBe("evt-1");
  expect(subjectsOf(set)).toEqual(["hera", "farmer"]);
  expect(subjectsOf(ended)).toEqual(["hera"]);
});
