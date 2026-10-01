// What a god is shown of the prayers addressed to it, and what it may answer
// with: the petitions from world state (the divine sense), the way toward each
// place, the bless option, and why a goal change was refused. The world is real
// (the authored Greek pack, real ticks, the real validator); nothing here mocks
// the rules.

import { expect, test } from "bun:test";
import type {
  EventId,
  GoalChangeRefusedEvent,
  WorldEvent,
} from "@panthea/contracts";
import {
  applyEvent,
  createPrng,
  getActor,
  perceive,
  runTick,
  submitProposal,
  toEntityId,
  type WorldState,
  withActor,
} from "@panthea/world";
import {
  buildGodContext,
  godIntentSchema,
  MAX_PETITIONS_SHOWN,
  rememberedBy,
} from "./context";
import { buildModelProposal } from "./observation";
import { actorAt, godProfile, greekState } from "./test-fixtures";

const id = toEntityId;

/** A world that keeps its events and lets a test stage the causes mortals pray about. */
class Run {
  state: WorldState;
  readonly events: WorldEvent[] = [];
  private n = 0;
  constructor(state: WorldState) {
    this.state = state;
  }
  /** Commits a fixture event as the world would have, so a cause exists. */
  apply(overrides: Record<string, unknown>): WorldEvent {
    this.n += 1;
    const event = {
      schemaVersion: 1,
      id: `evt-${this.state.tick}-${900 + this.n}`,
      sequence: this.state.lastSequence + 1,
      simTime: 0,
      tick: this.state.tick,
      correlationId: "fixture",
      causationId: "fixture",
      approximate: false,
      ...overrides,
    } as unknown as WorldEvent;
    this.state = applyEvent(this.state, event);
    this.events.push(event);
    return event;
  }
  tick(...raws: Record<string, unknown>[]) {
    const proposals = raws.map((raw) => {
      this.n += 1;
      const submitted = submitProposal({
        schemaVersion: 1,
        targets: [],
        expectedRevisions: [],
        source: "fixture",
        observationId: `obs-pc-${this.n}`,
        ...raw,
      });
      if (!submitted.ok) throw new Error(submitted.rejection.message);
      return submitted.proposal;
    });
    const result = runTick(this.state, createPrng(1), proposals);
    this.state = result.state;
    this.events.push(...result.events);
    return result;
  }
  /** `mortal` prays at the altar about a theft by `offender`; returns the petition's id and god. */
  prayAboutTheft(mortal: string, offender: string) {
    const cause = this.apply({
      kind: "theft",
      entityId: offender,
      victim: mortal,
      resource: "food",
      amount: 1,
      cause: "director",
    });
    const placed = getActor(this.state, id(mortal));
    if (!placed) throw new Error(mortal);
    const home = placed.locationId;
    this.state = withActor(this.state, { ...placed, locationId: id("altar") });
    const ran = this.tick({
      actor: mortal,
      kind: "pray",
      cause: cause.id,
      source: "routine",
    });
    expect(ran.rejected).toEqual([]);
    const opened = ran.events.find((e) => e.kind === "petition-opened");
    if (opened?.kind !== "petition-opened") throw new Error("no petition");
    const back = getActor(this.state, id(mortal));
    if (back) this.state = withActor(this.state, { ...back, locationId: home });
    return opened;
  }
  prompt(god: string) {
    const snapshot = perceive(this.state, id(god), []);
    if (!snapshot) throw new Error("no snapshot");
    const remembered = rememberedBy(this.state, id(god));
    const context = buildGodContext(godProfile(god), snapshot, remembered);
    return `${context.instructions}\n${context.prompt}`;
  }
  schema(god: string) {
    const snapshot = perceive(this.state, id(god), []);
    if (!snapshot) throw new Error("no snapshot");
    return godIntentSchema(
      godProfile(god),
      snapshot,
      rememberedBy(this.state, id(god)),
    );
  }
}

const greek = () => new Run(greekState());
const section = (text: string, from: string, to: string) =>
  text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));

