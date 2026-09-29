// The M1 causal story, one step per claim. Each step asserts its invariant
// through `check`/`waitFor`, which throw a `ScenarioFailure` naming it; the
// first one stops the run.

import { Database } from "bun:sqlite";
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createObservationId, parseSyncFrame } from "@panthea/contracts";
import { createProposalId, type FollowResult } from "@panthea/telemetry";
import {
  decode,
  effectiveServices,
  getActor,
  getBuilding,
  toEntityId,
  type WorldState,
} from "@panthea/world";
import { createHeadlessClient, type HeadlessClient } from "./client";
import claimFalse from "./fixtures/claim-false.json";
import legendJournal from "./fixtures/legend-journal.json";
import legendRumor from "./fixtures/legend-rumor.json";
import legendUnknownLink from "./fixtures/legend-unknown-link.json";
import legendVerified from "./fixtures/legend-verified.json";
import malformedAuthority from "./fixtures/malformed-authority.json";
import missingObservation from "./fixtures/missing-observation.json";
import repair from "./fixtures/repair.json";
import staleStrike from "./fixtures/stale-strike.json";
import strike from "./fixtures/strike.json";
import strikeTree from "./fixtures/strike-tree.json";
import worship from "./fixtures/worship.json";
import {
  catchUpIdentity,
  check,
  corruptArchiveBytes,
  createStepRecorder,
  expectedBurnTicks,
  type FixtureValues,
  instantiate,
  type StepResult,
  waitFor,
} from "./helpers";
import {
  buildSidecar,
  killAllSidecars,
  type Sidecar,
  sidecarBinaryPath,
  startSidecar,
} from "./sidecar";
import {
  activeStorePath,
  backdateCursor,
  type EventRow,
  hashEventPrefix,
  integrityCheck,
  operatorObservationExists,
  readCatchUpProgressRow,
  readClockRow,
  readEventRows,
  readJournal,
  readMaxSequence,
  readObservationSources,
  readReceiptsWithKinds,
  slotStorePath,
  withWorldDb,
} from "./world-db";

export type ControlName =
  | "archive"
  | "catch-up"
  | "journal"
  | "bad-proposals"
  | "claim-owner"
  | "pause"
  | "underworld";
export const CONTROL_NAMES: readonly ControlName[] = [
  "archive",
  "catch-up",
  "journal",
  "bad-proposals",
  "claim-owner",
  "pause",
  "underworld",
];

export interface StoryOptions {
  readonly control?: ControlName;
  readonly skipBuild: boolean;
}

export interface StoryResult {
  readonly steps: readonly StepResult[];
  readonly binaryBytes: number;
}

interface Story {
  readonly options: StoryOptions;
  readonly binary: string;
  readonly root: string;
  readonly dataDir: string;
  sidecar: Sidecar;
  readonly clients: HeadlessClient[];
  /** Starts a new sidecar on the same data directory and points every client at it. */
  restart(): Promise<Sidecar>;
  /** Facts one step hands to later ones. */
  readonly memo: {
    tavernInventoryBeforeStrike?: ReadonlyMap<string, number>;
    strikeObservationId?: string;
    strikeProposalId?: string;
    strikeFirstEventId?: string;
    strikeIgnitedEventId?: string;
    strikeSessionId?: string;
    strikeSequence?: number;
    staleObservationId?: string;
    staleProposalId?: string;
    oakDamagedEventId?: string;
    oakObservationId?: string;
    oakSessionId?: string;
    worshipProposalId?: string;
    worshipEventId?: string;
    worshipSessionId?: string;
  };
}

type Recorder = ReturnType<typeof createStepRecorder>;

const FRAME_TIMEOUT_MS = 10_000;
/** How far back the harness moves the wall cursor: a three hour sleep, well past the one-hour catch-up cap. */
const SLEEP_MS = 3 * 60 * 60 * 1000;
const CATCH_UP_CAP_MS = 60 * 60 * 1000;
const CHUNK_TICKS = 60;

// --- Helpers over the running story ---------------------------------------------

async function readFrame(sidecar: Sidecar) {
  const response = await sidecar.request("GET", "/frame");
  check(
    response.status === 200,
    "GET /frame answers",
    `status ${response.status}`,
  );
  const parsed = parseSyncFrame(response.body);
  check(
    parsed.ok,
    "the frame parses through contracts",
    parsed.ok ? "" : `${parsed.path}: ${parsed.message}`,
  );
  const state: WorldState = decode(parsed.value.state);
  return { frame: parsed.value, state };
}

function activeDb<T>(story: Story, fn: (db: Database) => T): T {
  return withWorldDb(activeStorePath(story.dataDir), fn);
}

const clockNow = (story: Story) => activeDb(story, readClockRow);
const maxSequence = (story: Story) => activeDb(story, readMaxSequence);
const eventsOf = (story: Story, fromSequence = 1): EventRow[] =>
  activeDb(story, (db) => readEventRows(db, fromSequence));

async function waitForTicks(
  story: Story,
  count: number,
  why: string,
): Promise<number> {
  const start = clockNow(story).tick;
  return waitFor(
    why,
    () => {
      const tick = clockNow(story).tick;
      return tick >= start + count ? tick : undefined;
    },
    { timeoutMs: 15_000 + count * 1000, intervalMs: 50 },
  );
}

function building(state: WorldState, id: string) {
  const found = getBuilding(state, toEntityId(id));
  check(found !== undefined, `building ${id} exists`, "not in state");
  return found;
}

function actor(state: WorldState, id: string) {
  const found = getActor(state, toEntityId(id));
  check(found !== undefined, `actor ${id} exists`, "not in state");
  return found;
}

const amountOf = (
  inventory: ReadonlyMap<string, number>,
  resource: string,
): number => inventory.get(resource) ?? 0;

const fmt = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

/** Instantiates a fixture against the latest committed frame and posts it under a fresh producer-generated proposal id. */
async function postFixture(
  story: Story,
  template: unknown,
  extra: FixtureValues = {},
  proposalId: string = createProposalId(),
) {
  const { frame } = await readFrame(story.sidecar);
  const observationId = createObservationId();
  const body = instantiate(template, {
    $observationId: observationId,
    $sequence: frame.sequence,
    ...extra,
  });
  const envelope = { proposalId, ...(body as object) } as {
    proposalId: string;
    observation: unknown;
    proposal: unknown;
  };
  const response = await story.sidecar.request("POST", "/proposals", envelope);
  return {
    proposalId,
    observationId,
    envelope,
    status: response.status,
    body: response.body,
  };
}

interface TracedOutcome {
  readonly proposalId: string;
  readonly outcome: "committed" | "rejected";
  readonly reason: string | undefined;
  /** Every event the proposal committed, in order. */
  readonly eventIds: readonly string[];
  readonly steps: FollowResult["steps"];
}

/** The proposal's recorded outcome as `/trace/proposal` reports it, once the tick that took it has committed. */
async function outcomeOf(
  story: Story,
  proposalId: string,
  why: string,
): Promise<TracedOutcome> {
  return waitFor(
    why,
    async () => {
      const response = await story.sidecar.request(
        "GET",
        `/trace/proposal?id=${encodeURIComponent(proposalId)}`,
      );
      if (response.status !== 200) return undefined;
      const { result } = response.body as { result: FollowResult };
      if (!result.found) return undefined;
      const validation = result.steps.find(
        (entry) => entry.step === "validation",
      );
      if (validation?.step !== "validation") return undefined;
      return {
        proposalId,
        outcome: validation.outcome,
        reason: validation.reason,
        eventIds: result.steps.flatMap((entry) =>
          entry.step === "event" ? [entry.eventId] : [],
        ),
        steps: result.steps,
      };
    },
    { timeoutMs: FRAME_TIMEOUT_MS, intervalMs: 100 },
  );
}

/** Whether the service holds any record of `proposalId`: a journal entry or a trace chain. */
async function knowsProposal(story: Story, proposalId: string) {
  const journaled = activeDb(story, readJournal).some(
    (row) => row.proposalId === proposalId,
  );
  const response = await story.sidecar.request(
    "GET",
    `/trace/proposal?id=${encodeURIComponent(proposalId)}`,
  );
  const traced =
    response.status === 200 &&
    (response.body as { result: FollowResult }).result.found;
  return { journaled, traced };
}

async function stopClean(story: Story, why: string): Promise<void> {
  const code = await story.sidecar.stop("SIGTERM");
  check(code === 0, why, `exit code ${code}`);
}

async function waitForLog(
  sidecar: Sidecar,
  text: string,
  why: string,
): Promise<void> {
  await waitFor(why, () => (sidecar.log().includes(text) ? true : undefined), {
    timeoutMs: 60_000,
    intervalMs: 20,
  });
}

async function getJson(sidecar: Sidecar, path: string) {
  const response = await sidecar.request("GET", path);
  check(
    response.status === 200,
    `GET ${path.split("?")[0]} answers`,
    `status ${response.status} ${fmt(response.body)}`,
  );
  return response.body as { ok: boolean; result: FollowResult };
}

// --- Story ------------------------------------------------------------------------

export async function runStory(
  options: StoryOptions,
  onStep: (step: StepResult) => void,
): Promise<StoryResult> {
  const recorder = createStepRecorder(onStep);
  const binary = options.skipBuild ? sidecarBinaryPath() : buildSidecar();
  const binaryBytes = Bun.file(binary).size;
  const root = mkdtempSync(join(tmpdir(), "panthea-m1-"));
  const dataDir = join(root, "app-data");
  // Everything from here on is cleaned up by the `finally`, including a
  // first sidecar that fails to start.
  let story: Story | undefined;
  try {
    const first = await startSidecar(binary, dataDir);
    const running: Story = {
      options,
      binary,
      root,
      dataDir,
      sidecar: first,
      clients: [],
      memo: {},
      async restart() {
        const next = await startSidecar(binary, dataDir);
        running.sidecar = next;
        for (const client of running.clients) client.attach(next);
        return next;
      },
    };
    story = running;
    await stepSeed(recorder, running);
    await stepUnattended(recorder, running);
    await stepTreeStrike(recorder, running);
    await stepStrike(recorder, running);
    await stepFire(recorder, running);
    await stepLostService(recorder, running);
    await stepRepair(recorder, running);
    await stepWorship(recorder, running);
    await stepLegends(recorder, running);
    await stepBadProposals(recorder, running);
    await stepPauseAcrossRestart(recorder, running);
    await stepJournalKill(recorder, running);
    await stepKillMidCatchUp(recorder, running);
    await stepArchives(recorder, running);
    await stepClientReceipts(recorder, running);
    await stepTrace(recorder, running);
    return { steps: recorder.results, binaryBytes };
  } finally {
    for (const client of story?.clients ?? []) client.stop();
    await story?.sidecar.stop("SIGTERM").catch(() => undefined);
    killAllSidecars();
    rmSync(root, { recursive: true, force: true });
  }
}

