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
import type { FollowResult } from "@panthea/telemetry";
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
import legendRumor from "./fixtures/legend-rumor.json";
import legendUnknownLink from "./fixtures/legend-unknown-link.json";
import legendVerified from "./fixtures/legend-verified.json";
import malformedAuthority from "./fixtures/malformed-authority.json";
import missingObservation from "./fixtures/missing-observation.json";
import repair from "./fixtures/repair.json";
import staleStrike from "./fixtures/stale-strike.json";
import strike from "./fixtures/strike.json";
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
  readClockRow,
  readEventRows,
  readMaxSequence,
  readObservationSources,
  readOutcomesForObservation,
  readReceiptsWithKinds,
  slotStorePath,
  withWorldDb,
} from "./world-db";

export type ControlName = "archive" | "catch-up";
export const CONTROL_NAMES: readonly ControlName[] = ["archive", "catch-up"];

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
  };
}

type Recorder = ReturnType<typeof createStepRecorder>;

const FRAME_TIMEOUT_MS = 10_000;
/** How far back the harness moves the wall cursor: a 50-minute sleep, inside the one-hour cap. */
const BACKDATE_MS = 3_000_000;
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

/** Instantiates a fixture against the latest committed frame and posts it. */
async function postFixture(
  story: Story,
  template: unknown,
  extra: FixtureValues = {},
) {
  const { frame } = await readFrame(story.sidecar);
  const observationId = createObservationId();
  const body = instantiate(template, {
    $observationId: observationId,
    $sequence: frame.sequence,
    ...extra,
  });
  const response = await story.sidecar.request("POST", "/proposals", body);
  return { observationId, status: response.status, body: response.body };
}

async function outcomeOf(story: Story, observationId: string, why: string) {
  return waitFor(
    why,
    () =>
      activeDb(story, (db) => readOutcomesForObservation(db, observationId))[0],
    {
      timeoutMs: FRAME_TIMEOUT_MS,
      intervalMs: 100,
    },
  );
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
  const first = await startSidecar(binary, dataDir);
  const story: Story = {
    options,
    binary,
    root,
    dataDir,
    sidecar: first,
    clients: [],
    memo: {},
    async restart() {
      const next = await startSidecar(binary, dataDir);
      story.sidecar = next;
      for (const client of story.clients) client.attach(next);
      return next;
    },
  };

  try {
    await stepSeed(recorder, story);
    await stepUnattended(recorder, story);
    await stepStrike(recorder, story);
    await stepFire(recorder, story);
    await stepLostService(recorder, story);
    await stepRepair(recorder, story);
    await stepLegends(recorder, story);
    await stepBadProposals(recorder, story);
    await stepPauseAcrossRestart(recorder, story);
    await stepKillMidCatchUp(recorder, story);
    await stepArchives(recorder, story);
    await stepClientReceipts(recorder, story);
    await stepTrace(recorder, story);
    return { steps: recorder.results, binaryBytes };
  } finally {
    for (const client of story.clients) client.stop();
    await story.sidecar.stop("SIGTERM").catch(() => undefined);
    killAllSidecars();
    rmSync(root, { recursive: true, force: true });
  }
}

async function stepSeed(recorder: Recorder, story: Story): Promise<void> {
  await recorder.run(
    "S1",
    "Seed",
    "A fresh data directory loads the authored Greek world across three realms with nothing committed yet.",
    async (step) => {
      const { frame, state } = await readFrame(story.sidecar);
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
          )}), ${state.actors.size} actors, ${state.buildings.size} buildings, sequence ${frame.sequence}`,
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
        frame.catchUpSummary
          ? [
              `The fresh world's first frame already carries a catch-up summary (applied ${frame.catchUpSummary.appliedMs} ms, skipped ${frame.catchUpSummary.skippedMs} ms), which the view would show as a catch-up panel on first launch.`,
            ]
          : [],
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

