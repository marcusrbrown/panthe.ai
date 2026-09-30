import { expect, test } from "bun:test";
import {
  analyzeEpisode,
  MIN_ACTIONS,
  REPETITION_CAP,
} from "./episode-analysis";
import { act, identities, input, memoryEvent, move } from "./episode-test-data";

const check = (
  episode: ReturnType<typeof analyzeEpisode>,
  god: string,
  name: string,
) =>
  episode.gods.find((g) => g.god === god)?.checks.find((c) => c.name === name);

test("the thresholds are the owner's: a run of more than 3 fails, and 5 actions are the minimum", () => {
  expect(REPETITION_CAP).toBe(3);
  expect(MIN_ACTIONS).toBe(5);
});

// --- Profile trace ---------------------------------------------------------------

test("profile trace: ability-backed and context-backed actions with a matching request pass, and the split is reported per god", () => {
  const acts = [
    act("zeus", { kind: "strike", target: "the-tavern", power: 3 }, 1),
    act("zeus", { kind: "legend", assertion: "x" }, 2),
    move("zeus", "town-square", 3),
    act("zeus", { kind: "report", listener: "hera", content: "hi" }, 4),
    act("hera", { kind: "legend", assertion: "y" }, 5),
    move("hera", "great-hall", 6),
  ];
  const episode = analyzeEpisode(input(acts), identities, ["zeus", "hera"]);
  expect(check(episode, "zeus", "profile trace")?.ok).toBe(true);
  expect(check(episode, "hera", "profile trace")?.ok).toBe(true);
  const zeus = episode.gods.find((g) => g.god === "zeus");
  expect([zeus?.abilityBacked, zeus?.contextBacked]).toEqual([2, 2]);
  const hera = episode.gods.find((g) => g.god === "hera");
  expect([hera?.abilityBacked, hera?.contextBacked]).toEqual([1, 1]);
  expect(check(episode, "zeus", "profile trace")?.detail).toContain(
    "2 ability-backed, 2 context-backed",
  );
});

test("profile trace fails on an action the profile does not grant, one with no request, one whose request is another role's, a god with no profile, and a foreign kind", () => {
  const run = (a: ReturnType<typeof act>, god = "hera") =>
    check(analyzeEpisode(input([a]), identities, [god]), god, "profile trace");
  // Hera has no strike: not an ability, and strike is not a context action.
  const strike = run(act("hera", { kind: "strike", target: "t", power: 1 }, 1));
  expect(strike?.ok).toBe(false);
  expect(strike?.detail).toContain("strike");
  expect(
    run(act("hera", { kind: "move", to: "x" }, 1, { role: null }))?.ok,
  ).toBe(false);
  expect(
    run(act("hera", { kind: "move", to: "x" }, 1, { role: "zeus" }))?.ok,
  ).toBe(false);
  expect(run(act("hades", { kind: "move", to: "x" }, 1), "hades")?.ok).toBe(
    false,
  );
  expect(run(act("hera", { kind: "gather", resource: "wood" }, 1))?.ok).toBe(
    false,
  );
  // Control: the same actor's ability and context actions with a matching request pass.
  expect(run(act("hera", { kind: "legend", assertion: "x" }, 1))?.ok).toBe(
    true,
  );
  expect(run(act("hera", { kind: "realm-transition", to: "x" }, 1))?.ok).toBe(
    true,
  );
});

test("profile trace judges only committed proposals: a rejected one with no request is not a failure", () => {
  const rejected = act("hera", { kind: "gather", resource: "x" }, 1, {
    role: null,
    outcome: "rejected",
  });
  expect(
    check(
      analyzeEpisode(input([rejected]), identities, ["hera"]),
      "hera",
      "profile trace",
    )?.ok,
  ).toBe(true);
});

// --- Repetition --------------------------------------------------------------------

const repeated = (count: number, to = "olympus-gate") =>
  Array.from({ length: count }, (_, i) => move("zeus", to, i + 1));