async function stepSeed(recorder: Recorder, story: Story): Promise<void> {
  await recorder.run(
    "S1",
    "Seed",
    "A fresh data directory loads the authored Greek world across three realms with nothing committed yet, and its first frame carries no catch-up summary.",
    async (step) => {
      await waitForLog(
        story.sidecar,
        "startup catch-up complete",
        "the startup catch-up of the fresh world finishes",
      );
      const { frame, state } = await readFrame(story.sidecar);
      check(
        frame.catchUpSummary === undefined,
        "a fresh world's first frame has no catch-up summary",
        fmt(frame.catchUpSummary),
      );
      const locations = [...state.locations.values()];
      const realms = Object.fromEntries(
        [...new Set(locations.map((location) => location.realm))].map(
          (realm) => [
            realm,
            locations.filter((location) => location.realm === realm).length,
          ],
        ),
      );
      check(
        Object.keys(realms).sort().join() === "mortal,olympus,underworld",
        "the seed spans mortal, olympus, and underworld",
        fmt(realms),
      );
      for (const id of ["woodcutter", "farmer", "zeus"]) actor(state, id);
      for (const id of ["agora-shop", "the-tavern", "old-oak"]) {
        check(
          building(state, id).status === "operational",
          `${id} starts operational`,
          building(state, id).status,
        );
      }
      check(
        effectiveServices(building(state, "the-tavern")).join() === "drink",
        "the tavern offers its authored service while operational",
        fmt(effectiveServices(building(state, "the-tavern"))),
      );
      check(
        amountOf(actor(state, "zeus").inventory, "divinity") === 10,
        "zeus starts with 10 divinity",
        fmt([...actor(state, "zeus").inventory]),
      );
      check(
        frame.status === "running",
        "the fresh world is running",
        frame.status,
      );
      check(
        frame.sequence === 0 && maxSequence(story) === 0,
        "nothing is committed at seed",
        `frame ${frame.sequence}, log ${maxSequence(story)}`,
      );

      // The client follows the farmer, in the mortal realm, for the rest of the run.
      story.clients.push(
        createHeadlessClient({ kind: "actor", id: "farmer" }, story.sidecar),
      );

      step.done(
        `${state.locations.size} locations (${Object.entries(realms)
          .map(([realm, n]) => `${realm} ${n}`)
          .join(
            ", ",
          )}), ${state.actors.size} actors, ${state.buildings.size} buildings, sequence ${frame.sequence}; first frame has no catch-up summary`,
        [
          {
            name: "seed locations",
            unit: "count",
            value: state.locations.size,
          },
          { name: "seed actors", unit: "count", value: state.actors.size },
          {
            name: "seed buildings",
            unit: "count",
            value: state.buildings.size,
          },
        ],
      );
    },
  );
}

async function stepUnattended(recorder: Recorder, story: Story): Promise<void> {
  await recorder.run(
    "S2",
    "Unattended routines",
    "With no external input, routines commit events every tick, and every observation on record is a routine's.",
    async (step) => {
      const tickBefore = clockNow(story).tick;
      const seqBefore = maxSequence(story);
      const tick = await waitForTicks(
        story,
        8,
        "eight ticks pass with no external input",
      );
      const events = eventsOf(story);
      const kinds = new Set(events.map((event) => event.kind));
      const sources = activeDb(story, readObservationSources);
      const added = maxSequence(story) - seqBefore;
      check(added > 0, "the event log grows unattended", "no new events");
      check(
        kinds.has("resource-gathered") && kinds.has("income-earned"),
        "routines gather and buildings earn income unattended",
        fmt([...kinds]),
      );
      check(
        Object.keys(sources).join() === "routine",
        "only routines have made observations so far",
        fmt(sources),
      );
      step.done(
        `${tick - tickBefore} ticks, ${added} events, kinds ${[...kinds].sort().join(", ")}; observations by source ${fmt(sources)}`,
        [{ name: "unattended events", unit: "count", value: added }],
      );
    },
  );
}

async function stepTreeStrike(recorder: Recorder, story: Story): Promise<void> {
  await recorder.run(
    "S3",
    "Strike a tree",
    "A fixture strike below the ignition threshold damages the old oak, a tree: the committed events are a divinity spend and a building-damaged event on the oak, both caused by the strike's observation and walkable through the trace; the oak's status changes from operational to damaged in world state, and it is not burning.",
    async (step) => {
      const before = (await readFrame(story.sidecar)).state;
      const oak = building(before, "old-oak");
      const zeusBefore = amountOf(actor(before, "zeus").inventory, "divinity");
      const threshold = before.rules.fireBalance.igniteThreshold ?? 0;
      const power = 1;
      check(
        oak.status === "operational" && oak.combustible && power < threshold,
        "the oak starts operational and combustible, and the strike is below the ignition threshold",
        `${oak.status}, combustible ${oak.combustible}, power ${power}, threshold ${threshold}`,
      );

      const posted = await postFixture(story, strikeTree, {
        "$revision:old-oak": oak.revision,
      });
      check(
        posted.status === 202,
        "the tree strike is accepted",
        `${posted.status} ${fmt(posted.body)}`,
      );
      const outcome = await outcomeOf(
        story,
        posted.proposalId,
        "the tree strike's outcome is recorded in the trace",
      );
      check(
        outcome.outcome === "committed",
        "the tree strike commits",
        `${outcome.outcome} ${outcome.reason}`,
      );
      const caused = eventsOf(story).filter(
        (event) => event.correlationId === posted.observationId,
      );
      check(
        caused.map((event) => event.kind).join() ===
          "resource-consumed,building-damaged",
        "the strike's observation caused exactly a divinity spend and damage",
        caused.map((event) => event.kind).join(),
      );
      const [spend, damaged] = caused;
      check(
        spend !== undefined &&
          damaged !== undefined &&
          outcome.eventIds.join() === [spend.id, damaged.id].join(),
        "the trace lists both events the strike committed, in order",
        outcome.eventIds.join(),
      );
      check(
        spend.payload.resource === "divinity" && spend.payload.amount === power,
        `the strike spends ${power} divinity`,
        fmt(spend.payload),
      );
      check(
        damaged.payload.entityId === "old-oak" &&
          damaged.payload.amount === power,
        "the damage names the old oak and the strike's power",
        fmt(damaged.payload),
      );

      const chain = (
        await getJson(
          story.sidecar,
          `/trace/event?id=${encodeURIComponent(damaged.id)}`,
        )
      ).result.steps;
      const [observation, proposal, validation, event, projection] = chain;
      check(
        observation?.step === "observation" &&
          observation.record.id === posted.observationId &&
          observation.record.source === "fixture" &&
          proposal?.step === "proposal" &&
          proposal.proposalId === posted.proposalId &&
          proposal.record.kind === "strike" &&
          proposal.record.target === "old-oak" &&
          validation?.step === "validation" &&
          validation.outcome === "committed" &&
          event?.step === "event" &&
          event.eventId === damaged.id &&
          projection?.step === "projection-change" &&
          projection.revision === damaged.sequence,
        "the damage traces to the tree strike: observation, proposal, validation, event, projection change",
        chain.map((entry) => entry.step).join(" -> "),
      );

      const after = await waitFor(
        "the damage appears in the committed frame",
        async () => {
          const latest = await readFrame(story.sidecar);
          return latest.frame.sequence >= damaged.sequence ? latest : undefined;
        },
        { timeoutMs: 5000, intervalMs: 50 },
      );
      const oakAfter = building(after.state, "old-oak");
      check(
        oakAfter.status === "damaged" &&
          oakAfter.revision === oak.revision + 1 &&
          oakAfter.fireIntensity === undefined,
        "the oak is damaged, not burning, and its revision advanced by the strike",
        fmt([oakAfter.status, oakAfter.revision, oakAfter.fireIntensity]),
      );
      const zeusAfter = amountOf(
        actor(after.state, "zeus").inventory,
        "divinity",
      );
      check(
        zeusAfter === zeusBefore - power,
        "zeus's divinity dropped by exactly the power spent",
        `${zeusBefore} -> ${zeusAfter}`,
      );

      story.memo.oakDamagedEventId = damaged.id;
      story.memo.oakObservationId = posted.observationId;
      story.memo.oakSessionId = after.frame.sessionId;
      step.done(
        `strike of power ${power} (ignition threshold ${threshold}) at sequences ${spend.sequence}-${damaged.sequence}: old oak ${oak.status} -> ${oakAfter.status} (revision ${oak.revision} -> ${oakAfter.revision}); divinity ${zeusBefore} -> ${zeusAfter}; trace chain ${chain.map((entry) => entry.step).join(" -> ")}`,
        [
          { name: "divinity spent", unit: "divinity", value: power },
          {
            name: "oak revision change",
            unit: "revisions",
            value: oakAfter.revision - oak.revision,
          },
        ],
      );
    },
  );
}

async function stepStrike(recorder: Recorder, story: Story): Promise<void> {
  await recorder.run(
    "S4",
    "Strike",
    "A deity's fixture strike commits through the validator: divinity is spent and the combustible tavern ignites, both caused by the strike's observation.",
    async (step) => {
      const { state } = await readFrame(story.sidecar);
      const tavern = building(state, "the-tavern");
      const zeusBefore = amountOf(actor(state, "zeus").inventory, "divinity");
      story.memo.tavernInventoryBeforeStrike = new Map(tavern.inventory);
      const priorIncome = eventsOf(story).filter(
        (event) =>
          event.kind === "income-earned" &&
          event.payload.buildingId === "the-tavern",
      ).length;
      check(
        priorIncome > 0,
        "the operational tavern earned income before the strike",
        `${priorIncome}`,
      );

      const posted = await postFixture(story, strike, {
        "$revision:the-tavern": tavern.revision,
      });
      check(
        posted.status === 202,
        "the strike fixture is accepted for the next tick",
        `${posted.status} ${fmt(posted.body)}`,
      );
      const outcome = await outcomeOf(
        story,
        posted.proposalId,
        "the strike's outcome is recorded in the trace",
      );
      check(
        outcome.outcome === "committed",
        "the strike commits",
        `${outcome.outcome} ${outcome.reason}`,
      );

      const caused = eventsOf(story).filter(
        (event) => event.correlationId === posted.observationId,
      );
      check(
        caused.map((event) => event.kind).join() ===
          "resource-consumed,building-ignited",
        "the strike's observation caused exactly a divinity spend and an ignition",
        caused.map((event) => event.kind).join(),
      );
      const [spend, ignited] = caused;
      check(
        spend !== undefined &&
          ignited !== undefined &&
          outcome.eventIds.join() === [spend.id, ignited.id].join(),
        "the trace lists every event the strike committed, in order",
        outcome.eventIds.join(),
      );
      check(
        spend.payload.resource === "divinity" && spend.payload.amount === 3,
        "the strike spends 3 divinity",
        fmt(spend.payload),
      );
      check(
        ignited.payload.entityId === "the-tavern",
        "the ignition names the tavern",
        fmt(ignited.payload),
      );

      const burning = await waitFor(
        "the tavern is observed burning",
        async () => {
          const latest = await readFrame(story.sidecar);
          const now = building(latest.state, "the-tavern");
          return now.status === "burning" ? { latest, now } : undefined;
        },
        { timeoutMs: 8000, intervalMs: 50 },
      );
      const zeusAfter = amountOf(
        actor(burning.latest.state, "zeus").inventory,
        "divinity",
      );
      check(
        zeusAfter === zeusBefore - 3,
        "zeus's divinity dropped by exactly the power spent",
        `${zeusBefore} -> ${zeusAfter}`,
      );

      story.memo.strikeObservationId = posted.observationId;
      story.memo.strikeProposalId = posted.proposalId;
      story.memo.strikeFirstEventId = spend.id;
      story.memo.strikeIgnitedEventId = ignited.id;
      story.memo.strikeSessionId = burning.latest.frame.sessionId;
      story.memo.strikeSequence = ignited.sequence;
      step.done(
        `strike committed at sequences ${spend.sequence}-${ignited.sequence}; divinity ${zeusBefore} -> ${zeusAfter}; tavern burning at intensity ${burning.now.fireIntensity ?? "?"}`,
        [
          {
            name: "divinity spent",
            unit: "divinity",
            value: zeusBefore - zeusAfter,
          },
        ],
      );
    },
  );
}

