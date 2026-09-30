import { expect, test } from "bun:test";
import { analyzeEpisode } from "./episode-analysis";
import { act, identities, input, memoryEvent, move } from "./episode-test-data";
import { analyzeReal } from "./real-analysis";
import {
  buildActions,
  type EpisodeRecord,
  renderSummary,
  renderTranscript,
} from "./transcript";

function record(
  acts: ReturnType<typeof act>[],
  extraEvents: Record<string, unknown>[] = [],
  index = 1,
): EpisodeRecord {
  const data = input(acts, extraEvents);
  return {
    index,
    total: 3,
    settings: {
      model: "llama3.2-3b-4k",
      seconds: 300,
      ranAt: "2026-09-30T12:00:00.000Z",
      ticks: 300,
      hardware: "Apple M1 Pro",
    },
    identities: ["zeus", "hera"].flatMap((god) => {
      const identity = identities.get(god);
      return identity ? [identity] : [];
    }),
    input: data,
    analysis: analyzeReal(data),
    episode: analyzeEpisode(data, identities, ["zeus", "hera"]),
  };
}

const story = () => {
  const report = act(
    "zeus",
    {
      kind: "report",
      listener: "hera",
      content: "I struck the tavern and I regret nothing.",
      claim: { effect: "harm", agent: "zeus" },
    },
    10,
  );
  const belief = memoryEvent("evt-10-11", 11, {
    memoryKind: "told",
    entityId: "hera",
    sourceEventId: report.event.id,
    teller: "zeus",
    content: "I struck the tavern and I regret nothing.",
    consequence: { effect: "harm", agent: "zeus" },
  });
  const change = {
    schemaVersion: 1,
    id: "evt-10-12",
    sequence: 12,
    simTime: 0,
    correlationId: "tick-10",
    causationId: "x",
    approximate: false,
    kind: "relationship-changed",
    entityId: "hera",
    toward: "zeus",
    affinityDelta: -1,
    grudgeDelta: 0,
    memoryEventId: belief.id,
  };
  return record(
    [
      move("zeus", "olympus-gate", 2),
      act("hera", { kind: "legend", assertion: "Hera remembers her vows." }, 5),
      report,
    ],
    [belief, change],
  );
};

test("the transcript opens with the settings and an identity header per god from its profile", () => {
  const text = renderTranscript(story());
  expect(text).toContain("# Episode 1 of 3");
  expect(text).toContain("llama3.2-3b-4k");
  expect(text).toContain("300 s");
  expect(text).toContain("fresh world");
  expect(text).toContain("### Zeus");
  expect(text).toContain("sovereignty 0.9");
  expect(text).toContain("Thunderbolt (strike)");
  expect(text).toContain("### Hera");
  expect(text).toContain("Tale of a Grievance (legend)");
});