test("Hera on Olympus is shown the farmer's punish petition: who asked, the request, the offender and the building, where each is, and the way toward the town square", () => {
  const run = greek();
  const opened = run.prayAboutTheft("farmer", "woodcutter");
  expect(String(opened.god)).toBe("hera");
  expect(opened.request).toMatchObject({
    kind: "punish",
    offender: "woodcutter",
  });
  // Hera stands in the Hall of the Gods; the farmer, the woodcutter and the woodshed are far below.
  const hera = getActor(run.state, id("hera"));
  expect(hera?.locationId).toBe(id("great-hall"));

  const prayers = section(run.prompt("hera"), "Prayers to you", "Ways out");
  expect(prayers).toContain(`[${opened.id}]`);
  expect(prayers).toContain("farmer");
  expect(prayers).toContain("punish woodcutter");
  expect(prayers).toContain("woodshed");
  expect(prayers).toContain("Town Square");
  expect(prayers).toContain(
    "take Gates of Olympus [olympus-gate] toward Town Square",
  );
  // The theft it was about, as the cause.
  expect(prayers).toContain("woodcutter stole food");
});

test("Zeus's prompt never lists a petition addressed to Hera, and Hera's own never lists one addressed to Zeus", () => {
  const run = greek();
  const toHera = run.prayAboutTheft("farmer", "woodcutter");
  expect(String(toHera.god)).toBe("hera");
  expect(run.prompt("zeus")).not.toContain("Prayers to you");
  expect(run.prompt("zeus")).not.toContain(toHera.id);
  // Control: the named god's prompt does.
  expect(run.prompt("hera")).toContain(toHera.id);
  // A second mortal's petition goes to the god with fewer: Zeus. Hera's prompt does not list it.
  const toZeus = run.prayAboutTheft("woodcutter", "farmer");
  expect(String(toZeus.god)).toBe("zeus");
  expect(run.prompt("hera")).not.toContain(toZeus.id);
  expect(run.prompt("zeus")).toContain(toZeus.id);
});

test("an answered or lapsed petition is no longer listed", () => {
  const run = greek();
  const opened = run.prayAboutTheft("farmer", "woodcutter");
  expect(run.prompt("hera")).toContain(opened.id);
  const petition = run.state.petitions.get(opened.id);
  if (!petition) throw new Error("petition");
  run.state = {
    ...run.state,
    petitions: new Map(run.state.petitions).set(opened.id, {
      ...petition,
      status: "answered",
    }),
  };
  expect(run.prompt("hera")).not.toContain("Prayers to you");
});

test("the woodshed becomes a strike target only once it is in the scene: not from Olympus, and yes from the square", () => {
  const run = greek();
  run.prayAboutTheft("farmer", "woodcutter");
  const strikeTargets = (god: string) => {
    const properties = (
      run.schema(god).jsonSchema as {
        properties: Record<string, { enum?: string[] }>;
      }
    ).properties;
    return properties.target?.enum ?? [];
  };
  expect(strikeTargets("hera")).not.toContain("woodshed");
  run.state = actorAt(run.state, "hera", "town-square");
  expect(strikeTargets("hera")).toContain("woodshed");
  // And the prayers section no longer needs a route: she is there.
  expect(
    section(run.prompt("hera"), "Prayers to you", "Ways out"),
  ).not.toContain("take ");
});

test("bless is offered only for a petitioner who is present, naming one of its open help petitions", () => {
  const run = greek();
  // The farmer's tavern was damaged: a help petition for the building.
  const cause = run.apply({
    kind: "building-damaged",
    entityId: "the-tavern",
    amount: 1,
    actor: "zeus",
  });
  const farmer = getActor(run.state, id("farmer"));
  if (!farmer) throw new Error("farmer");
  run.state = withActor(run.state, { ...farmer, locationId: id("altar") });
  const ran = run.tick({
    actor: "farmer",
    kind: "pray",
    cause: cause.id,
    source: "routine",
  });
  const opened = ran.events.find((e) => e.kind === "petition-opened");
  if (opened?.kind !== "petition-opened") throw new Error("no petition");
  expect(opened.request.kind).toBe("help");
  const god = String(opened.god);

  const blessProps = (g: string) => {
    const schema = run.schema(g).jsonSchema as {
      properties: Record<string, { enum?: string[] }>;
    };
    return {
      actions: schema.properties.action?.enum ?? [],
      petitions: schema.properties.petition?.enum,
    };
  };
  // The god is in the hall; the farmer is at the altar: not present, so no bless.
  expect(blessProps(god).actions).not.toContain("bless");
  expect(blessProps(god).petitions).toBeUndefined();
  // The god stands with the farmer: bless is offered, naming that one petition.
  run.state = actorAt(run.state, god, "altar");
  expect(blessProps(god).actions).toContain("bless");
  expect(blessProps(god).petitions).toEqual([opened.id]);
  expect(run.prompt(god)).toContain('action "bless"');
  // A punish petition's petitioner who is present does not get a bless: that is a strike.
  const other = god === "hera" ? "zeus" : "hera";
  expect(blessProps(other).actions).not.toContain("bless");
});