async function stepFire(recorder: Recorder, story: Story): Promise<void> {
  await recorder.run(
    "S5",
    "Fire",
    "Fire burns on its own after ignition for the authored number of ticks, destroys the tavern, and disposes its goods through a declared sink; a non-combustible building never ignites.",
    async (step) => {
      const ignitedSequence = story.memo.strikeSequence ?? 0;
      const destroyed = await waitFor(
        "the tavern is destroyed by fire",
        () =>
          eventsOf(story, ignitedSequence).find(
            (event) =>
              event.kind === "building-destroyed" &&
              event.payload.entityId === "the-tavern",
          ),
        { timeoutMs: 20_000, intervalMs: 100 },
      );
      const { state } = await readFrame(story.sidecar);
      const rules = state.rules.fireBalance;
      const growth = rules.intensityGrowthPerTick ?? 1;
      const burnTicks = eventsOf(story, ignitedSequence).filter(
        (event) =>
          event.kind === "building-burn-ticked" &&
          event.payload.entityId === "the-tavern" &&
          event.sequence < destroyed.sequence,
      );
      const expected = expectedBurnTicks(rules.destroyIntensity ?? 3, growth);
      check(
        burnTicks.length === expected,
        "the fire burns for the authored number of ticks",
        `${burnTicks.length} burn ticks, expected ${expected}`,
      );
      const intensities = burnTicks.map((event) => event.payload.fireIntensity);
      check(
        intensities.every((value, index) => value === (index + 1) * growth),
        "burn intensity grows by the authored rate",
        fmt(intensities),
      );
      const disposed = destroyed.payload.disposedInventory as {
        resource: string;
        amount: number;
      }[];
      const before =
        story.memo.tavernInventoryBeforeStrike ?? new Map<string, number>();
      check(
        disposed.length === before.size &&
          disposed.every((line) => before.get(line.resource) === line.amount),
        "the goods lost in the fire are exactly the tavern's inventory (a declared sink)",
        `${fmt(disposed)} vs ${fmt([...before])}`,
      );
      const tavern = building(state, "the-tavern");
      check(
        tavern.status === "destroyed" && tavern.inventory.size === 0,
        "the destroyed tavern holds nothing",
        `${tavern.status} ${fmt([...tavern.inventory])}`,
      );
      check(
        building(state, "agora-shop").status === "operational",
        "the non-combustible shop never ignites",
        building(state, "agora-shop").status,
      );
      const ticksToDestroy = burnTicks.length + 1;
      step.done(
        `${burnTicks.length} burn ticks then destroyed at sequence ${destroyed.sequence} (${ticksToDestroy} ticks after ignition); disposed ${fmt(disposed)}; shop ${building(state, "agora-shop").status}; old oak ${building(state, "old-oak").status}`,
        [
          {
            name: "ticks from ignition to destruction",
            unit: "ticks",
            value: ticksToDestroy,
          },
        ],
      );
    },
  );
}

async function stepLostService(
  recorder: Recorder,
  story: Story,
): Promise<void> {
  await recorder.run(
    "S6",
    "Lost service",
    "A burning and then destroyed tavern offers no services and earns no income while the untouched shop keeps earning. The operator pauses the world once the tavern is down.",
    async (step) => {
      const paused = await story.sidecar.request("POST", "/pause");
      check(
        paused.status === 200,
        "POST /pause answers",
        `${paused.status} ${fmt(paused.body)}`,
      );
      await waitFor(
        "the frame reports paused",
        async () =>
          (await readFrame(story.sidecar)).frame.status === "paused"
            ? true
            : undefined,
        { timeoutMs: 5000, intervalMs: 50 },
      );
      const { state } = await readFrame(story.sidecar);
      const tavern = building(state, "the-tavern");
      check(
        tavern.services.join() === "drink",
        "the tavern's authored services survive destruction",
        fmt(tavern.services),
      );
      check(
        ["destroyed", "repairing"].includes(tavern.status),
        "the tavern is down when the world is paused",
        tavern.status,
      );
      check(
        effectiveServices(tavern).length === 0,
        "a destroyed tavern offers no services",
        fmt(effectiveServices(tavern)),
      );

      // From ignition to destruction the tavern never earned, and the shop did.
      const ignitedSequence = story.memo.strikeSequence ?? 0;
      const destroyed = eventsOf(story, ignitedSequence).find(
        (event) =>
          event.kind === "building-destroyed" &&
          event.payload.entityId === "the-tavern",
      );
      check(
        destroyed !== undefined,
        "the destruction is on record",
        "no building-destroyed event",
      );
      const fireWindow = eventsOf(story, ignitedSequence).filter(
        (event) =>
          event.kind === "income-earned" &&
          event.sequence <= destroyed.sequence,
      );
      const tavernIncome = fireWindow.filter(
        (event) => event.payload.buildingId === "the-tavern",
      ).length;
      const shopIncome = fireWindow.filter(
        (event) => event.payload.buildingId === "agora-shop",
      ).length;
      check(
        tavernIncome === 0,
        "a burning tavern earns no income",
        `${tavernIncome} income events`,
      );
      check(
        shopIncome > 0,
        "the untouched shop kept earning through the fire",
        `${shopIncome} income events`,
      );
      step.done(
        `world paused with the tavern ${tavern.status}: services ${fmt(effectiveServices(tavern))} of authored ${fmt(tavern.services)}; from ignition to destruction tavern income events ${tavernIncome}, shop ${shopIncome}`,
        [
          {
            name: "tavern income events during the fire",
            unit: "count",
            value: tavernIncome,
          },
          {
            name: "shop income events during the fire",
            unit: "count",
            value: shopIncome,
          },
        ],
      );
    },
  );
}

async function stepRepair(recorder: Recorder, story: Story): Promise<void> {
  await recorder.run(
    "S7",
    "Repair",
    "A fixture repair by an actor holding planks, accepted while the world is paused, stays pending until ticking resumes and then commits, taking the actor's slot from its routine. Repair spends exactly the authored cost in planks; service and income return and the goods lost in the fire stay lost.",
    async (step) => {
      const destroyedAt = eventsOf(story).find(
        (event) =>
          event.kind === "building-destroyed" &&
          event.payload.entityId === "the-tavern",
      );
      check(
        destroyedAt !== undefined,
        "the destruction is on record before repair starts",
        "no building-destroyed event",
      );

      // The world is paused, so who holds planks is frozen while the fixture is chosen.
      let repairer: string | undefined;
      for (
        let attempt = 1;
        attempt <= 12 && repairer === undefined;
        attempt += 1
      ) {
        const { state } = await readFrame(story.sidecar);
        check(
          ["destroyed", "repairing"].includes(
            building(state, "the-tavern").status,
          ),
          "the tavern still needs repair",
          building(state, "the-tavern").status,
        );
        repairer = ["farmer", "woodcutter"].find(
          (id) => amountOf(actor(state, id).inventory, "planks") >= 1,
        );
        if (repairer === undefined) {
          await story.sidecar.request("POST", "/resume");
          await waitForTicks(
            story,
            1,
            "a tick passes while nobody holds planks",
          );
          await story.sidecar.request("POST", "/pause");
        }
      }
      check(
        repairer !== undefined,
        "some actor holds planks to repair with",
        "none within 12 ticks",
      );

      const tickWhilePaused = clockNow(story).tick;
      const posted = await postFixture(story, repair, { $actor: repairer });
      check(
        posted.status === 202 &&
          (posted.body as { status?: string }).status === "pending",
        "the repair fixture is accepted as pending",
        `${posted.status} ${fmt(posted.body)}`,
      );
      await Bun.sleep(1500);
      const retryWhilePaused = await story.sidecar.request(
        "POST",
        "/proposals",
        posted.envelope,
      );
      check(
        clockNow(story).tick === tickWhilePaused &&
          (retryWhilePaused.body as { status?: string }).status === "pending",
        "a proposal accepted while paused stays pending: no tick, and a retry reports pending",
        `tick ${clockNow(story).tick} vs ${tickWhilePaused}, ${fmt(retryWhilePaused.body)}`,
      );

      const resumed = await story.sidecar.request("POST", "/resume");
      check(
        resumed.status === 200,
        "POST /resume answers",
        `${resumed.status} ${fmt(resumed.body)}`,
      );
      const outcome = await outcomeOf(
        story,
        posted.proposalId,
        "the fixture repair's outcome is recorded once ticking resumes",
      );
      check(
        outcome.outcome === "committed",
        "a fixture repair by an actor holding planks commits (its routine yielded the slot)",
        `${outcome.outcome} ${outcome.reason}`,
      );
      const fixtureEvents = eventsOf(story).filter(
        (event) => event.correlationId === posted.observationId,
      );
      check(
        fixtureEvents[0]?.kind === "repair-progressed" &&
          fixtureEvents[0].payload.entityId === repairer,
        "the fixture's repair step is by the actor it named",
        fixtureEvents.map((event) => event.kind).join(),
      );
      const sameTickByRoutine = eventsOf(story).filter(
        (event) =>
          event.payload.simTime === fixtureEvents[0]?.payload.simTime &&
          event.payload.entityId === repairer &&
          event.correlationId !== posted.observationId &&
          !event.correlationId.startsWith("tick-"),
      );
      check(
        sameTickByRoutine.length === 0,
        "the repairer's routine did not also act in that tick",
        sameTickByRoutine.map((event) => event.kind).join(),
      );

      const repaired = await waitFor(
        "the tavern is repaired",
        () =>
          eventsOf(story, destroyedAt.sequence).find(
            (event) =>
              event.kind === "building-repaired" &&
              event.payload.entityId === "the-tavern",
          ),
        { timeoutMs: 40_000, intervalMs: 100 },
      );
      const { state } = await readFrame(story.sidecar);
      const cost = state.rules.economyBalance.repairCostPlanks ?? 0;
      const progress = eventsOf(story, destroyedAt.sequence).filter(
        (event) =>
          event.kind === "repair-progressed" &&
          event.payload.structureId === "the-tavern" &&
          event.sequence < repaired.sequence,
      );
      const spent = progress.reduce(
        (sum, event) => sum + (event.payload.amount as number),
        0,
      );
      check(
        progress.every((event) => event.payload.resource === "planks"),
        "repair spends only planks",
        fmt(progress.map((event) => event.payload.resource)),
      );
      check(
        progress.some((event) => event.correlationId === posted.observationId),
        "the fixture contributed repair progress",
        "no fixture progress found",
      );
      check(
        spent === cost,
        "repair spends exactly the authored cost",
        `${spent} planks spent, cost ${cost}`,
      );
      const repairedEvents = eventsOf(story, destroyedAt.sequence).filter(
        (event) =>
          event.kind === "building-repaired" &&
          event.payload.entityId === "the-tavern",
      );
      check(
        repairedEvents.length === 1,
        "the tavern is repaired exactly once",
        `${repairedEvents.length}`,
      );
      const tavern = building(state, "the-tavern");
      check(
        tavern.status === "operational",
        "the repaired tavern is operational",
        tavern.status,
      );
      check(
        effectiveServices(tavern).join() === "drink",
        "the repaired tavern offers its service again",
        fmt(effectiveServices(tavern)),
      );
      check(
        tavern.inventory.size === 0,
        "the goods lost in the fire stay lost",
        fmt([...tavern.inventory]),
      );
      await waitFor(
        "the repaired tavern earns income again",
        () =>
          eventsOf(story, repaired.sequence).find(
            (event) =>
              event.kind === "income-earned" &&
              event.payload.buildingId === "the-tavern",
          ),
        { timeoutMs: 10_000, intervalMs: 100 },
      );
      const ticksDown =
        Math.round((repaired.payload.simTime as number) / 1000) -
        Math.round((destroyedAt.payload.simTime as number) / 1000);
      step.done(
        `${progress.length} repair steps spent ${spent} planks (cost ${cost}); the fixture repair by ${repairer} was accepted while paused, stayed pending through 1.5 s with no tick (a retry reported pending), and committed once resumed; tavern operational again ${ticksDown} ticks after destruction`,
        [
          { name: "planks spent on repair", unit: "planks", value: spent },
          {
            name: "ticks from destruction to repair",
            unit: "ticks",
            value: ticksDown,
          },
        ],
      );
    },
  );
}

