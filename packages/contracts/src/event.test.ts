import { expect, test } from "bun:test";
import { LATEST_EVENT_SCHEMA_VERSION, parseEvent } from "./event";

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