async function stepStrike(recorder: Recorder, story: Story): Promise<void> {
  await recorder.run(
    "S3",
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
        posted.observationId,
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
          outcome.eventId === spend.id,
        "the trace names the strike's first event",
        `${outcome.eventId}`,
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
      story.memo.strikeProposalId = outcome.proposalId;
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
    "S4",
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
    "S5",
    "Lost service",
    "A destroyed tavern offers no services and earns no income while the untouched shop keeps earning.",
    async (step) => {
      const { state } = await readFrame(story.sidecar);
      const tavern = building(state, "the-tavern");
      check(
        tavern.services.join() === "drink",
        "the tavern's authored services survive destruction",
        fmt(tavern.services),
      );
      check(
        effectiveServices(tavern).length === 0,
        "a destroyed tavern offers no services",
        fmt(effectiveServices(tavern)),
      );
      const from = maxSequence(story);
      await waitForTicks(
        story,
        3,
        "three ticks pass while the tavern is destroyed",
      );
      const income = eventsOf(story, from + 1).filter(
        (event) => event.kind === "income-earned",
      );
      const stillDestroyed =
        building((await readFrame(story.sidecar)).state, "the-tavern")
          .status === "destroyed";
      const tavernIncome = income.filter(
        (event) => event.payload.buildingId === "the-tavern",
      ).length;
      const shopIncome = income.filter(
        (event) => event.payload.buildingId === "agora-shop",
      ).length;
      if (stillDestroyed) {
        check(
          tavernIncome === 0,
          "a destroyed tavern earns no income",
          `${tavernIncome} income events`,
        );
      }
      check(
        shopIncome > 0,
        "the untouched shop keeps earning",
        `${shopIncome} income events`,
      );
      step.done(
        `services ${fmt(effectiveServices(tavern))} of authored ${fmt(tavern.services)}; tavern income events ${tavernIncome}, shop ${shopIncome} over the next ticks`,
        [
          {
            name: "tavern income events while destroyed",
            unit: "count",
            value: tavernIncome,
          },
        ],
      );
    },
  );
}