test("repetition: three identical choices in a row pass, a fourth fails, and the longest run is reported", () => {
  const three = analyzeEpisode(input(repeated(3)), identities, ["zeus"]);
  expect(check(three, "zeus", "repetition")?.ok).toBe(true);
  expect(three.gods[0]?.longestRun).toEqual({
    length: 3,
    key: "move:olympus-gate",
  });

  const four = analyzeEpisode(input(repeated(4)), identities, ["zeus"]);
  const failed = check(four, "zeus", "repetition");
  expect(failed?.ok).toBe(false);
  expect(failed?.detail).toContain("4");
  expect(failed?.detail).toContain("move:olympus-gate");
});

test("repetition: the key is kind and primary target, and a different choice breaks the run", () => {
  // Same kind, different targets: not a repeat.
  const targets = ["a", "b", "c", "d", "e"].map((to, i) =>
    move("zeus", to, i + 1),
  );
  expect(
    check(
      analyzeEpisode(input(targets), identities, ["zeus"]),
      "zeus",
      "repetition",
    )?.ok,
  ).toBe(true);
  // Same target, different kind: not a repeat.
  const kinds = [
    act("zeus", { kind: "move", to: "x" }, 1),
    act("zeus", { kind: "realm-transition", to: "x" }, 2),
    act("zeus", { kind: "move", to: "x" }, 3),
    act("zeus", { kind: "realm-transition", to: "x" }, 4),
  ];
  expect(
    check(
      analyzeEpisode(input(kinds), identities, ["zeus"]),
      "zeus",
      "repetition",
    )?.ok,
  ).toBe(true);
  // Three, a break, three: the run resets.
  const broken = [
    ...repeated(3),
    move("zeus", "other", 4),
    ...[5, 6, 7].map((sequence) => move("zeus", "olympus-gate", sequence)),
  ];
  const result = analyzeEpisode(input(broken), identities, ["zeus"]);
  expect(check(result, "zeus", "repetition")?.ok).toBe(true);
  expect(result.gods[0]?.longestRun?.length).toBe(3);
});

test("repetition: report keys on the listener, strike on the target, and a legend on its linked event or the word legend", () => {
  const reports = [1, 2, 3, 4].map((i) =>
    act("zeus", { kind: "report", listener: "hera", content: `c${i}` }, i),
  );
  const r = analyzeEpisode(input(reports), identities, ["zeus"]);
  expect(check(r, "zeus", "repetition")?.ok).toBe(false);
  expect(r.gods[0]?.longestRun?.key).toBe("report:hera");

  const strikes = [1, 2, 3, 4].map((i) =>
    act("zeus", { kind: "strike", target: "the-tavern", power: i }, i),
  );
  expect(
    analyzeEpisode(input(strikes), identities, ["zeus"]).gods[0]?.longestRun
      ?.key,
  ).toBe("strike:the-tavern");

  const bare = [1, 2, 3, 4].map((i) =>
    act("zeus", { kind: "legend", assertion: `a${i}` }, i),
  );
  const bareRun = analyzeEpisode(input(bare), identities, ["zeus"]);
  expect(bareRun.gods[0]?.longestRun?.key).toBe("legend:legend");
  expect(check(bareRun, "zeus", "repetition")?.ok).toBe(false);
  // Linked to different events they are different choices.
  const linked = [1, 2, 3, 4].map((i) =>
    act(
      "zeus",
      { kind: "legend", assertion: "a", linkedEventId: `evt-${i}` },
      i,
    ),
  );
  expect(
    check(
      analyzeEpisode(input(linked), identities, ["zeus"]),
      "zeus",
      "repetition",
    )?.ok,
  ).toBe(true);
});