test("a bless intent parses against the offered petitions only, and builds a proposal that pins the petitioner and cites the petition", () => {
  const run = greek();
  const cause = run.apply({
    kind: "building-damaged",
    entityId: "the-tavern",
    amount: 1,
    actor: "zeus",
  });
  const farmer = getActor(run.state, id("farmer"));
  if (!farmer) throw new Error("farmer");
  run.state = withActor(run.state, { ...farmer, locationId: id("altar") });
  const ran = run.tick({
    actor: "farmer",
    kind: "pray",
    cause: cause.id,
    source: "routine",
  });
  const opened = ran.events.find((e) => e.kind === "petition-opened");
  if (opened?.kind !== "petition-opened") throw new Error("no petition");
  const god = String(opened.god);
  run.state = actorAt(run.state, god, "altar");

  const snapshot = perceive(run.state, id(god), []);
  if (!snapshot) throw new Error("snapshot");
  const remembered = rememberedBy(run.state, id(god));
  const schema = godIntentSchema(godProfile(god), snapshot, remembered);
  const parsed = schema.parse({ action: "bless", petition: opened.id });
  expect(parsed.ok).toBe(true);
  expect(schema.parse({ action: "bless", petition: "evt-404" }).ok).toBe(false);
  expect(schema.parse({ action: "bless" }).ok).toBe(false);
  if (!parsed.ok) return;
  const built = buildModelProposal(id(god), snapshot, parsed.value, remembered);
  if (!built.ok || built.kind !== "proposal")
    throw new Error("expected a proposal");
  expect(built.proposal).toMatchObject({
    kind: "bless",
    petition: opened.id,
    targets: ["farmer"],
  });
  expect(built.proposal.expectedRevisions.map((r) => r.entityId)).toContain(
    id("farmer"),
  );
  // The real validator commits it: the farmer is present and the god can pay.
  const committed = runTick(run.state, createPrng(1), [built.proposal]);
  expect(committed.rejected).toEqual([]);
  expect(committed.events.map((e) => e.kind)).toContain("blessing-granted");
});

test("a goal may name anyone a prayer names, though they are not in the scene", () => {
  const run = greek();
  run.prayAboutTheft("farmer", "woodcutter");
  const snapshot = perceive(run.state, id("hera"), []);
  if (!snapshot) throw new Error("snapshot");
  const schema = godIntentSchema(
    godProfile("hera"),
    snapshot,
    rememberedBy(run.state, id("hera")),
  );
  for (const target of ["farmer", "woodcutter", "woodshed"]) {
    expect(
      schema.parse({
        action: "wait",
        goal: { set: { text: "See it done.", target } },
      }).ok,
    ).toBe(true);
  }
  // Control: before any prayer, the farmer is not someone Hera was shown.
  const bare = godIntentSchema(
    godProfile("hera"),
    snapshot,
    rememberedBy(greekState(), id("hera")),
  );
  expect(
    bare.parse({
      action: "wait",
      goal: { set: { text: "See it done.", target: "woodcutter" } },
    }).ok,
  ).toBe(false);
});

// --- The goal gate in the prompt ------------------------------------------------------------------

const refusal = (
  over: Partial<GoalChangeRefusedEvent> = {},
): GoalChangeRefusedEvent =>
  ({
    schemaVersion: 1,
    id: "evt-9-9" as EventId,
    sequence: 9999,
    simTime: 0,
    tick: 5,
    correlationId: "c",
    causationId: "c",
    approximate: false,
    kind: "goal-change-refused",
    entityId: id("hera"),
    reason: "locked",
    attempted: "replace",
    unlocksInTicks: 35,
    ...over,
  }) as GoalChangeRefusedEvent;