async function stepRepair(recorder: Recorder, story: Story): Promise<void> {
  await recorder.run(
    "S6",
    "Repair",
    "The tavern's owner repairs it unattended, spending exactly the authored cost in planks; service and income return and the goods lost in the fire stay lost. A fixture repair by an actor with no planks is rejected and adds no progress.",
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

      const posted = await postFixture(story, repair);
      check(
        posted.status === 202,
        "the repair fixture is accepted",
        `${posted.status} ${fmt(posted.body)}`,
      );
      const outcome = await outcomeOf(
        story,
        posted.observationId,
        "the fixture repair's outcome is recorded in the trace",
      );
      check(
        outcome.outcome === "rejected" &&
          outcome.reason === "insufficient-resources",
        "a repair by an actor with no planks is rejected for insufficient resources",
        `${outcome.outcome} ${outcome.reason}`,
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
        progress.every((event) => event.correlationId !== posted.observationId),
        "the rejected fixture added no repair progress",
        "fixture progress found",
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
        `${progress.length} repair steps spent ${spent} planks (cost ${cost}); tavern operational again ${ticksDown} ticks after destruction; fixture repair by zeus ${outcome.outcome} (${outcome.reason})`,
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

async function stepLegends(recorder: Recorder, story: Story): Promise<void> {
  await recorder.run(
    "S7",
    "Legends",
    "A legend linked to a committed event is verified, an unlinked one is a rumor, both are attributed records rather than facts, and a legend linking an unknown event is refused at intake.",
    async (step) => {
      const linked = await postFixture(story, legendVerified, {
        "$event:ignited": story.memo.strikeIgnitedEventId ?? "",
      });
      check(
        linked.status === 202,
        "the linked legend is accepted at intake",
        `${linked.status} ${fmt(linked.body)}`,
      );
      const linkedOutcome = await outcomeOf(
        story,
        linked.observationId,
        "the linked legend's outcome is recorded",
      );
      // One narrator commits one action per tick, so the second legend waits for the first.
      const rumor = await postFixture(story, legendRumor);
      check(
        rumor.status === 202,
        "the rumor is accepted at intake",
        `${rumor.status} ${fmt(rumor.body)}`,
      );
      const rumorOutcome = await outcomeOf(
        story,
        rumor.observationId,
        "the rumor's outcome is recorded",
      );
      check(
        linkedOutcome.outcome === "committed" &&
          rumorOutcome.outcome === "committed",
        "both legends commit",
        `${linkedOutcome.outcome} ${linkedOutcome.reason}, ${rumorOutcome.outcome} ${rumorOutcome.reason}`,
      );
      const legendEvent = (observationId: string) => {
        const found = eventsOf(story).filter(
          (event) => event.correlationId === observationId,
        );
        check(
          found.length === 1 && found[0]?.kind === "legend-recorded",
          "a legend commits one legend-recorded event",
          found.map((event) => event.kind).join(),
        );
        return found[0];
      };
      const verifiedEvent = legendEvent(linked.observationId);
      const rumorEvent = legendEvent(rumor.observationId);
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
      check(
        activeDb(story, (db) =>
          readOutcomesForObservation(db, unknown.observationId),
        ).length === 0 &&
          eventsOf(story).every(
            (event) => event.correlationId !== unknown.observationId,
          ),
        "the refused legend leaves no outcome and no event",
        "found a record",
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
      check(
        legends.every((legend) => legend.narrator === "zeus"),
        "legends are attributed to their narrator",
        fmt(legends.map((legend) => legend.narrator)),
      );

      // Measured, not asserted: what happens to a fixture proposal for a routine-driven actor.
      const asFarmer = await postFixture(story, {
        observation: { ...legendRumor.observation, observer: "farmer" },
        proposal: { ...legendRumor.proposal, actor: "farmer" },
      });
      const farmerOutcome = await outcomeOf(
        story,
        asFarmer.observationId,
        "the farmer legend's outcome is recorded",
      );
      step.done(
        `verified legend at sequence ${verifiedEvent.sequence} links ${story.memo.strikeIgnitedEventId?.slice(0, 14)}; rumor at sequence ${rumorEvent.sequence} has no link; unknown link refused (${unknown.status}) with no record; legends in world state: ${legends.length}`,
        [{ name: "legends held", unit: "count", value: legends.length }],
        [
          `A rumor posted for the farmer, whose routine acts every tick, was ${farmerOutcome.outcome}${farmerOutcome.reason ? ` as ${farmerOutcome.reason}` : ""}. Routines are queued ahead of fixtures and an actor commits one action per tick, so fixtures for routine-driven actors lose to the routine. Only zeus has no routine.`,
        ],
      );
    },
  );
}

async function stepBadProposals(
  recorder: Recorder,
  story: Story,
): Promise<void> {
  await recorder.run(
    "S8",
    "Malformed, false, and stale proposals",
    "Malformed input is refused at intake with no record; a false claim and a stale proposal are recorded as rejections with a reason code; none of them changes the world.",
    async (step) => {
      const beforeState = (await readFrame(story.sidecar)).state;
      const refused: {
        label: string;
        status: number;
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
      const missing = await story.sidecar.request(
        "POST",
        "/proposals",
        instantiate(missingObservation, {}),
      );
      check(
        missing.status === 400,
        "a proposal without its observation wrapper is refused",
        `${missing.status} ${fmt(missing.body)}`,
      );
      refused.push({
        label: "missing observation",
        status: missing.status,
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
        claim.observationId,
        "the false claim's rejection is recorded",
      );
      const staleOutcome = await outcomeOf(
        story,
        stale.observationId,
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
      story.memo.staleProposalId = staleOutcome.proposalId;

      await waitForTicks(story, 2, "two ticks pass after the bad proposals");
      for (const entry of refused) {
        check(
          activeDb(story, (db) =>
            readOutcomesForObservation(db, entry.observationId),
          ).length === 0,
          `a refused proposal (${entry.label}) leaves no trace outcome`,
          "found an outcome",
        );
      }
      const events = eventsOf(story);
      for (const id of [
        claim.observationId,
        stale.observationId,
        ...refused.map((entry) => entry.observationId),
      ]) {
        check(
          events.every((event) => event.correlationId !== id),
          "no bad proposal caused an event",
          id,
        );
      }
      const afterState = (await readFrame(story.sidecar)).state;
      check(
        building(afterState, "old-oak").owner === undefined &&
          building(beforeState, "old-oak").owner === undefined,
        "the false claim did not give the old oak an owner",
        fmt(building(afterState, "old-oak").owner),
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
    "S9",
    "Pause across restart",
    "A paused world commits nothing, stays paused through a clean restart, and the paused wall time never becomes catch-up when it resumes.",
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
        (sources.operator ?? 0) >= 2,
        "the pause and resume are recorded as operator observations",
        fmt(sources),
      );
      step.done(
        `paused at tick ${pausedClock.tick}, sequence ${pausedSequence}; unchanged through 2.5 s, a clean restart with 4 s down, and 2.5 s after; resumed: +${advanced} ticks; operator observations ${sources.operator}`,
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

async function stepKillMidCatchUp(
  recorder: Recorder,
  story: Story,
): Promise<void> {
  await recorder.run(
    "S10",
    "Kill mid catch-up",
    "After a long sleep and a SIGKILL partway through catch-up, restarting applies the rest of the interval once: ticks since the sleep began equal whole seconds of cursor advance, at the kill and after the second catch-up.",
    async (step) => {
      await stopClean(
        story,
        "the sidecar shuts down cleanly before the simulated sleep",
      );
      const stopped = clockNow(story);
      const baseline = {
        tick: stopped.tick,
        backdatedCursorMs: stopped.cursorWallMs - BACKDATE_MS,
      };
      const sequenceBase = maxSequence(story);
      const path = activeStorePath(story.dataDir);
      // Fault injection: the machine slept for BACKDATE_MS.
      backdateCursor(path, baseline.backdatedCursorMs);

      const sidecar = await story.restart();
      const watcher = new Database(path, { readonly: true });
      let killedClock: ReturnType<typeof readClockRow>;
      let exitCode: number | null;
      try {
        killedClock = await waitFor(
          "catch-up commits its first chunks",
          () => {
            const clock = readClockRow(watcher);
            return clock.tick - baseline.tick >= 2 * CHUNK_TICKS
              ? clock
              : undefined;
          },
          { timeoutMs: 30_000, intervalMs: 1 },
        );
        exitCode = await sidecar.stop("SIGKILL");
      } finally {
        watcher.close();
      }
      check(exitCode !== 0, "the sidecar was killed", `exit code ${exitCode}`);

      const atKill = clockNow(story);
      const applied = atKill.tick - baseline.tick;
      const chunksCommitted = applied / CHUNK_TICKS;
      check(
        applied >= 2 * CHUNK_TICKS &&
          applied < BACKDATE_MS / 1000 - CHUNK_TICKS,
        "the kill landed partway through catch-up",
        `${applied} of about ${BACKDATE_MS / 1000} ticks applied (first sighting at ${killedClock.tick - baseline.tick})`,
      );
      check(
        Number.isInteger(chunksCommitted),
        "catch-up commits whole chunks only",
        `${applied} ticks is ${chunksCommitted} chunks`,
      );
      const killIdentity = catchUpIdentity(baseline, atKill);
      check(
        killIdentity.ok,
        "at the kill, ticks equal whole seconds of cursor advance",
        fmt(killIdentity),
      );
      const integrity = activeDb(story, integrityCheck);
      check(
        integrity === "ok",
        "the store passes integrity_check after SIGKILL",
        integrity,
      );
      const afterKillEvents = eventsOf(story, sequenceBase + 1);
      check(
        afterKillEvents.length > 0 &&
          afterKillEvents.every((event) => event.approximate),
        "every event catch-up committed before the kill is marked approximate",
        `${afterKillEvents.filter((event) => !event.approximate).length} exact`,
      );
      check(
        maxSequence(story) ===
          activeDb(
            story,
            (db) =>
              (
                db.query("SELECT COUNT(*) AS n FROM events").get() as {
                  n: number;
                }
              ).n,
          ),
        "the event log is contiguous after SIGKILL",
        "gap in sequence",
      );

      if (story.options.control === "catch-up") {
        // Positive control: a store that kept the ticks but lost the cursor
        // advance would replay the interval. The identity must notice.
        backdateCursor(path, baseline.backdatedCursorMs);
      }

      const second = await story.restart();
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
        "after the second catch-up, ticks equal whole seconds of cursor advance (the interval was applied once)",
        fmt(identity),
      );
      const summary = done.frame.catchUpSummary;
      check(
        summary !== undefined,
        "the second catch-up published a summary",
        "none",
      );
      const catchUpTicks =
        chunksCommitted * CHUNK_TICKS + summary.appliedMs / 1000;
      const liveTicks = clock.tick - baseline.tick - catchUpTicks;
      check(
        liveTicks >= 0 && liveTicks <= 5,
        "chunks before the kill plus the summary's applied time account for the catch-up",
        `catch-up ${catchUpTicks} ticks, total ${clock.tick - baseline.tick}, live ${liveTicks}`,
      );
      check(
        summary.skippedMs < 1000,
        "nothing but a sub-second remainder was skipped (the gap is inside the cap)",
        `${summary.skippedMs} ms skipped`,
      );
      const catchUpEvents = eventsOf(story, sequenceBase + 1).filter(
        (event) => event.sequence <= summary.atSequence,
      );
      check(
        catchUpEvents.every((event) => event.approximate),
        "every catch-up event is marked approximate",
        `${catchUpEvents.filter((event) => !event.approximate).length} exact`,
      );
      const live = eventsOf(story, summary.atSequence + 1);
      check(
        live.every((event) => !event.approximate),
        "live events after catch-up are exact",
        `${live.filter((event) => event.approximate).length} approximate`,
      );
      const finalIntegrity = activeDb(story, integrityCheck);
      check(
        finalIntegrity === "ok",
        "the store passes integrity_check after the second catch-up",
        finalIntegrity,
      );
      step.done(
        `gap ${BACKDATE_MS / 1000} s; killed after ${chunksCommitted} of ${Math.ceil(BACKDATE_MS / 1000 / CHUNK_TICKS)} chunks (${applied} ticks); second catch-up applied ${summary.appliedMs / 1000} ticks; total ${clock.tick - baseline.tick} ticks = ${identity.ticksForCursorAdvance} cursor seconds; ${catchUpEvents.length} approximate events`,
        [
          {
            name: "chunks committed before kill",
            unit: "chunks",
            value: chunksCommitted,
          },
          {
            name: "ticks applied by second catch-up",
            unit: "ticks",
            value: summary.appliedMs / 1000,
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
    "S11",
    "Export, corrupt copy, import, restore",
    "An export imports into a new slot; a copy with one changed byte is rejected and creates no slot; restoring the snapshot makes a branch slot holding the same history up to the snapshot while the active world is untouched.",
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
        `export at sequence ${manifest.eventSequence}; import made 1 slot; corrupted copy rejected (${rejected.status}) with no slot and no staging directory; restore made a second slot; both slots hold ${importedView.max} events matching the active history; the active world was at sequence ${activeBeforeRestore.max} before the restore and ${activeAfter.max} after`,
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
    "S12",
    "Headless client receipts",
    "The client receipts only events it placed in the viewed realm: every stored receipt was sent by the client, none is for an undrawn kind, the strike, the fire, and a routine trade were receipted in the session they happened in, and a client viewing another realm sends none.",
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

      const underworld = createHeadlessClient(
        { kind: "location", id: "judgment-hall" },
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
        `${stored.length} receipts stored by the mortal-realm client (${fmt(kindCounts)}); ignition, destruction, and trades receipted; underworld client received frames and sent 0; relay errors during restarts ${relayErrors}`,
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
    "S13",
    "Trace",
    "The strike's chain walks observation, proposal, validation, event, and projection change with the identifiers the fixture posted; a routine trade's chain continues to the presentation receipt the client sent; a rejected proposal's chain ends at its rejection.",
    async (step) => {
      const {
        strikeFirstEventId,
        strikeIgnitedEventId,
        strikeObservationId,
        strikeProposalId,
        staleProposalId,
      } = story.memo;
      check(
        strikeFirstEventId !== undefined &&
          strikeObservationId !== undefined &&
          strikeProposalId !== undefined,
        "the strike's identifiers were recorded",
        "missing",
      );

      const byEvent = await getJson(
        story.sidecar,
        `/trace/event?id=${encodeURIComponent(strikeFirstEventId)}`,
      );
      const steps = byEvent.result.steps;
      check(
        byEvent.result.found,
        "the trace finds the strike's event",
        "not found",
      );
      check(
        steps
          .map((entry) => entry.step)
          .slice(0, 5)
          .join() === "observation,proposal,validation,event,projection-change",
        "the strike chain runs observation, proposal, validation, event, projection change",
        steps.map((entry) => entry.step).join(),
      );
      const [observation, proposal, validation, event, projection] = steps;
      check(
        observation?.step === "observation" &&
          observation.record.id === strikeObservationId &&
          observation.record.source === "fixture" &&
          observation.record.observer === "zeus",
        "the chain starts at the fixture's observation by zeus",
        fmt(observation),
      );
      check(
        proposal?.step === "proposal" &&
          proposal.proposalId === strikeProposalId &&
          proposal.record.kind === "strike" &&
          proposal.record.observationId === strikeObservationId,
        "the proposal is the strike, citing that observation",
        fmt(proposal),
      );
      check(
        validation?.step === "validation" && validation.outcome === "committed",
        "validation committed the strike",
        fmt(validation),
      );
      const strikeEvent = eventsOf(story).find(
        (row) => row.id === strikeFirstEventId,
      );
      check(
        event?.step === "event" && event.eventId === strikeFirstEventId,
        "the chain names the strike's first event",
        fmt(event),
      );
      check(
        projection?.step === "projection-change" &&
          projection.revision === strikeEvent?.sequence,
        "the projection change is that event's committed sequence",
        fmt(projection),
      );
      const byProposal = await getJson(
        story.sidecar,
        `/trace/proposal?id=${encodeURIComponent(strikeProposalId)}`,
      );
      check(
        fmt(byProposal.result.steps) === fmt(steps),
        "following the strike from its proposal gives the same chain",
        "chains differ",
      );

      const ignited = eventsOf(story).find(
        (row) => row.id === strikeIgnitedEventId,
      );
      check(
        ignited?.correlationId === strikeObservationId,
        "the ignition event carries the strike's observation as its correlation",
        `${ignited?.correlationId}`,
      );
      const viaIgnition = await getJson(
        story.sidecar,
        `/trace/event?id=${encodeURIComponent(strikeIgnitedEventId ?? "")}`,
      );

      // A trade is one drawn event, so its whole chain, receipt included, is reachable.
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
        tradeTrace
          .map((entry) => entry.step)
          .slice(0, 5)
          .join() === "observation,proposal,validation,event,projection-change",
        "the trade chain has the same five hops",
        tradeTrace.map((entry) => entry.step).join(),
      );
      const receipt = tradeTrace[5];
      check(
        tradeTrace[0]?.step === "observation" &&
          tradeTrace[0].record.source === "routine",
        "the trade chain starts at a routine's observation",
        fmt(tradeTrace[0]),
      );
      check(
        receipt?.step === "receipt" &&
          receipt.sessionId === tradeReceipt.sessionId &&
          receipt.presentedAtMs > 0,
        "the trade chain ends at the presentation receipt the client sent",
        fmt(receipt),
      );

      check(
        staleProposalId !== undefined,
        "the stale proposal's identifier was recorded",
        "missing",
      );
      const staleTrace = (
        await getJson(
          story.sidecar,
          `/trace/proposal?id=${encodeURIComponent(staleProposalId)}`,
        )
      ).result.steps;
      const staleValidation = staleTrace[2];
      check(
        staleTrace.map((entry) => entry.step).join() ===
          "observation,proposal,validation" &&
          staleValidation?.step === "validation" &&
          staleValidation.outcome === "rejected" &&
          staleValidation.reason === "stale-target",
        "a rejected proposal's chain ends at its rejection with the reason",
        fmt(staleTrace),
      );
      step.done(
        `strike chain ${steps.map((entry) => entry.step).join(" -> ")} (event ${strikeEvent?.sequence}); trade chain ${tradeTrace.map((entry) => entry.step).join(" -> ")}; stale chain ${staleTrace.map((entry) => entry.step).join(" -> ")} (${staleValidation?.step === "validation" ? staleValidation.reason : "?"})`,
        [
          { name: "strike chain hops", unit: "hops", value: steps.length },
          { name: "trade chain hops", unit: "hops", value: tradeTrace.length },
        ],
        [
          `The strike's chain stops at its projection change. The trace links a proposal to its first committed event only, and a strike's first event is the divinity spend, which the client never draws. The strike's ignition, which the client did receipt (S12), is tied to the strike only by its correlation id in the event log; following that event through the trace query returned found=${viaIgnition.result.found} with ${viaIgnition.result.steps.length} steps. The presentation hop is demonstrated on a routine trade, whose only event is drawn.`,
        ],
      );
    },
  );
}