test("repetition orders by the first event each proposal caused, not by the order the journal lists them", () => {
  // Listed a, a, b, a, a, but the events say the b came last: a run of four.
  const acts = [
    move("zeus", "a", 1),
    move("zeus", "a", 2),
    move("zeus", "b", 9),
    move("zeus", "a", 3),
    move("zeus", "a", 4),
  ];
  const result = analyzeEpisode(input(acts), identities, ["zeus"]);
  expect(check(result, "zeus", "repetition")?.ok).toBe(false);
  expect(result.gods[0]?.longestRun?.length).toBe(4);
});

// --- Minimum activity -----------------------------------------------------------------

test("minimum activity: five committed model actions pass, four fail, and rejected ones do not count", () => {
  const five = analyzeEpisode(
    input(["a", "b", "c", "d", "e"].map((to, i) => move("zeus", to, i + 1))),
    identities,
    ["zeus"],
  );
  expect(check(five, "zeus", "minimum activity")?.ok).toBe(true);
  const four = analyzeEpisode(
    input(["a", "b", "c", "d"].map((to, i) => move("zeus", to, i + 1))),
    identities,
    ["zeus"],
  );
  expect(check(four, "zeus", "minimum activity")?.ok).toBe(false);
  const rejected = [
    ...["a", "b", "c", "d"].map((to, i) => move("zeus", to, i + 1)),
    act("zeus", { kind: "move", to: "z" }, 9, { outcome: "rejected" }),
  ];
  expect(
    check(
      analyzeEpisode(input(rejected), identities, ["zeus"]),
      "zeus",
      "minimum activity",
    )?.ok,
  ).toBe(false);
});

// --- Influence -----------------------------------------------------------------------------

test("influence: a told belief caused by the god's own report passes; a belief caused by the other god's report does not count for it", () => {
  const zeusReport = act(
    "zeus",
    { kind: "report", listener: "hera", content: "hi" },
    10,
  );
  const belief = memoryEvent("evt-10-11", 11, {
    memoryKind: "told",
    entityId: "hera",
    sourceEventId: zeusReport.event.id,
    teller: "zeus",
    content: "hi",
  });
  const episode = analyzeEpisode(input([zeusReport], [belief]), identities, [
    "zeus",
    "hera",
  ]);
  expect(check(episode, "zeus", "influence")?.ok).toBe(true);
  // Control: Hera acted (a move) but caused nothing told or felt.
  const heraMove = move("hera", "x", 12);
  const both = analyzeEpisode(
    input([zeusReport, heraMove], [belief]),
    identities,
    ["zeus", "hera"],
  );
  expect(check(both, "zeus", "influence")?.ok).toBe(true);
  expect(check(both, "hera", "influence")?.ok).toBe(false);
});

test("influence is credited to the immediate cause only: Hera reporting a Zeus event she witnessed, citing it, gives Hera the influence and Zeus none", () => {
  const zeusMove = move("zeus", "town-square", 10);
  const heraReport = act(
    "hera",
    {
      kind: "report",
      listener: "farmer",
      content: "I saw Zeus arrive.",
      linkedEventId: zeusMove.event.id,
    },
    12,
  );
  const belief = memoryEvent("evt-12-13", 13, {
    memoryKind: "told",
    entityId: "farmer",
    sourceEventId: heraReport.event.id,
    teller: "hera",
    content: "I saw Zeus arrive.",
  });
  const change = {
    schemaVersion: 1,
    id: "evt-12-14",
    sequence: 14,
    simTime: 0,
    correlationId: "tick-12",
    causationId: "x",
    approximate: false,
    kind: "relationship-changed",
    entityId: "farmer",
    toward: "zeus",
    affinityDelta: -1,
    grudgeDelta: 0,
    memoryEventId: belief.id,
  };
  const episode = analyzeEpisode(
    input([zeusMove, heraReport], [belief, change]),
    identities,
    ["zeus", "hera"],
  );
  // Hera's report caused the belief and, through it, the change.
  expect(check(episode, "hera", "influence")?.ok).toBe(true);
  expect(check(episode, "hera", "influence")?.detail).toContain("2 caused");
  // Zeus's only link is being cited.
  expect(check(episode, "zeus", "influence")?.ok).toBe(false);

  // Control: Zeus's own report causing a belief still counts for him.
  const zeusReport = act(
    "zeus",
    { kind: "report", listener: "farmer", content: "I arrived." },
    20,
  );
  const zeusBelief = memoryEvent("evt-20-21", 21, {
    memoryKind: "told",
    entityId: "farmer",
    sourceEventId: zeusReport.event.id,
    teller: "zeus",
    content: "I arrived.",
  });
  const withOwn = analyzeEpisode(
    input([zeusMove, heraReport, zeusReport], [belief, change, zeusBelief]),
    identities,
    ["zeus", "hera"],
  );
  expect(check(withOwn, "zeus", "influence")?.ok).toBe(true);
  expect(check(withOwn, "zeus", "influence")?.detail).toContain("1 caused");
  expect(check(withOwn, "hera", "influence")?.detail).toContain("2 caused");
});