test("actions are listed in the order the world applied them, each with tick, god, action and target, backing, and the model's own words", () => {
  const actions = buildActions(story());
  expect(actions.map((a) => `${a.god}:${a.verb}`)).toEqual([
    "zeus:move → olympus-gate",
    "hera:legend",
    "zeus:report → hera",
  ]);
  expect(actions.map((a) => a.backing)).toEqual([
    "context-backed",
    "ability-backed",
    "context-backed",
  ]);
  expect(actions[2]?.text).toBe("I struck the tavern and I regret nothing.");
  expect(actions[2]?.claim).toBe("harm by zeus");
  expect(actions[1]?.text).toBe("Hera remembers her vows.");
  expect(actions[0]?.tick).toBe(2);

  const text = renderTranscript(story());
  const happened = text.slice(
    text.indexOf("## What happened"),
    text.indexOf("## Repetition"),
  );
  const order = ["move → olympus-gate", "legend", "report → hera"].map((s) =>
    happened.indexOf(s),
  );
  expect(order.every((i) => i >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(text).toContain("I struck the tavern and I regret nothing.");
  expect(text).toContain("claim: harm by zeus");
});

test("each action lists the events it caused and the beliefs and feelings that followed from them", () => {
  const report = buildActions(story()).find((a) => a.verb === "report → hera");
  expect(report?.caused).toEqual(["report-told (zeus → hera)"]);
  expect(report?.changes).toEqual([
    'hera now believes zeus: "I struck the tavern and I regret nothing."',
    "hera → zeus: affinity -1",
  ]);
  const text = renderTranscript(story());
  expect(text).toContain("hera → zeus: affinity -1");
  // The move caused no belief or feeling: nothing listed under it.
  const move = buildActions(story()).find((a) => a.verb.startsWith("move"));
  expect(move?.changes).toEqual([]);
});

/** The "## What happened" block split into its numbered action blocks, each with the god named on its first line. */
function actionBlocks(text: string) {
  const happened = text.slice(
    text.indexOf("## What happened"),
    text.indexOf("## Repetition"),
  );
  return happened
    .split(/\n(?=\d+\. \*\*)/)
    .filter((block) => /^\d+\. \*\*/.test(block))
    .map((block) => {
      const head = /^\d+\. \*\*tick (\d+), (\w+):\*\*/.exec(block);
      return { tick: Number(head?.[1]), god: head?.[2], block };
    });
}

const citedStory = () => {
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
  return { zeusMove, heraReport, belief, change };
};

test("a belief caused by Hera's report appears under Hera's line, not under Zeus's action she cited", () => {
  const { zeusMove, heraReport, belief, change } = citedStory();
  const text = renderTranscript(
    record([zeusMove, heraReport], [belief, change]),
  );
  const blocks = actionBlocks(text);
  // The right gods, in the order the world applied them.
  expect(blocks.map((b) => [b.tick, b.god])).toEqual([
    [10, "Zeus"],
    [12, "Hera"],
  ]);
  const [zeus, hera] = blocks;
  expect(hera?.block).toContain(
    'then: farmer now believes hera: "I saw Zeus arrive."',
  );
  expect(hera?.block).toContain("then: farmer → zeus: affinity -1");
  expect(zeus?.block).not.toContain("then:");
  expect(zeus?.block).not.toContain("farmer now believes");
  expect(zeus?.block).not.toContain("affinity");
});

test("control: Zeus's own report puts the belief under Zeus's line, and the rule holds for both gods at once", () => {
  const { zeusMove, heraReport, belief, change } = citedStory();
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
  const text = renderTranscript(
    record([zeusMove, heraReport, zeusReport], [belief, change, zeusBelief]),
  );
  const blocks = actionBlocks(text);
  expect(blocks.map((b) => [b.tick, b.god])).toEqual([
    [10, "Zeus"],
    [12, "Hera"],
    [20, "Zeus"],
  ]);
  expect(blocks[0]?.block).not.toContain("then:");
  expect(blocks[1]?.block).toContain("farmer now believes hera");
  expect(blocks[2]?.block).toContain(
    'then: farmer now believes zeus: "I arrived."',
  );
  expect(blocks[2]?.block).not.toContain("farmer now believes hera");
});

test("a memory of what was witnessed is listed under the action that caused what was seen", () => {
  const strike = act(
    "zeus",
    { kind: "strike", target: "the-tavern", power: 3 },
    20,
  );
  const seen = memoryEvent("evt-20-21", 21, {
    memoryKind: "witnessed",
    entityId: "farmer",
    sourceEventId: strike.event.id,
    eventKind: "entity-moved",
  });
  const actions = buildActions(record([strike], [seen]));
  expect(actions[0]?.changes).toEqual(["farmer remembers entity-moved"]);
});

test("the repetition summary, the automated check table, and a blank rubric follow", () => {
  const text = renderTranscript(story());
  expect(text).toContain("## Repetition");
  expect(text).toContain("longest run");
  expect(text).toContain("| God | Check | Result | Detail |");
  expect(text).toContain("| Zeus | profile trace | pass |");
  expect(text).toContain("| Hera | minimum activity | FAIL |");
  // The rubric: five dimensions, an empty score and notes column, an empty decision.
  for (const dimension of [
    "Novelty",
    "Causality",
    "Recognizable identity",
    "Pacing",
    "Inspectability",
  ]) {
    expect(text).toMatch(new RegExp(`\\| ${dimension} \\| +\\| +\\|`));
  }
  expect(text).toContain(
    "0 = replan pressure, 1 = needs tuning, 2 = good enough to continue",
  );
  expect(text).toContain("Decision: continue / tune / replan:");
  expect(text).toMatch(/Decision: continue \/ tune \/ replan: *$/m);
});

test("the tool never scores: no dimension has a value in the rubric, and no raw prompt is pasted", () => {
  const text = renderTranscript(story());
  const rubric = text.slice(text.indexOf("## Owner rubric"));
  for (const row of rubric
    .split("\n")
    .filter((l) =>
      /^\| (Novelty|Causality|Recognizable|Pacing|Inspectability)/.test(l),
    )) {
    const cells = row.split("|").map((c) => c.trim());
    expect(cells[2]).toBe("");
    expect(cells[3]).toBe("");
  }
  expect(text).not.toContain("You are at");
  expect(text).not.toContain("What do you do?");
});

test("the model run's numbers and properties are in the transcript", () => {
  const text = renderTranscript(story());
  expect(text).toContain("## Model run");
  expect(text).toContain("requests");
  expect(text).toContain("valid actions");
});

test("the summary covers every episode with each god's numbers and checks, and links the transcripts", () => {
  const good = record(
    ["a", "b", "c", "d", "e"].map((to, i) => move("zeus", to, i + 1)),
    [],
    1,
  );
  const bad = record([move("zeus", "a", 1)], [], 2);
  const text = renderSummary([good, bad], {
    seconds: 300,
    model: "llama3.2-3b-4k",
    files: ["episode-1.md", "episode-2.md"],
  });
  expect(text).toContain("# M2 experience gate");
  expect(text).toContain("[episode-1.md](episode-1.md)");
  expect(text).toContain("[episode-2.md](episode-2.md)");
  expect(text).toMatch(/\| 1 \| Zeus \|/);
  expect(text).toMatch(/\| 2 \| Zeus \|/);
  expect(text).toContain("Automated checks failed");
  expect(text).toContain("Decision: continue / tune / replan:");
  // Control: a set that passes every check says none failed.
  const passing = input(
    [
      act("zeus", { kind: "report", listener: "hera", content: "x" }, 1),
      ...["b", "c", "d", "e"].map((to, i) => move("zeus", to, i + 2)),
    ],
    [
      memoryEvent("evt-9-9", 9, {
        memoryKind: "told",
        entityId: "hera",
        sourceEventId: "evt-1-1",
        teller: "zeus",
        content: "x",
      }),
    ],
  );
  const zeus = identities.get("zeus");
  if (!zeus) throw new Error("no zeus");
  const clean = renderSummary(
    [
      {
        ...good,
        identities: [zeus],
        input: passing,
        analysis: analyzeReal(passing),
        episode: analyzeEpisode(passing, identities, ["zeus"]),
      },
    ],
    { seconds: 300, model: "m", files: ["episode-1.md"] },
  );
  expect(clean).toContain("All automated checks held.");
  expect(clean).not.toContain("Automated checks failed");
});