async function stepWorship(recorder: Recorder, story: Story): Promise<void> {
  await recorder.run(
    "S8",
    "Worship and favor",
    "A fixture worship by a mortal with a routine commits (its routine yields the slot): the deity's divinity rises by the authored gain, the worshiper holds a favor with its source and duration, the favor raises the worshiper's gather yield while it lasts, and the yield returns to normal once it expires.",
    async (step) => {
      const before = (await readFrame(story.sidecar)).state;
      const divinityBefore = amountOf(
        actor(before, "zeus").inventory,
        "divinity",
      );

      const posted = await postFixture(story, worship);
      check(
        posted.status === 202,
        "the worship fixture is accepted",
        `${posted.status} ${fmt(posted.body)}`,
      );
      const outcome = await outcomeOf(
        story,
        posted.proposalId,
        "the worship outcome is recorded",
      );
      check(
        outcome.outcome === "committed",
        "a fixture worship by an actor with a routine commits",
        `${outcome.outcome} ${outcome.reason}`,
      );
      const caused = eventsOf(story).filter(
        (event) => event.correlationId === posted.observationId,
      );
      check(
        caused.map((event) => event.kind).join() === "worship-performed",
        "worship commits exactly one worship event",
        caused.map((event) => event.kind).join(),
      );
      const [performed] = caused;
      check(
        performed !== undefined && outcome.eventIds[0] === performed.id,
        "the trace lists the worship event",
        outcome.eventIds.join(),
      );
      const worshipTick = Math.round(
        (performed.payload.simTime as number) / 1000,
      );
      const routineSameTick = eventsOf(story).filter(
        (event) =>
          event.payload.simTime === performed.payload.simTime &&
          event.payload.entityId === "woodcutter" &&
          event.correlationId !== posted.observationId &&
          !event.correlationId.startsWith("tick-"),
      );
      check(
        routineSameTick.length === 0,
        "the woodcutter's routine yielded that tick",
        routineSameTick.map((event) => event.kind).join(),
      );

      const after = await waitFor(
        "the worship appears in the committed frame",
        async () => {
          const latest = await readFrame(story.sidecar);
          return latest.frame.sequence >= performed.sequence
            ? latest
            : undefined;
        },
        { timeoutMs: 5000, intervalMs: 50 },
      );
      const economy = after.state.rules.economyBalance;
      const gain = economy.worshipCapacityGain ?? 1;
      const duration = economy.favorDurationTicks ?? 0;
      const bonus = economy.favorGatherBonus ?? 0;
      const base = economy.gatherAmount ?? 0;
      const divinityAfter = amountOf(
        actor(after.state, "zeus").inventory,
        "divinity",
      );
      check(
        divinityAfter === divinityBefore + gain,
        "worship raises the deity's divinity by the authored gain",
        `${divinityBefore} -> ${divinityAfter}, gain ${gain}`,
      );
      const expiresAt = performed.payload.favorExpiresAtTick as number;
      check(
        expiresAt - worshipTick === duration,
        "the favor lasts the authored duration",
        `expires ${expiresAt}, granted at tick ${worshipTick}, duration ${duration}`,
      );
      const favor = (actor(after.state, "woodcutter").favors ?? []).find(
        (candidate) => candidate.expiresAtTick === expiresAt,
      );
      check(
        favor !== undefined &&
          favor.source === "zeus" &&
          favor.effect === "divine-favor",
        "the worshiper holds the favor with zeus as its source",
        fmt(actor(after.state, "woodcutter").favors),
      );

      const gatherTick = (event: EventRow) =>
        Math.round((event.payload.simTime as number) / 1000);
      const woodcutterGathers = (from: number) =>
        eventsOf(story, from).filter(
          (event) =>
            event.kind === "resource-gathered" &&
            event.payload.entityId === "woodcutter",
        );
      const boosted = await waitFor(
        "the woodcutter gathers with the favor's bonus while it lasts",
        () =>
          woodcutterGathers(performed.sequence).find(
            (event) =>
              gatherTick(event) < expiresAt &&
              event.payload.amount === base + bonus,
          ),
        { timeoutMs: (duration + 5) * 1000, intervalMs: 100 },
      );
      const plainBefore = woodcutterGathers(1).filter(
        (event) => event.sequence < performed.sequence,
      );
      check(
        plainBefore.length > 0 &&
          plainBefore.every((event) => event.payload.amount === base),
        "before the favor, every woodcutter gather yielded the base amount",
        fmt(plainBefore.map((event) => event.payload.amount)),
      );

      const expired = await waitFor(
        "the woodcutter gathers again after the favor expires",
        () =>
          woodcutterGathers(performed.sequence).find(
            (event) => gatherTick(event) >= expiresAt,
          ),
        { timeoutMs: (duration + 15) * 1000, intervalMs: 100 },
      );
      check(
        expired.payload.amount === base,
        "after the favor expires the gather yield returns to the base amount",
        `${expired.payload.amount} vs base ${base}`,
      );

      story.memo.worshipProposalId = posted.proposalId;
      story.memo.worshipEventId = performed.id;
      story.memo.worshipSessionId = after.frame.sessionId;
      step.done(
        `worship at sequence ${performed.sequence} (tick ${worshipTick}): divinity ${divinityBefore} -> ${divinityAfter}; favor from zeus expires at tick ${expiresAt} (${duration} ticks); gather ${base + bonus} at tick ${gatherTick(boosted)} inside the window, ${expired.payload.amount} at tick ${gatherTick(expired)} after it`,
        [
          {
            name: "divinity gained from worship",
            unit: "divinity",
            value: divinityAfter - divinityBefore,
          },
          { name: "favor duration", unit: "ticks", value: duration },
          {
            name: "favored gather yield over base",
            unit: "resource",
            value: (boosted.payload.amount as number) - base,
          },
        ],
      );
    },
  );
}

async function stepLegends(recorder: Recorder, story: Story): Promise<void> {
  await recorder.run(
    "S9",
    "Legends",
    "A legend a mortal tells about a committed event is verified, one told with no link is a rumor, both are attributed to their narrators and are records rather than facts, and a legend linking an unknown event is refused at intake.",
    async (step) => {
      // Different narrators, so both commit in the same tick.
      const linked = await postFixture(story, legendVerified, {
        "$event:ignited": story.memo.strikeIgnitedEventId ?? "",
      });
      const rumor = await postFixture(story, legendRumor);
      check(
        linked.status === 202 && rumor.status === 202,
        "both legends are accepted at intake",
        `${linked.status} ${fmt(linked.body)}, ${rumor.status} ${fmt(rumor.body)}`,
      );
      const linkedOutcome = await outcomeOf(
        story,
        linked.proposalId,
        "the linked legend's outcome is recorded",
      );
      const rumorOutcome = await outcomeOf(
        story,
        rumor.proposalId,
        "the rumor's outcome is recorded",
      );
      check(
        linkedOutcome.outcome === "committed" &&
          rumorOutcome.outcome === "committed",
        "both legends commit, though their narrators have routines",
        `${linkedOutcome.outcome} ${linkedOutcome.reason}, ${rumorOutcome.outcome} ${rumorOutcome.reason}`,
      );
      const legendEvent = (outcome: TracedOutcome) => {
        const found = eventsOf(story).filter((event) =>
          outcome.eventIds.includes(event.id),
        );
        check(
          found.length === 1 && found[0]?.kind === "legend-recorded",
          "a legend commits one legend-recorded event",
          found.map((event) => event.kind).join(),
        );
        return found[0];
      };
      const verifiedEvent = legendEvent(linkedOutcome);
      const rumorEvent = legendEvent(rumorOutcome);
      check(
        verifiedEvent.payload.verified === true &&
          verifiedEvent.payload.linkedEventId ===
            story.memo.strikeIgnitedEventId,
        "a legend linked to the strike's ignition is verified",
        fmt(verifiedEvent.payload),
      );
      check(
        rumorEvent.payload.verified === false &&
          rumorEvent.payload.linkedEventId === undefined,
        "a legend with no link is a rumor",
        fmt(rumorEvent.payload),
      );

      const unknown = await postFixture(story, legendUnknownLink);
      check(
        unknown.status === 400,
        "a legend linking an unknown event is refused at intake",
        `${unknown.status} ${fmt(unknown.body)}`,
      );
      await waitForTicks(story, 2, "two ticks pass after the refused legend");
      const known = await knowsProposal(story, unknown.proposalId);
      check(
        !known.journaled &&
          !known.traced &&
          eventsOf(story).every(
            (event) => event.correlationId !== unknown.observationId,
          ),
        "the refused legend leaves no journal entry, no outcome, and no event",
        fmt(known),
      );
      const { state } = await readFrame(story.sidecar);
      const legends = [...state.legends.values()];
      check(
        legends.length === 2 &&
          legends.filter((legend) => legend.verified).length === 1,
        "the world holds one verified legend and one rumor, and none for the refused one",
        fmt(
          legends.map((legend) => [
            legend.assertion.slice(0, 20),
            legend.verified,
          ]),
        ),
      );
      const narratorOf = (verified: boolean) =>
        legends.find((legend) => legend.verified === verified)?.narrator;
      check(
        narratorOf(true) === "woodcutter" && narratorOf(false) === "farmer",
        "each legend is attributed to the mortal who told it",
        fmt(legends.map((legend) => [legend.narrator, legend.verified])),
      );
      step.done(
        `verified legend by the woodcutter at sequence ${verifiedEvent.sequence} links ${story.memo.strikeIgnitedEventId?.slice(0, 14)}; rumor by the farmer at sequence ${rumorEvent.sequence} has no link; both committed although both narrators have routines; unknown link refused (${unknown.status}) with no record; legends in world state: ${legends.length}`,
        [{ name: "legends held", unit: "count", value: legends.length }],
      );
    },
  );
}