test("influence: a relationship change counts through the told belief it cites; one that rests on a witnessed memory does not", () => {
  const strike = act(
    "zeus",
    { kind: "strike", target: "the-tavern", power: 3 },
    20,
  );
  const witnessed = memoryEvent("evt-20-21", 21, {
    memoryKind: "witnessed",
    entityId: "farmer",
    sourceEventId: strike.event.id,
    eventKind: "entity-moved",
  });
  const change = (id: string, sequence: number, memoryEventId: string) => ({
    schemaVersion: 1,
    id,
    sequence,
    simTime: 0,
    correlationId: "tick-1",
    causationId: "x",
    approximate: false,
    kind: "relationship-changed",
    entityId: "farmer",
    toward: "zeus",
    affinityDelta: -2,
    grudgeDelta: 1,
    memoryEventId,
  });
  // A witnessed memory alone, and a change resting on it: not influence.
  const alone = analyzeEpisode(input([strike], [witnessed]), identities, [
    "zeus",
  ]);
  expect(check(alone, "zeus", "influence")?.ok).toBe(false);
  const seen = analyzeEpisode(
    input([strike], [witnessed, change("evt-20-22", 22, witnessed.id)]),
    identities,
    ["zeus"],
  );
  expect(check(seen, "zeus", "influence")?.ok).toBe(false);

  // Control: the same change resting on a belief from his own report counts.
  const report = act(
    "zeus",
    { kind: "report", listener: "farmer", content: "I struck it." },
    30,
  );
  const belief = memoryEvent("evt-30-31", 31, {
    memoryKind: "told",
    entityId: "farmer",
    sourceEventId: report.event.id,
    teller: "zeus",
    content: "I struck it.",
  });
  const told = analyzeEpisode(
    input([report], [belief, change("evt-30-32", 32, belief.id)]),
    identities,
    ["zeus"],
  );
  expect(check(told, "zeus", "influence")?.ok).toBe(true);
  expect(check(told, "zeus", "influence")?.detail).toContain(
    "relationship-changed",
  );
});

test("the episode is ok only when every check of every god holds", () => {
  const report = act(
    "zeus",
    { kind: "report", listener: "hera", content: "x" },
    1,
  );
  const good = [
    report,
    ...["b", "c", "d", "e"].map((to, i) => move("zeus", to, i + 2)),
  ];
  const belief = memoryEvent("evt-9-9", 9, {
    memoryKind: "told",
    entityId: "hera",
    sourceEventId: report.event.id,
    teller: "zeus",
    content: "x",
  });
  const ok = analyzeEpisode(input(good, [belief]), identities, ["zeus"]);
  expect(ok.ok).toBe(true);
  const bad = analyzeEpisode(input(good.slice(0, 4), [belief]), identities, [
    "zeus",
  ]);
  expect(bad.ok).toBe(false);
});
