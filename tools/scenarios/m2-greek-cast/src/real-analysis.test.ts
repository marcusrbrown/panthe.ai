import { expect, test } from "bun:test";
import {
  analyzeReal,
  namedIds,
  type RealInput,
  type RealProposal,
  type RealRequest,
} from "./real-analysis";

const event = (
  id: string,
  sequence: number,
  kind: string,
  extra: Record<string, unknown> = {},
) => ({
  schemaVersion: 1,
  id,
  sequence,
  simTime: 0,
  correlationId: `c-${id}`,
  causationId: `c-${id}`,
  approximate: false,
  kind,
  ...extra,
});

const request = (
  proposalId: string | undefined,
  prompt: string,
  extra: Partial<RealRequest> = {},
): RealRequest => ({
  proposalId,
  role: "zeus",
  outcome: "intent",
  elapsedMs: 2000,
  promptPayload: prompt,
  steps: [{ mode: "native" }],
  ...extra,
});

const proposal = (
  proposalId: string,
  actor: string,
  fields: Record<string, unknown>,
  outcome: "committed" | "rejected" = "committed",
  reason?: string,
): RealProposal => ({
  proposalId,
  actor,
  kind: String(fields.kind),
  observationId: `obs-${proposalId}`,
  proposal: { actor, ...fields },
  outcome,
  ...(reason === undefined ? {} : { reason }),
});

const base = (over: Partial<RealInput> = {}): RealInput => ({
  requests: [],
  proposals: [],
  events: [],
  polls: { total: 10, degraded: 0 },
  ...over,
});

const property = (input: RealInput, name: string) =>
  analyzeReal(input).properties.find((p) => p.name === name);

test("namedIds collects every id a proposal names, and none it does not", () => {
  expect(
    namedIds({
      kind: "report",
      listener: "hera",
      content: "words with zeus in them",
      claim: { effect: "harm", agent: "zeus", target: "the-tavern" },
      linkedEventId: "evt-4-2",
    }).sort(),
  ).toEqual(["evt-4-2", "hera", "the-tavern", "zeus"]);
  expect(namedIds({ kind: "move", to: "town-square" })).toEqual([
    "town-square",
  ]);
  expect(namedIds({ kind: "legend", assertion: "nothing named" })).toEqual([]);
});

test("perception compliance holds when every id a proposal names is in the prompt behind it, and fails when one is not", () => {
  const prompt =
    "Here with you:\n- hera (a god)\nWays out:\n- Town [town-square]";
  const ok = base({
    requests: [request("p1", prompt)],
    proposals: [
      proposal("p1", "zeus", {
        kind: "report",
        listener: "hera",
        content: "x",
      }),
    ],
  });
  expect(property(ok, "perception compliance")?.ok).toBe(true);

  const bad = base({
    requests: [request("p1", prompt)],
    proposals: [
      proposal("p1", "zeus", {
        kind: "report",
        listener: "the-woodcutter",
        content: "x",
      }),
    ],
  });
  const result = property(bad, "perception compliance");
  expect(result?.ok).toBe(false);
  expect(result?.detail).toContain("the-woodcutter");
});

test("perception compliance fails, naming the proposal, when a committed proposal has no matching request", () => {
  const prompt = "Here with you:\n- hera (a god)";
  const covered = proposal("p1", "zeus", {
    kind: "report",
    listener: "hera",
    content: "x",
  });
  const uncovered = proposal("p2", "zeus", {
    kind: "report",
    listener: "hera",
    content: "y",
  });
  const result = property(
    base({
      // p1 is covered; a request for some other proposal does not cover p2.
      requests: [request("p1", prompt), request("p9", prompt)],
      proposals: [covered, uncovered],
    }),
    "perception compliance",
  );
  expect(result?.ok).toBe(false);
  expect(result?.detail).toContain("p2");
  expect(result?.detail).not.toContain("p1");
});

test("perception compliance fails, naming the proposal, when its matching request carries no prompt", () => {
  const result = property(
    base({
      requests: [
        request("p1", "- hera (a god)"),
        { ...request("p2", ""), promptPayload: undefined },
      ],
      proposals: [
        proposal("p1", "zeus", { kind: "report", listener: "hera" }),
        proposal("p2", "zeus", { kind: "report", listener: "hera" }),
      ],
    }),
    "perception compliance",
  );
  expect(result?.ok).toBe(false);
  expect(result?.detail).toContain("p2");
  expect(result?.detail).not.toContain("p1");
});