async function stepBadProposals(
  recorder: Recorder,
  story: Story,
): Promise<void> {
  await recorder.run(
    "S10",
    "Malformed, false, and stale proposals",
    "Malformed input is refused at intake with no journal entry and no record; a false claim and a stale proposal are journaled and recorded as rejections with a reason code; none of them changes the world.",
    async (step) => {
      const beforeState = (await readFrame(story.sidecar)).state;
      const refused: {
        label: string;
        status: number;
        proposalId: string;
        observationId: string;
      }[] = [];

      const invalid = await story.sidecar.request(
        "POST",
        "/proposals",
        "{not json",
      );
      check(
        invalid.status === 400,
        "invalid JSON is refused",
        `${invalid.status}`,
      );
      const missingProposalId = createProposalId();
      const missing = await story.sidecar.request("POST", "/proposals", {
        proposalId: missingProposalId,
        ...(instantiate(missingObservation, {}) as object),
      });
      check(
        missing.status === 400,
        "a proposal without its observation wrapper is refused",
        `${missing.status} ${fmt(missing.body)}`,
      );
      refused.push({
        label: "missing observation",
        status: missing.status,
        proposalId: missingProposalId,
        observationId: "obs-without-a-record",
      });
      const authority = await postFixture(story, malformedAuthority);
      check(
        authority.status === 400,
        "a proposal declaring its own costs is refused",
        `${authority.status} ${fmt(authority.body)}`,
      );
      check(
        fmt(authority.body).includes("costs"),
        "the refusal names the offending field",
        fmt(authority.body),
      );
      refused.push({
        label: "self-declared costs",
        status: authority.status,
        proposalId: authority.proposalId,
        observationId: authority.observationId,
      });

      const claim = await postFixture(story, claimFalse);
      const stale = await postFixture(story, staleStrike);
      check(
        claim.status === 202 && stale.status === 202,
        "the false claim and stale proposal reach the validator",
        `${claim.status}, ${stale.status}`,
      );
      const claimOutcome = await outcomeOf(
        story,
        claim.proposalId,
        "the false claim's rejection is recorded",
      );
      const staleOutcome = await outcomeOf(
        story,
        stale.proposalId,
        "the stale proposal's rejection is recorded",
      );
      check(
        claimOutcome.outcome === "rejected" &&
          claimOutcome.reason === "unauthorized-claim",
        "a false ownership claim is rejected as unauthorized",
        `${claimOutcome.outcome} ${claimOutcome.reason}`,
      );
      check(
        staleOutcome.outcome === "rejected" &&
          staleOutcome.reason === "stale-target",
        "a proposal against a stale revision is rejected as stale",
        `${staleOutcome.outcome} ${staleOutcome.reason}`,
      );
      story.memo.staleObservationId = stale.observationId;
      story.memo.staleProposalId = stale.proposalId;

      await waitForTicks(story, 2, "two ticks pass after the bad proposals");
      for (const entry of refused) {
        const known = await knowsProposal(story, entry.proposalId);
        check(
          !known.journaled && !known.traced,
          `a refused proposal (${entry.label}) leaves no journal entry and no trace outcome`,
          fmt(known),
        );
      }
      const events = eventsOf(story);
      // Positive control: put an observation that did cause events (the tree
      // strike's) among the "bad" ones, so a change IS observed.
      const controlObservation =
        story.options.control === "bad-proposals" &&
        story.memo.oakObservationId !== undefined
          ? [story.memo.oakObservationId]
          : [];
      for (const id of [
        claim.observationId,
        stale.observationId,
        ...refused.map((entry) => entry.observationId),
        ...controlObservation,
      ]) {
        check(
          events.every((event) => event.correlationId !== id),
          "no bad proposal caused an event",
          id,
        );
      }
      const afterState = (await readFrame(story.sidecar)).state;
      // Positive control: probe a building that does have an owner (the tavern's).
      const ownerProbe =
        story.options.control === "claim-owner" ? "the-tavern" : "old-oak";
      check(
        building(afterState, ownerProbe).owner === undefined &&
          building(beforeState, ownerProbe).owner === undefined,
        "the false claim did not give the old oak an owner",
        fmt(building(afterState, ownerProbe).owner),
      );
      step.done(
        `refused at intake (400): invalid JSON, missing observation, self-declared costs; recorded rejections: claim ${claimOutcome.reason}, stale strike ${staleOutcome.reason}; events caused by all five: 0; old oak owner unchanged`,
        [{ name: "bad proposals posted", unit: "count", value: 5 }],
      );
    },
  );
}

async function stepPauseAcrossRestart(
  recorder: Recorder,
  story: Story,
): Promise<void> {
  await recorder.run(
    "S11",
    "Pause across restart",
    "A paused world commits nothing, stays paused through a clean restart, and the paused wall time never becomes catch-up when it resumes.",
    async (step) => {
      const operatorBefore =
        activeDb(story, readObservationSources).operator ?? 0;
      const paused = await story.sidecar.request("POST", "/pause");
      check(
        paused.status === 200,
        "POST /pause answers",
        `${paused.status} ${fmt(paused.body)}`,
      );
      await waitFor(
        "the frame reports paused",
        async () =>
          (await readFrame(story.sidecar)).frame.status === "paused"
            ? true
            : undefined,
        { timeoutMs: 5000 },
      );
      const pausedClock = clockNow(story);
      const pausedSequence = maxSequence(story);
      check(
        pausedClock.paused,
        "the pause is persisted in the clock row",
        fmt(pausedClock),
      );
      await Bun.sleep(2500);
      check(
        clockNow(story).tick === pausedClock.tick &&
          maxSequence(story) === pausedSequence,
        "a paused world commits nothing for 2.5 s",
        `tick ${pausedClock.tick} -> ${clockNow(story).tick}`,
      );

      if (story.options.control === "pause") {
        // Positive control: resume before the restart, so the world is
        // running when it stops and does not come back paused.
        await story.sidecar.request("POST", "/resume");
        await waitForTicks(story, 1, "the resumed world ticks");
      }
      await stopClean(story, "the paused sidecar shuts down cleanly");
      const integrity = activeDb(story, integrityCheck);
      check(
        integrity === "ok",
        "the store is intact after the clean stop",
        integrity,
      );
      // Long enough that a gap counted as catch-up would be obvious (the sleep threshold is 5 s).
      await Bun.sleep(4000);
      const restarted = await story.restart();
      await waitForLog(
        restarted,
        "startup catch-up complete",
        "startup catch-up finishes after the paused restart",
      );
      const held = await readFrame(restarted);
      check(
        held.frame.status === "paused",
        "the restarted world is still paused",
        held.frame.status,
      );
      await Bun.sleep(2500);
      check(
        clockNow(story).tick === pausedClock.tick &&
          maxSequence(story) === pausedSequence,
        "the restarted paused world commits nothing for 2.5 s",
        `tick ${pausedClock.tick} -> ${clockNow(story).tick}`,
      );
      check(
        !held.frame.catchUpSummary || held.frame.catchUpSummary.appliedMs === 0,
        "the restart did not turn the paused interval into catch-up",
        fmt(held.frame.catchUpSummary),
      );

      const resumed = await story.sidecar.request("POST", "/resume");
      check(
        resumed.status === 200,
        "POST /resume answers",
        `${resumed.status} ${fmt(resumed.body)}`,
      );
      const tick = await waitForTicks(
        story,
        2,
        "the resumed world ticks again",
      );
      const advanced = tick - pausedClock.tick;
      check(
        advanced >= 2 && advanced <= 6,
        "resuming applies live ticks, not the paused interval",
        `${advanced} ticks since the pause`,
      );
      const sinceResume = eventsOf(story, pausedSequence + 1);
      check(
        sinceResume.length > 0 &&
          sinceResume.every((event) => !event.approximate),
        "no event after the pause is marked approximate",
        `${sinceResume.filter((event) => event.approximate).length} approximate`,
      );
      const sources = activeDb(story, readObservationSources);
      check(
        (sources.operator ?? 0) >= operatorBefore + 2,
        "the pause and resume are recorded as operator observations",
        `${operatorBefore} before, ${fmt(sources)} after`,
      );
      step.done(
        `paused at tick ${pausedClock.tick}, sequence ${pausedSequence}; unchanged through 2.5 s, a clean restart with 4 s down, and 2.5 s after; resumed: +${advanced} ticks; operator observations ${operatorBefore} -> ${sources.operator}`,
        [
          {
            name: "ticks advanced after resume",
            unit: "ticks",
            value: advanced,
          },
        ],
      );
    },
  );
}

