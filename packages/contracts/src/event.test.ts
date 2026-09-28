import { expect, test } from "bun:test";
import {
  eventSubjects,
  LATEST_EVENT_SCHEMA_VERSION,
  parseEvent,
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
    envelope({ kind: "building-damaged", entityId: "old-oak", amount: 1 }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "building-damaged",
      entityId: "old-oak",
      amount: 1,
    });
  }
});

test("a valid building-ignited event parses", () => {
  const result = parseEvent(
    envelope({ kind: "building-ignited", entityId: "the-tavern" }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "building-ignited",
      entityId: "the-tavern",
    });
  }
});

test("a valid building-burn-ticked event parses", () => {
  const result = parseEvent(
    envelope({
      kind: "building-burn-ticked",
      entityId: "the-tavern",
      fireIntensity: 2,
      ticksBurning: 1,
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "building-burn-ticked",
      entityId: "the-tavern",
      fireIntensity: 2,
      ticksBurning: 1,
    });
  }
});

test("a valid building-destroyed event parses with its disposed inventory", () => {
  const result = parseEvent(
    envelope({
      kind: "building-destroyed",
      entityId: "the-tavern",
      disposedInventory: [{ resource: "wine", amount: 3 }],
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "building-destroyed",
      entityId: "the-tavern",
      disposedInventory: [{ resource: "wine", amount: 3 }],
    });
  }
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

test("a legend-recorded event claiming verified without a linkedEventId is rejected", () => {
  const result = parseEvent(
    envelope({
      kind: "legend-recorded",
      entityId: "bard",
      legendId: "legend-1",
      assertion: "Zeus struck down the old oak",
      verified: true,
    }),
  );
  expect(result.ok).toBe(false);
});

test("a legend-recorded event with a linkedEventId claiming unverified is rejected", () => {
  const result = parseEvent(
    envelope({
      kind: "legend-recorded",
      entityId: "bard",
      legendId: "legend-1",
      assertion: "Zeus struck down the old oak",
      linkedEventId: "evt-9",
      verified: false,
    }),
  );
  expect(result.ok).toBe(false);
});

test("a valid legend-recorded event parses, unlinked and unverified", () => {
  const result = parseEvent(
    envelope({
      kind: "legend-recorded",
      entityId: "bard",
      legendId: "legend-1",
      assertion: "Zeus struck down the old oak",
      verified: false,
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "legend-recorded",
      entityId: "bard",
      legendId: "legend-1",
      assertion: "Zeus struck down the old oak",
      verified: false,
    });
    if (result.value.kind === "legend-recorded") {
      expect(result.value.linkedEventId).toBeUndefined();
    }
  }
});

test("a valid legend-recorded event parses, linked and verified", () => {
  const result = parseEvent(
    envelope({
      kind: "legend-recorded",
      entityId: "bard",
      legendId: "legend-1",
      assertion: "Zeus struck down the old oak",
      linkedEventId: "evt-9",
      verified: true,
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({ verified: true });
    if (result.value.kind === "legend-recorded") {
      expect(String(result.value.linkedEventId)).toBe("evt-9");
    }
  }
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
    subjectsOf(parsedEvent({ kind: "building-ignited", entityId: "tavern" })),
  ).toEqual(["tavern"]);
  expect(
    subjectsOf(
      parsedEvent({
        kind: "building-burn-ticked",
        entityId: "tavern",
        fireIntensity: 1,
        ticksBurning: 1,
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
  expect(WORLD_EVENT_KINDS).toHaveLength(15);
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