test("valid actions: god actions that were not rejected as malformed", () => {
  const good = base({
    proposals: [proposal("p1", "zeus", { kind: "move", to: "x" })],
  });
  expect(property(good, "valid actions")?.ok).toBe(true);
  // A stale proposal is a race, not an invalid action.
  expect(
    property(
      base({
        proposals: [
          proposal(
            "p1",
            "zeus",
            { kind: "move", to: "x" },
            "rejected",
            "stale-target",
          ),
        ],
      }),
      "valid actions",
    )?.ok,
  ).toBe(true);
  expect(
    property(
      base({
        proposals: [
          proposal("p1", "zeus", { kind: "gather", resource: "wood" }),
        ],
      }),
      "valid actions",
    )?.ok,
  ).toBe(false);
  expect(
    property(
      base({
        proposals: [
          proposal(
            "p1",
            "zeus",
            { kind: "move", to: "x" },
            "rejected",
            "malformed",
          ),
        ],
      }),
      "valid actions",
    )?.ok,
  ).toBe(false);
  // Nothing journaled is not a pass.
  expect(property(base(), "valid actions")?.ok).toBe(false);
});

test("a relationship change with provenance needs the memory and report behind it in the log", () => {
  const events = [
    event("evt-1-1", 1, "report-told", {
      entityId: "zeus",
      listenerId: "hera",
      content: "x",
    }),
    event("evt-1-2", 2, "memory-recorded", {
      memoryKind: "told",
      entityId: "hera",
      sourceEventId: "evt-1-1",
      teller: "zeus",
      content: "x",
      subjects: ["zeus"],
      salience: 4,
    }),
    event("evt-1-3", 3, "relationship-changed", {
      entityId: "hera",
      toward: "zeus",
      affinityDelta: -1,
      grudgeDelta: 0,
      memoryEventId: "evt-1-2",
    }),
  ];
  expect(
    property(base({ events }), "relationship change with provenance")?.ok,
  ).toBe(true);
  // Control: with the memory missing from the log the chain does not explain the change.
  expect(
    property(
      base({ events: events.filter((e) => e.id !== "evt-1-2") }),
      "relationship change with provenance",
    )?.ok,
  ).toBe(false);
  expect(property(base(), "relationship change with provenance")?.ok).toBe(
    false,
  );
});

test("a changed next action: a god's first action after forming a belief differs from the one before it", () => {
  const events = [
    event("evt-1-1", 1, "entity-moved", {
      entityId: "hera",
      from: "a",
      to: "b",
    }),
    event("evt-2-1", 5, "memory-recorded", {
      memoryKind: "told",
      entityId: "hera",
      sourceEventId: "evt-2-0",
      teller: "zeus",
      content: "x",
      subjects: [],
      salience: 4,
    }),
    event("evt-3-1", 9, "legend-recorded", { entityId: "hera" }),
  ];
  const withCorrelation = (
    list: ReturnType<typeof event>[],
    ids: [string, string][],
  ) =>
    list.map((e) => {
      const found = ids.find(([eventId]) => eventId === e.id);
      return found ? { ...e, correlationId: found[1] } : e;
    });
  const changed = base({
    events: withCorrelation(events, [
      ["evt-1-1", "obs-p1"],
      ["evt-3-1", "obs-p2"],
    ]),
    proposals: [
      proposal("p1", "hera", { kind: "move", to: "b" }),
      proposal("p2", "hera", { kind: "legend", assertion: "x" }),
    ].map((p, index) => ({ ...p, observationId: `obs-p${index + 1}` })),
  });
  expect(property(changed, "changed next action")?.ok).toBe(true);

  // Control: the same kind of action before and after is not a change.
  const same = base({
    events: withCorrelation(events, [
      ["evt-1-1", "obs-p1"],
      ["evt-3-1", "obs-p2"],
    ]),
    proposals: [
      proposal("p1", "hera", { kind: "legend", assertion: "a" }),
      proposal("p2", "hera", { kind: "legend", assertion: "a" }),
    ].map((p, index) => ({ ...p, observationId: `obs-p${index + 1}` })),
  });
  expect(property(same, "changed next action")?.ok).toBe(false);
});

test("latency and outcome numbers come from the requests: percentiles, native versus repaired, exhaustion reasons, and time degraded", () => {
  const analysis = analyzeReal(
    base({
      requests: [
        request("p1", "a", { elapsedMs: 1000 }),
        request("p2", "b", { elapsedMs: 3000, steps: [{ mode: "repaired" }] }),
        request(undefined, "c", {
          outcome: "exhausted",
          elapsedMs: 5000,
          steps: [
            {
              reason: "invalid-output",
              detail: "content must be 1 to 280 characters",
            },
          ],
        }),
      ],
      polls: { total: 20, degraded: 5 },
    }),
  );
  expect(analysis.requests).toMatchObject({
    total: 3,
    intent: 2,
    exhausted: 1,
    native: 1,
    repaired: 1,
  });
  expect(analysis.latencyMs.p50).toBe(3000);
  expect(analysis.exhaustion).toEqual([
    {
      reason: "invalid-output",
      detail: "content must be 1 to 280 characters",
      count: 1,
    },
  ]);
  expect(analysis.degradedShare).toBe(0.25);
});