async function stepJournalKill(
  recorder: Recorder,
  story: Story,
): Promise<void> {
  await recorder.run(
    "S12",
    "Durable proposal across a kill",
    "A proposal accepted over /proposals and then SIGKILLed before any tick is still in the journal on restart, runs exactly once on a catch-up tick with a recorded outcome, and a retry of its proposalId reports that outcome without running it again.",
    async (step) => {
      let posted: Awaited<ReturnType<typeof postFixture>> | undefined;
      let accepted: ReturnType<typeof readJournal>[number] | undefined;
      for (
        let attempt = 1;
        attempt <= 3 && accepted === undefined;
        attempt += 1
      ) {
        const attemptPost = await postFixture(story, legendJournal);
        check(
          attemptPost.status === 202 &&
            (attemptPost.body as { status?: string }).status === "pending",
          "the proposal is accepted as pending",
          `${attemptPost.status} ${fmt(attemptPost.body)}`,
        );
        const exitCode = await story.sidecar.stop("SIGKILL");
        check(
          exitCode !== 0,
          "the sidecar was killed",
          `exit code ${exitCode}`,
        );
        const row = activeDb(story, readJournal).find(
          (candidate) => candidate.proposalId === attemptPost.proposalId,
        );
        check(
          row !== undefined,
          "the accepted proposal is in the journal after the kill",
          "no journal row: it was lost with the process",
        );
        if (row.consumedTick === undefined) {
          posted = attemptPost;
          accepted = row;
        } else {
          // A tick committed between the 202 and the kill; try again with a fresh proposal.
          await story.restart();
        }
      }
      check(
        posted !== undefined && accepted !== undefined,
        "a proposal was killed while still pending",
        "three attempts each raced a tick",
      );
      const tickAtKill = clockNow(story).tick;
      check(
        accepted.targetTick === tickAtKill + 1,
        "the entry targets the tick after the persisted clock",
        `target ${accepted.targetTick}, clock tick ${tickAtKill}`,
      );
      const sequenceAtKill = maxSequence(story);

      // The machine "slept" while the service was down: the restart's startup
      // catch-up is what runs the proposal.
      const path = activeStorePath(story.dataDir);
      backdateCursor(path, clockNow(story).cursorWallMs - 2 * 60 * 1000);
      if (story.options.control === "journal") {
        // Positive control: a service that kept accepted proposals only in
        // memory would have lost this one with the process.
        const db = new Database(path);
        try {
          db.run("DELETE FROM external_proposals WHERE proposal_id = ?", [
            posted.proposalId,
          ]);
        } finally {
          db.close();
        }
      }
      const restarted = await story.restart();
      await waitForLog(
        restarted,
        "startup catch-up complete",
        "the startup catch-up after the kill finishes",
      );
      const consumed = await waitFor(
        "the accepted proposal was consumed after the restart",
        () => {
          const row = activeDb(story, readJournal).find(
            (candidate) => candidate.proposalId === posted.proposalId,
          );
          return row?.consumedTick === undefined ? undefined : row;
        },
        { timeoutMs: 5000, intervalMs: 100 },
      );
      check(
        consumed.consumedTick === accepted.targetTick,
        "it ran on the first tick after the kill, a catch-up tick",
        `consumed at ${consumed.consumedTick}, target ${accepted.targetTick}`,
      );
      check(
        consumed.outcome === "committed",
        "its journal row records the committed outcome",
        `${consumed.outcome} ${consumed.reason}`,
      );
      const outcome = await outcomeOf(
        story,
        posted.proposalId,
        "the proposal's outcome is recorded in the trace",
      );
      check(
        outcome.outcome === "committed",
        "the trace records it committed",
        `${outcome.outcome} ${outcome.reason}`,
      );
      const caused = eventsOf(story, sequenceAtKill + 1).filter(
        (event) => event.correlationId === posted.observationId,
      );
      check(
        caused.length === 1 && caused[0]?.kind === "legend-recorded",
        "it ran exactly once: one legend-recorded event",
        caused.map((event) => event.kind).join(),
      );
      check(
        caused[0]?.approximate === true,
        "it ran on a catch-up tick, so its event is marked approximate",
        `approximate ${caused[0]?.approximate}`,
      );

      const retry = await restarted.request(
        "POST",
        "/proposals",
        posted.envelope,
      );
      check(
        retry.status === 200 &&
          (retry.body as { status?: string; queued?: boolean }).status ===
            "committed" &&
          (retry.body as { queued?: boolean }).queued === false,
        "a retry of the same proposalId reports its recorded outcome",
        `${retry.status} ${fmt(retry.body)}`,
      );
      const changed = await restarted.request("POST", "/proposals", {
        ...posted.envelope,
        proposal: {
          ...(posted.envelope.proposal as object),
          assertion: "A different tale under the same id.",
        },
      });
      check(
        changed.status === 409,
        "the same proposalId with changed content is refused",
        `${changed.status} ${fmt(changed.body)}`,
      );
      await waitForTicks(story, 2, "two ticks pass after the retries");
      check(
        eventsOf(story).filter(
          (event) => event.correlationId === posted.observationId,
        ).length === 1,
        "the retries and later ticks did not run it again",
        "extra events found",
      );
      step.done(
        `accepted at clock tick ${tickAtKill}, SIGKILLed while pending; after restart it ran on catch-up tick ${consumed.consumedTick} (one approximate legend-recorded event), outcome ${consumed.outcome}; a retry returned ${fmt((retry.body as { status?: string }).status)}, changed content 409`,
        [
          {
            name: "target tick of the killed proposal",
            unit: "tick",
            value: accepted.targetTick,
          },
        ],
      );
    },
  );
}

async function stepKillMidCatchUp(
  recorder: Recorder,
  story: Story,
): Promise<void> {
  await recorder.run(
    "S13",
    "Kill mid catch-up past the cap",
    "After a three hour sleep, catch-up discards the excess over the one-hour cap in its own commit before any chunk. A SIGKILL partway through and a restart then apply the rest of the capped backlog once: the restarted frame's summary reports the whole backlog, and ticks since the discard equal whole seconds of cursor advance.",
    async (step) => {
      await stopClean(
        story,
        "the sidecar shuts down cleanly before the simulated sleep",
      );
      const stopped = clockNow(story);
      const tickBase = stopped.tick;
      const sleepStart = stopped.cursorWallMs - SLEEP_MS;
      const sequenceBase = maxSequence(story);
      const path = activeStorePath(story.dataDir);
      // Fault injection: the machine slept for SLEEP_MS.
      backdateCursor(path, sleepStart);

      const sidecar = await story.restart();
      const watcher = new Database(path, { readonly: true });
      let exitCode: number | null;
      let killedAtMs: number;
      try {
        await waitFor(
          "catch-up commits its first chunks",
          () =>
            readClockRow(watcher).tick - tickBase >= 2 * CHUNK_TICKS
              ? true
              : undefined,
          { timeoutMs: 30_000, intervalMs: 1 },
        );
        exitCode = await sidecar.stop("SIGKILL");
        killedAtMs = Date.now();
      } finally {
        watcher.close();
      }
      check(exitCode !== 0, "the sidecar was killed", `exit code ${exitCode}`);

      const atKill = clockNow(story);
      const progress = activeDb(story, readCatchUpProgressRow);
      check(
        progress !== undefined,
        "the unfinished backlog's progress is committed",
        "no catch_up_progress row",
      );
      const applied = atKill.tick - tickBase;
      check(
        progress.appliedMs === applied * 1000 && applied % CHUNK_TICKS === 0,
        "the progress records exactly the whole chunks committed",
        `${fmt(progress)} vs ${applied} ticks`,
      );
      check(
        applied < CATCH_UP_CAP_MS / 1000 - CHUNK_TICKS,
        "the kill landed partway through the capped backlog",
        `${applied} of ${CATCH_UP_CAP_MS / 1000} ticks applied`,
      );
      const discarded = progress.discardedMs;
      const expectedDiscard = SLEEP_MS - CATCH_UP_CAP_MS;
      check(
        discarded >= expectedDiscard && discarded < expectedDiscard + 60_000,
        "the excess over the cap was discarded, committed before the chunks",
        `${discarded} ms discarded, expected ${expectedDiscard} plus the seconds before the restart sampled the clock`,
      );
      check(
        activeDb(story, (db) =>
          operatorObservationExists(db, `catch-up-discard:${discarded}`),
        ),
        "the discard is on record as its own operator observation",
        `no catch-up-discard:${discarded}`,
      );
      // After the discard the cursor sat one cap behind the moment catch-up
      // sampled the clock; every applied second moves it and the tick together.
      const backlogStart = sleepStart + discarded;
      const baseline = { tick: tickBase, backdatedCursorMs: backlogStart };
      const killIdentity = catchUpIdentity(baseline, atKill);
      check(
        killIdentity.ok,
        "at the kill, ticks since the discard equal whole seconds of cursor advance",
        fmt(killIdentity),
      );
      const integrity = activeDb(story, integrityCheck);
      check(
        integrity === "ok",
        "the store passes integrity_check after SIGKILL",
        integrity,
      );

      if (story.options.control === "catch-up") {
        // Positive control: a store that kept the ticks but lost the cursor
        // advance would replay the chunks already applied. The identity must notice.
        backdateCursor(path, backlogStart);
      }

      const second = await story.restart();
      const restartedAtMs = Date.now();
      await waitForLog(
        second,
        "startup catch-up complete",
        "the second catch-up finishes",
      );
      const done = await readFrame(second);
      const clock = clockNow(story);
      const identity = catchUpIdentity(baseline, clock);
      check(
        identity.ok,
        "after the second catch-up, ticks since the discard equal whole seconds of cursor advance (nothing was applied twice)",
        fmt(identity),
      );
      const summary = done.frame.catchUpSummary;
      check(
        summary !== undefined,
        "the restarted frame carries a catch-up summary",
        "none",
      );
      check(
        summary.skippedMs === discarded,
        "the restarted summary reports the whole backlog's discard, committed before the kill",
        `${summary.skippedMs} vs ${discarded}`,
      );
      // The cap bounds the remaining backlog: seconds that passed between the
      // kill and the restart are new gap, applied once on top.
      const extraMs = summary.appliedMs - CATCH_UP_CAP_MS;
      const downtimeMs = restartedAtMs - killedAtMs;
      check(
        extraMs >= 0 && extraMs % 1000 === 0 && extraMs <= downtimeMs + 1000,
        "the restarted summary reports the whole backlog applied: the cap plus only the seconds that passed while the service was down",
        `applied ${summary.appliedMs} ms, cap ${CATCH_UP_CAP_MS} ms, down ${downtimeMs} ms`,
      );
      const liveTicks = clock.tick - tickBase - summary.appliedMs / 1000;
      check(
        liveTicks >= 0 && liveTicks <= 5,
        "ticks since the discard are the summary's applied time plus a few live ticks",
        `${clock.tick - tickBase} ticks, summary ${summary.appliedMs / 1000}, live ${liveTicks}`,
      );
      check(
        activeDb(story, readCatchUpProgressRow) === undefined,
        "the backlog's progress is cleared once it completes",
        fmt(activeDb(story, readCatchUpProgressRow)),
      );
      const catchUpEvents = eventsOf(story, sequenceBase + 1).filter(
        (event) => event.sequence <= summary.atSequence,
      );
      check(
        catchUpEvents.length > 0 &&
          catchUpEvents.every((event) => event.approximate),
        "every catch-up event is marked approximate",
        `${catchUpEvents.filter((event) => !event.approximate).length} exact`,
      );
      check(
        eventsOf(story, summary.atSequence + 1).every(
          (event) => !event.approximate,
        ),
        "live events after catch-up are exact",
        "an approximate live event",
      );
      const finalIntegrity = activeDb(story, integrityCheck);
      check(
        finalIntegrity === "ok",
        "the store passes integrity_check after the second catch-up",
        finalIntegrity,
      );
      step.done(
        `sleep ${SLEEP_MS / 3_600_000} h, cap ${CATCH_UP_CAP_MS / 3_600_000} h: excess ${(discarded / 3_600_000).toFixed(3)} h discarded before the chunks; killed after ${applied / CHUNK_TICKS} chunks (${applied} ticks); restarted summary applied ${summary.appliedMs / 1000} ticks (the cap plus ${extraMs / 1000} s of downtime), skipped ${(summary.skippedMs / 3_600_000).toFixed(3)} h; ${catchUpEvents.length} approximate events`,
        [
          {
            name: "chunks committed before kill",
            unit: "chunks",
            value: applied / CHUNK_TICKS,
          },
          {
            name: "ticks applied by the whole backlog",
            unit: "ticks",
            value: summary.appliedMs / 1000,
          },
          {
            name: "seconds discarded beyond the cap",
            unit: "s",
            value: Math.round(summary.skippedMs / 1000),
          },
          {
            name: "ticks over cursor seconds (must be 0)",
            unit: "ticks",
            value: identity.ticksAdvanced - identity.ticksForCursorAdvance,
          },
        ],
      );
    },
  );
}

