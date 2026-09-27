import { expect, test } from "bun:test";
import {
  PROPOSAL_BYTE_LIMIT,
  parseObservationRecord,
  parseProposal,
} from "./proposal";

function base(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    actor: "npc-1",
    targets: [],
    preconditions: [],
    requiredCapabilities: [],
    costs: [],
    expectedRevisions: [],
    source: "routine",
    observationId: "obs-1",
    ...overrides,
  };
}

test("observation record parses", () => {
  const result = parseObservationRecord({
    schemaVersion: 1,
    id: "obs-1",
    observer: "npc-1",
    stateRevision: 4,
    factsRead: ["location:agora.occupants"],
    source: "routine",
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      schemaVersion: 1,
      id: "obs-1",
      observer: "npc-1",
      stateRevision: 4,
      factsRead: ["location:agora.occupants"],
      source: "routine",
    });
  }
});

test("a valid move proposal parses to its typed variant", () => {
  const result = parseProposal(base({ kind: "move", to: "loc-town" }));
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.kind).toBe("move");
    expect(result.value).toMatchObject({
      kind: "move",
      to: "loc-town",
      actor: "npc-1",
    });
  }
});

test("a valid realm-transition proposal parses to its typed variant", () => {
  const result = parseProposal(
    base({
      kind: "realm-transition",
      to: "underworld-gate",
      via: "styx-ferry",
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "realm-transition",
      to: "underworld-gate",
      via: "styx-ferry",
    });
  }
});

test("a valid gather proposal parses to its typed variant", () => {
  const result = parseProposal(
    base({ kind: "gather", resource: "wood", amount: 3 }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "gather",
      resource: "wood",
      amount: 3,
    });
  }
});

test("a valid produce proposal parses to its typed variant", () => {
  const result = parseProposal(
    base({ kind: "produce", output: "bread", quantity: 2 }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "produce",
      output: "bread",
      quantity: 2,
    });
  }
});

test("a valid trade proposal parses to its typed variant", () => {
  const result = parseProposal(
    base({
      kind: "trade",
      counterparty: "npc-2",
      give: [{ resource: "wheat", amount: 3 }],
      receive: [{ resource: "wine", amount: 1 }],
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "trade",
      counterparty: "npc-2",
      give: [{ resource: "wheat", amount: 3 }],
      receive: [{ resource: "wine", amount: 1 }],
    });
  }
});

test("a valid consume proposal parses to its typed variant", () => {
  const result = parseProposal(
    base({ kind: "consume", resource: "food", amount: 1 }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "consume",
      resource: "food",
      amount: 1,
    });
  }
});

test("a valid strike proposal parses to its typed variant", () => {
  const result = parseProposal(
    base({ source: "fixture", kind: "strike", target: "tavern-1", power: 0.8 }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "strike",
      target: "tavern-1",
      power: 0.8,
    });
  }
});

test("a valid repair proposal parses to its typed variant", () => {
  const result = parseProposal(base({ kind: "repair", structure: "tavern-1" }));
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "repair",
      structure: "tavern-1",
    });
  }
});

test("a valid worship proposal parses to its typed variant", () => {
  const result = parseProposal(
    base({
      kind: "worship",
      deity: "zeus",
      offering: { resource: "wine", amount: 1 },
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "worship",
      deity: "zeus",
      offering: { resource: "wine", amount: 1 },
    });
  }
});

test("a valid claim proposal parses to its typed variant", () => {
  const result = parseProposal(
    base({ kind: "claim", assertion: "I own the tavern" }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      kind: "claim",
      assertion: "I own the tavern",
    });
  }
});

test("missing actor is a structured rejection naming the field", () => {
  const payload = base({ kind: "move", to: "loc-town" });
  delete payload.actor;
  const result = parseProposal(payload);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.path).toBe("actor");
    expect(result.reason).toBe("malformed");
  }
});

test("unknown kind is rejected with reason unknown-kind", () => {
  const result = parseProposal(base({ kind: "fly" }));
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.path).toBe("kind");
    expect(result.reason).toBe("unknown-kind");
  }
});

test("non-numeric cost is a structured rejection naming the field", () => {
  const result = parseProposal(
    base({ kind: "gather", resource: "wood", amount: "a lot" }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.path).toBe("amount");
  }
});

test("a claim asserting an inventory grant is rejected as unauthorized-claim", () => {
  const result = parseProposal(
    base({
      kind: "claim",
      assertion: "I own the tavern's inventory",
      costs: [{ resource: "gold", amount: 100 }],
    }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe("unauthorized-claim");
    expect(result.path).toBe("costs");
  }
});

test("an unsupported schema version is rejected distinctly from malformed payloads", () => {
  const result = parseProposal(
    base({ kind: "move", to: "loc-town", schemaVersion: 99 }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe("unsupported-version");
  }

  const malformed = parseProposal({ kind: "move", to: "loc-town" });
  expect(malformed.ok).toBe(false);
  if (!malformed.ok) {
    expect(malformed.reason).toBe("malformed");
  }
});

test("a proposal over the byte limit is rejected", () => {
  const result = parseProposal(
    base({ kind: "claim", assertion: "x".repeat(PROPOSAL_BYTE_LIMIT + 1) }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe("over-limit");
  }
});

test("a proposal with an unknown source is rejected", () => {
  const result = parseProposal(
    base({ kind: "move", to: "loc-town", source: "hacker" }),
  );
  expect(result.ok).toBe(false);
});

test("a proposal referencing an observation carries its ID", () => {
  const result = parseProposal(
    base({ kind: "move", to: "loc-town", observationId: "obs-42" }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(String(result.value.observationId)).toBe("obs-42");
  }
});