test("the prompt states the goal rule instead of promising a new goal ends the old one, and after a refusal says a change was refused, why, and when it unlocks", () => {
  const run = greek();
  run.tick({
    actor: "hera",
    kind: "goal",
    goal: { set: { text: "Win the farmer.", target: "farmer" } },
  });
  const text = run.prompt("hera");
  expect(text).not.toContain("A new goal ends your old one");
  expect(text).toMatch(/goal holds/i);
  expect(text).toContain("achieved");
  expect(text).not.toContain("refused");

  // After a refusal (read from the god's own events by the service), the next prompt says so.
  const snapshot = perceive(run.state, id("hera"), []);
  if (!snapshot) throw new Error("snapshot");
  const remembered = rememberedBy(
    run.state,
    id("hera"),
    [],
    refusal({ sequence: run.state.lastSequence + 1 }),
  );
  const after = buildGodContext(godProfile("hera"), snapshot, remembered);
  const afterText = `${after.instructions}\n${after.prompt}`;
  expect(afterText).toContain(
    "You tried to replace your goal and were refused",
  );
  expect(afterText).toContain("locked");
  expect(afterText).toMatch(/35 more ticks|ticks/);
});

test("a refusal from before the current goal was set is not shown", () => {
  const run = greek();
  run.tick({
    actor: "hera",
    kind: "goal",
    goal: { set: { text: "Win the farmer.", target: "farmer" } },
  });
  const snapshot = perceive(run.state, id("hera"), []);
  if (!snapshot) throw new Error("snapshot");
  const stale = rememberedBy(
    run.state,
    id("hera"),
    [],
    refusal({ sequence: 1 }),
  );
  const text = buildGodContext(godProfile("hera"), snapshot, stale);
  expect(`${text.instructions}\n${text.prompt}`).not.toContain("refused");
  // And with no goal at all there is nothing to have been refused.
  const bare = greek();
  const bareSnapshot = perceive(bare.state, id("hera"), []);
  if (!bareSnapshot) throw new Error("snapshot");
  const none = buildGodContext(
    godProfile("hera"),
    bareSnapshot,
    rememberedBy(bare.state, id("hera"), [], refusal()),
  );
  expect(`${none.instructions}\n${none.prompt}`).not.toContain("refused");
});

// --- Size -------------------------------------------------------------------------------------------

test("the prayers section is bounded: a god with many petitions is shown the oldest few, and with three the whole prompt stays within the 4K budget", () => {
  const run = greek();
  const opened = ["farmer", "woodcutter", "farmer", "woodcutter", "farmer"].map(
    (mortal) => {
      run.state = { ...run.state, tick: run.state.tick + 21 };
      // Each prayer to the same god: fondness for Hera keeps them coming to her.
      const relationships = new Map(run.state.relationships);
      relationships.set(`${mortal}>hera`, {
        from: id(mortal),
        toward: id("hera"),
        affinity: 5,
        grudge: 0,
        allied: false,
      });
      run.state = { ...run.state, relationships };
      const offender = mortal === "farmer" ? "woodcutter" : "farmer";
      return run.prayAboutTheft(mortal, offender);
    },
  );
  expect(new Set(opened.map((o) => String(o.god))).size).toBe(1);
  const text = run.prompt("hera");
  const shown = text.split("\n").filter((line) => /^- \[evt-/.test(line));
  expect(shown).toHaveLength(MAX_PETITIONS_SHOWN);
  expect(shown[0]).toContain(opened[0]?.id as string);
  expect(text).not.toContain(opened.at(-1)?.id as string);
  // Three petitions add a bounded amount to the prompt (measured 1109 characters on the
  // authored world: the prayers section and its one instruction line).
  expect(MAX_PETITIONS_SHOWN).toBe(3);
  const bare = greek().prompt("hera");
  expect(text.length - bare.length).toBeLessThan(1300);
  expect(text.length).toBeLessThan(5600);
});