async function stepArchives(recorder: Recorder, story: Story): Promise<void> {
  await recorder.run(
    "S14",
    "Export, corrupt copy, import, restore",
    "An export imports into a new slot; a copy with one changed byte is rejected and creates no slot; restoring the snapshot makes a branch slot holding the same history and the same proposal journal (ids, order, terminal outcomes) up to the snapshot while the active world is untouched.",
    async (step) => {
      const exportPath = join(story.root, "export.sqlite");
      const sequenceBefore = maxSequence(story);
      const exported = await story.sidecar.request("POST", "/export", {
        path: exportPath,
      });
      check(
        exported.status === 200,
        "POST /export answers",
        `${exported.status} ${fmt(exported.body)}`,
      );
      const manifest = (
        exported.body as {
          manifest: {
            eventSequence: number;
            worldId: string;
            contentHash: string;
          };
        }
      ).manifest;
      const { frame } = await readFrame(story.sidecar);
      check(
        manifest.worldId === frame.worldId,
        "the manifest names this world",
        manifest.worldId,
      );
      check(
        manifest.eventSequence >= sequenceBefore,
        "the export is pinned at a committed sequence no earlier than the request",
        `${manifest.eventSequence} vs ${sequenceBefore}`,
      );

      const corruptPath = join(story.root, "export-corrupt.sqlite");
      if (story.options.control === "archive") {
        // Positive control: an unchanged "corrupted" copy must be caught by the same check that would have rejected it.
        copyFileSync(exportPath, corruptPath);
      } else {
        writeFileSync(
          corruptPath,
          corruptArchiveBytes(readFileSync(exportPath), "income-earned"),
        );
      }

      const slotsBefore = (await story.sidecar.request("GET", "/slots"))
        .body as { slots: unknown[] };
      check(
        slotsBefore.slots.length === 0,
        "no slot exists before any import",
        fmt(slotsBefore),
      );

      const imported = await story.sidecar.request("POST", "/import", {
        archivePath: exportPath,
      });
      check(
        imported.status === 200,
        "importing the original export succeeds",
        `${imported.status} ${fmt(imported.body)}`,
      );
      const importedSlot = (
        imported.body as { result: { slotId: string; slotPath: string } }
      ).result;
      const slotsAfterImport = (
        (await story.sidecar.request("GET", "/slots")).body as {
          slots: { slotId: string }[];
        }
      ).slots;
      check(
        slotsAfterImport.length === 1 &&
          slotsAfterImport[0]?.slotId === importedSlot.slotId,
        "the import made exactly one new slot",
        fmt(slotsAfterImport),
      );

      const rejected = await story.sidecar.request("POST", "/import", {
        archivePath: corruptPath,
      });
      check(
        rejected.status === 422,
        "importing the corrupted copy is rejected",
        rejected.status === 200
          ? "status 200: the copy was imported into a new slot"
          : `status ${rejected.status} ${fmt(rejected.body)}`,
      );
      check(
        fmt(rejected.body).includes("content hash"),
        "the rejection names the failed content hash",
        fmt(rejected.body),
      );
      const slotsAfterReject = (
        (await story.sidecar.request("GET", "/slots")).body as {
          slots: unknown[];
        }
      ).slots;
      check(
        slotsAfterReject.length === 1,
        "the rejected import created no slot",
        fmt(slotsAfterReject),
      );
      const staged = readdirSync(join(story.dataDir, "slots")).filter((name) =>
        name.startsWith(".staging-"),
      );
      check(
        staged.length === 0,
        "the rejected import left no staging directory",
        fmt(staged),
      );

      await waitForTicks(story, 3, "the active world moves past the snapshot");
      const activeBeforeRestore = {
        max: maxSequence(story),
        prefix: activeDb(story, (db) =>
          hashEventPrefix(db, manifest.eventSequence),
        ),
      };
      const restored = await story.sidecar.request("POST", "/restore", {
        archivePath: exportPath,
      });
      check(
        restored.status === 200,
        "restoring the snapshot succeeds",
        `${restored.status} ${fmt(restored.body)}`,
      );
      const branch = (
        restored.body as { result: { slotId: string; slotPath: string } }
      ).result;
      check(
        branch.slotId !== importedSlot.slotId,
        "the restore made a new branch slot, not the imported one",
        branch.slotId,
      );

      const inspect = (slotPath: string) =>
        withWorldDb(slotStorePath(slotPath), (db) => ({
          max: readMaxSequence(db),
          clock: readClockRow(db),
          prefix: hashEventPrefix(db, manifest.eventSequence),
          integrity: integrityCheck(db),
          journal: readJournal(db),
        }));
      const importedView = inspect(importedSlot.slotPath);
      const branchView = inspect(branch.slotPath);
      for (const [label, view] of [
        ["imported slot", importedView],
        ["branch slot", branchView],
      ] as const) {
        check(
          view.integrity === "ok",
          `the ${label} passes integrity_check`,
          view.integrity,
        );
        check(
          view.max === manifest.eventSequence,
          `the ${label} holds exactly the snapshot's events`,
          `${view.max} vs ${manifest.eventSequence}`,
        );
        check(
          view.prefix === activeBeforeRestore.prefix,
          `the ${label}'s history matches the active world's byte for byte`,
          "digest differs",
        );
      }
      // The journal travels with the snapshot: same ids, order, and terminal
      // outcomes for everything consumed by then; entries still pending at
      // export may have been consumed since in the active world.
      const activeJournal = activeDb(story, readJournal);
      for (const [label, view] of [
        ["imported slot", importedView],
        ["branch slot", branchView],
      ] as const) {
        check(
          view.journal.length > 0 &&
            view.journal.length <= activeJournal.length,
          `the ${label} carries the proposal journal`,
          `${view.journal.length} rows of ${activeJournal.length}`,
        );
        for (const row of view.journal) {
          const live = activeJournal[row.inputOrder - 1];
          check(
            live?.proposalId === row.proposalId &&
              live.observationId === row.observationId &&
              live.targetTick === row.targetTick &&
              (row.consumedTick === undefined ||
                (live.consumedTick === row.consumedTick &&
                  live.outcome === row.outcome &&
                  live.reason === row.reason)),
            `the ${label}'s journal entry ${row.inputOrder} matches the active world's, outcome included`,
            fmt([row, live]),
          );
        }
      }
      check(
        branchView.clock.tick < clockNow(story).tick,
        "the branch is a snapshot of the past; the active world has moved on",
        `${branchView.clock.tick} vs ${clockNow(story).tick}`,
      );
      const activeAfter = {
        max: maxSequence(story),
        prefix: activeDb(story, (db) =>
          hashEventPrefix(db, manifest.eventSequence),
        ),
      };
      check(
        activeAfter.max >= activeBeforeRestore.max,
        "the active world kept committing through the restore",
        `${activeBeforeRestore.max} -> ${activeAfter.max}`,
      );
      check(
        activeAfter.prefix === activeBeforeRestore.prefix,
        "the restore left the active world's history untouched",
        "digest changed",
      );
      step.done(
        `export at sequence ${manifest.eventSequence}; import made 1 slot; corrupted copy rejected (${rejected.status}) with no slot and no staging directory; restore made a second slot; both slots hold ${importedView.max} events and ${importedView.journal.length} journal entries matching the active world; the active world was at sequence ${activeBeforeRestore.max} before the restore and ${activeAfter.max} after`,
        [
          {
            name: "exported event sequence",
            unit: "events",
            value: manifest.eventSequence,
          },
          {
            name: "slots after import, corrupt import, and restore",
            unit: "slots",
            value: 2,
          },
        ],
      );
    },
  );
}

/** Event kinds the scene does not draw, so the client must never receipt them. */
const UNDRAWN_KINDS = [
  "resource-gathered",
  "resource-produced",
  "resource-consumed",
  "income-earned",
  "building-burn-ticked",
  "repair-progressed",
  "legend-recorded",
];

async function stepClientReceipts(
  recorder: Recorder,
  story: Story,
): Promise<void> {
  await recorder.run(
    "S15",
    "Headless client receipts",
    "The client receipts only events it placed in the viewed realm: every stored receipt was sent by the client, none is for an undrawn kind, the tree strike's damage, the tavern strike, the fire, the worship, and a routine trade were receipted in the session they happened in, and a client viewing another realm sends none.",
    async (step) => {
      const [mortal] = story.clients;
      check(mortal !== undefined, "the mortal-realm client exists", "missing");
      const view = mortal.view();
      check(
        view !== undefined &&
          view.realms.mortal.length > 0 &&
          view.realms.olympus.length > 0 &&
          view.realms.underworld.length > 0,
        "the client's view model spans all three realms",
        fmt(Object.keys(view?.realms ?? {})),
      );
      const { frame } = await readFrame(story.sidecar);
      check(
        view.sessionId === frame.sessionId,
        "the client is on the sidecar's current session",
        `${view.sessionId} vs ${frame.sessionId}`,
      );

      // A receipt can be stored a moment before the client's own send resolves, so wait for the two to agree.
      const stored = await waitFor(
        "every stored receipt was sent by the client",
        () => {
          const rows = activeDb(story, readReceiptsWithKinds);
          const sent = new Set(
            mortal.presented().map((entry) => entry.eventId),
          );
          return rows.length > 0 &&
            rows.every((receipt) => sent.has(receipt.eventId))
            ? rows
            : undefined;
        },
        { timeoutMs: 5000, intervalMs: 50 },
      );
      const storedKinds = new Set(stored.map((receipt) => receipt.kind));
      check(
        UNDRAWN_KINDS.every((kind) => !storedKinds.has(kind)),
        "no stored receipt is for an undrawn event kind",
        fmt([...storedKinds]),
      );
      const allKinds = new Set(eventsOf(story).map((event) => event.kind));
      check(
        UNDRAWN_KINDS.some((kind) => allKinds.has(kind)),
        "undrawn kinds do exist in the log, so the check is not vacuous",
        fmt([...allKinds]),
      );

      const receiptFor = (eventId: string | undefined) =>
        stored.find((receipt) => receipt.eventId === eventId);
      const ignited = receiptFor(story.memo.strikeIgnitedEventId);
      check(
        ignited !== undefined &&
          ignited.sessionId === story.memo.strikeSessionId,
        "the strike's ignition was receipted in the session it happened in",
        fmt(ignited),
      );
      const destroyed = eventsOf(story).find(
        (event) =>
          event.kind === "building-destroyed" &&
          event.payload.entityId === "the-tavern",
      );
      check(
        receiptFor(destroyed?.id) !== undefined,
        "the tavern's destruction was receipted",
        `${destroyed?.id}`,
      );
      check(
        stored.some((receipt) => receipt.kind === "resource-traded"),
        "a routine trade was receipted",
        fmt([...storedKinds]),
      );
      check(
        receiptFor(story.memo.oakDamagedEventId)?.sessionId ===
          story.memo.oakSessionId,
        "the tree's damage was receipted in the session it happened in",
        fmt(receiptFor(story.memo.oakDamagedEventId)),
      );
      check(
        receiptFor(story.memo.worshipEventId)?.sessionId ===
          story.memo.worshipSessionId,
        "the worship was receipted in the session it happened in",
        fmt(receiptFor(story.memo.worshipEventId)),
      );

      const underworld = createHeadlessClient(
        story.options.control === "underworld"
          ? // Positive control: view the mortal realm instead of the underworld.
            { kind: "actor", id: "farmer" }
          : { kind: "location", id: "judgment-hall" },
        story.sidecar,
      );
      story.clients.push(underworld);
      const sentBefore = mortal.presented().length;
      await waitFor(
        "the mortal client keeps placing and receipting events",
        () => (mortal.presented().length > sentBefore ? true : undefined),
        { timeoutMs: 30_000, intervalMs: 100 },
      );
      await Bun.sleep(1000);
      check(
        underworld.view() !== undefined &&
          underworld.view()?.recentEvents.length !== 0,
        "the underworld client receives frames with events",
        "no frames",
      );
      check(
        underworld.presented().length === 0 && underworld.drawnIds().size === 0,
        "a client viewing the underworld places and receipts nothing while mortal events happen",
        `${underworld.presented().length} sent`,
      );
      const frameErrors = [...mortal.errors(), ...underworld.errors()].filter(
        (message) => !message.startsWith("receipt "),
      );
      check(
        frameErrors.length === 0,
        "no frame failed to parse or decode",
        fmt(frameErrors),
      );
      const relayErrors = [...mortal.errors()].filter((message) =>
        message.startsWith("receipt "),
      ).length;
      const kindCounts = Object.fromEntries(
        [...storedKinds].map((kind) => [
          kind,
          stored.filter((receipt) => receipt.kind === kind).length,
        ]),
      );
      step.done(
        `${stored.length} receipts stored by the mortal-realm client (${fmt(kindCounts)}); oak damage, ignition, destruction, worship, and trades receipted; underworld client received frames and sent 0; relay errors during restarts ${relayErrors}`,
        [
          { name: "receipts stored", unit: "count", value: stored.length },
          {
            name: "receipt relay errors (restarts)",
            unit: "count",
            value: relayErrors,
          },
        ],
      );
    },
  );
}

async function stepTrace(recorder: Recorder, story: Story): Promise<void> {
  await recorder.run(
    "S16",
    "Trace",
    "Every chain is walkable from the identifiers the producer used: a rejected proposal ends at its rejection, a routine trade and a worship reach the presentation receipt the client sent, and the strike's own ignition walks observation, proposal, validation, event, projection change, and the client's presentation receipt.",
    async (step) => {
      const {
        strikeFirstEventId,
        strikeIgnitedEventId,
        strikeObservationId,
        strikeProposalId,
        strikeSessionId,
        staleProposalId,
        worshipEventId,
        worshipSessionId,
      } = story.memo;
      check(
        strikeFirstEventId !== undefined &&
          strikeIgnitedEventId !== undefined &&
          strikeObservationId !== undefined &&
          strikeProposalId !== undefined &&
          strikeSessionId !== undefined &&
          staleProposalId !== undefined &&
          worshipEventId !== undefined &&
          worshipSessionId !== undefined,
        "the identifiers earlier steps recorded are present",
        "missing",
      );
      const stepNames = (steps: FollowResult["steps"]) =>
        steps.map((entry) => entry.step).join(" -> ");

      // A rejected proposal's chain ends at its rejection, with the reason.
      const staleTrace = (
        await getJson(
          story.sidecar,
          `/trace/proposal?id=${encodeURIComponent(staleProposalId)}`,
        )
      ).result.steps;
      const staleValidation = staleTrace[2];
      check(
        stepNames(staleTrace) === "observation -> proposal -> validation" &&
          staleValidation?.step === "validation" &&
          staleValidation.outcome === "rejected" &&
          staleValidation.reason === "stale-target",
        "a rejected proposal's chain ends at its rejection with the reason",
        fmt(staleTrace),
      );

      // A routine's trade is one drawn event: observation by a routine through its receipt.
      const presented = story.clients[0]?.presented() ?? [];
      const tradeReceipt = activeDb(story, readReceiptsWithKinds).find(
        (receipt) =>
          receipt.kind === "resource-traded" &&
          presented.some((entry) => entry.eventId === receipt.eventId),
      );
      check(
        tradeReceipt !== undefined,
        "a receipted routine trade exists to trace",
        "none",
      );
      const tradeTrace = (
        await getJson(
          story.sidecar,
          `/trace/event?id=${encodeURIComponent(tradeReceipt.eventId)}`,
        )
      ).result.steps;
      check(
        tradeTrace[0]?.step === "observation" &&
          tradeTrace[0].record.source === "routine" &&
          stepNames(tradeTrace).startsWith(
            "observation -> proposal -> validation -> event -> projection-change -> receipt",
          ),
        "a routine trade's chain runs from a routine's observation to its receipt",
        stepNames(tradeTrace),
      );
      const tradeReceiptStep = tradeTrace.find(
        (entry) => entry.step === "receipt",
      );
      check(
        tradeReceiptStep?.step === "receipt" &&
          tradeReceiptStep.sessionId === tradeReceipt.sessionId,
        "the trade chain ends at the receipt the client sent",
        fmt(tradeReceiptStep),
      );

      // The worship: a fixture proposal by a mortal, walked to its receipt.
      const worshipTrace = (
        await getJson(
          story.sidecar,
          `/trace/event?id=${encodeURIComponent(worshipEventId)}`,
        )
      ).result.steps;
      const worshipObservation = worshipTrace[0];
      const worshipReceipt = worshipTrace.find(
        (entry) => entry.step === "receipt",
      );
      check(
        worshipObservation?.step === "observation" &&
          worshipObservation.record.source === "fixture" &&
          worshipObservation.record.observer === "woodcutter" &&
          stepNames(worshipTrace).startsWith(
            "observation -> proposal -> validation -> event -> projection-change -> receipt",
          ) &&
          worshipReceipt?.step === "receipt" &&
          worshipReceipt.sessionId === worshipSessionId,
        "the worship chain runs from the fixture's observation by the woodcutter to the client's receipt",
        stepNames(worshipTrace),
      );

      // The strike, from its proposal: every event it committed, in order.
      const byProposal = (
        await getJson(
          story.sidecar,
          `/trace/proposal?id=${encodeURIComponent(strikeProposalId)}`,
        )
      ).result.steps;
      const strikeEvents = eventsOf(story).filter(
        (row) => row.correlationId === strikeObservationId,
      );
      check(
        byProposal.filter((entry) => entry.step === "event").length === 2 &&
          strikeEvents.map((row) => row.id).join() ===
            byProposal
              .flatMap((entry) =>
                entry.step === "event" ? [entry.eventId] : [],
              )
              .join(),
        "following the strike from its proposal lists both events it committed, in order",
        stepNames(byProposal),
      );
      const spendChain = (
        await getJson(
          story.sidecar,
          `/trace/event?id=${encodeURIComponent(strikeFirstEventId)}`,
        )
      ).result.steps;
      check(
        stepNames(spendChain) ===
          "observation -> proposal -> validation -> event -> projection-change",
        "the divinity spend, which the client never draws, walks to its projection change and has no receipt",
        stepNames(spendChain),
      );

      // Final assertion: the strike's ignition, observation through presentation.
      const ignition = strikeEvents.find(
        (row) => row.id === strikeIgnitedEventId,
      );
      check(
        ignition?.kind === "building-ignited",
        "the strike's ignition event is on record",
        `${ignition?.kind}`,
      );
      const chain = (
        await getJson(
          story.sidecar,
          `/trace/event?id=${encodeURIComponent(strikeIgnitedEventId)}`,
        )
      ).result;
      const [observation, proposal, validation, event, projection, receipt] =
        chain.steps;
      check(
        chain.found &&
          stepNames(chain.steps).startsWith(
            "observation -> proposal -> validation -> event -> projection-change -> receipt",
          ),
        "the strike's ignition chain runs observation, proposal, validation, event, projection change, presentation receipt",
        stepNames(chain.steps),
      );
      check(
        observation?.step === "observation" &&
          observation.record.id === strikeObservationId &&
          observation.record.source === "fixture" &&
          observation.record.observer === "zeus",
        "the chain starts at the strike's own observation, by zeus",
        fmt(observation),
      );
      check(
        proposal?.step === "proposal" &&
          proposal.proposalId === strikeProposalId &&
          proposal.record.kind === "strike" &&
          proposal.record.observationId === strikeObservationId,
        "the proposal is the strike the producer posted, citing that observation",
        fmt(proposal),
      );
      check(
        validation?.step === "validation" && validation.outcome === "committed",
        "validation committed the strike",
        fmt(validation),
      );
      check(
        event?.step === "event" &&
          event.eventId === strikeIgnitedEventId &&
          projection?.step === "projection-change" &&
          projection.revision === ignition.sequence,
        "the event is the ignition and its projection change is that event's committed sequence",
        fmt([event, projection]),
      );
      const storedReceipt = activeDb(story, readReceiptsWithKinds).find(
        (row) => row.eventId === strikeIgnitedEventId,
      );
      check(
        receipt?.step === "receipt" &&
          receipt.sessionId === strikeSessionId &&
          receipt.presentedAtMs > 0 &&
          storedReceipt?.sessionId === strikeSessionId,
        "the chain ends at the presentation receipt the client sent for the ignition, in the session it happened in",
        fmt([receipt, storedReceipt]),
      );

      step.done(
        `stale chain ${stepNames(staleTrace)} (${staleValidation?.step === "validation" ? staleValidation.reason : "?"}); trade chain and worship chain each end at the client's receipt; strike from its proposal: ${stepNames(byProposal)}; strike ignition chain ${stepNames(chain.steps)} (event sequence ${ignition.sequence}, receipt session ${receipt?.step === "receipt" ? receipt.sessionId.slice(0, 16) : "?"}...)`,
        [
          {
            name: "strike ignition chain hops",
            unit: "hops",
            value: chain.steps.length,
          },
          {
            name: "worship chain hops",
            unit: "hops",
            value: worshipTrace.length,
          },
          {
            name: "trade chain hops",
            unit: "hops",
            value: tradeTrace.length,
          },
        ],
      );
    },
  );
}
