// Building, aging, and measuring the benchmark world: an on-disk SQLite store
// holding the Unit 7 pack, a fixed seed, and the facts a run is judged by.

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeStore,
  openStore,
  readClock,
  readLiveProjections,
  readPrngState,
  type Store,
} from "@panthea/persistence";
import { ensureTraceSchema } from "@panthea/telemetry";
import {
  createInitialWorldState,
  createPrng,
  type PrngState,
  type WorldState,
} from "@panthea/world";
import { runCatchUp } from "../../../../apps/simulation/src/catchup";
import type { TickDeps } from "../../../../apps/simulation/src/tick";
import {
  createWorldProjectionReducers,
  deserializePrngState,
  restoreWorldTime,
} from "../../../../apps/simulation/src/world-store";
import { loadPack } from "./pack";

/** The benchmark's seed: fixed, so every run draws the same dice. */
export const SEED = 20261003;
export const HOUR_MS = 60 * 60 * 1000;
/** One hour of catch-up, in ticks, at the world's own tick length. */
export const HOUR_TICKS = 3600;

export interface OpenWorld {
  readonly dir: string;
  readonly path: string;
  readonly store: Store;
  readonly deps: TickDeps;
  state: WorldState;
  prng: PrngState;
  /** Closes the store; the directory stays. */
  close(): void;
  /** Closes the store and deletes the directory. */
  dispose(): void;
}

/** A directory for one run, under `base` (the system temp directory unless the caller names one). */
export function makeRunDir(prefix: string, base = tmpdir()): string {
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

/** A brand-new world with `mortals` mortals in `dir`: genesis state, seeded PRNG, trace schema ready. */
export function createWorld(dir: string, mortals?: number): OpenWorld {
  const path = join(dir, "world.sqlite");
  const genesis = createInitialWorldState(loadPack(mortals));
  const reducers = createWorldProjectionReducers(genesis);
  const store = openStore(path, reducers);
  ensureTraceSchema(store.db);
  return handle(dir, path, store, reducers, genesis, createPrng(SEED));
}

/** The world stored at `dir`, as a restarted service reads it: projection and clock from the store, PRNG from its row. */
export function reopenWorld(dir: string, mortals?: number): OpenWorld {
  const path = join(dir, "world.sqlite");
  const genesis = createInitialWorldState(loadPack(mortals));
  const reducers = createWorldProjectionReducers(genesis);
  const store = openStore(path, reducers);
  ensureTraceSchema(store.db);
  const state = restoreWorldTime(
    readLiveProjections(store, reducers),
    readClock(store.db),
  );
  const prng =
    deserializePrngState(readPrngState(store.db)) ?? createPrng(SEED);
  return handle(dir, path, store, reducers, state, prng);
}

function handle(
  dir: string,
  path: string,
  store: Store,
  reducers: ReturnType<typeof createWorldProjectionReducers>,
  state: WorldState,
  prng: PrngState,
): OpenWorld {
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      closeStore(store);
    }
  };
  return {
    dir,
    path,
    store,
    deps: { store, reducers, traceDb: store.db },
    state,
    prng,
    close,
    dispose: () => {
      close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Ages a world by running `hours` one-hour catch-ups back to back, so the next
 * hour is measured against a log, a trace, and a world state that have grown.
 * It uses the real `runCatchUp` with no instrumentation.
 */
export async function ageWorld(world: OpenWorld, hours: number): Promise<void> {
  for (let hour = 0; hour < hours; hour += 1) {
    const clock = readClock(world.store.db);
    const result = await runCatchUp(world.state, world.prng, world.deps, {
      nowWallMs: clock.cursorWallMs + HOUR_MS,
    });
    if (result.degraded) {
      throw new Error(
        `aging hour ${hour} degraded: ${result.degraded.message}`,
      );
    }
    world.state = result.state;
    world.prng = result.prng;
  }
}

/** Copies a closed world's store file to a fresh directory, so each repetition of an aged run starts from the same bytes. */
export function cloneWorldDir(from: string, base?: string): string {
  const dir = makeRunDir("catchup-bench-run-", base);
  copyFileSync(join(from, "world.sqlite"), join(dir, "world.sqlite"));
  return dir;
}

// --- Measuring ------------------------------------------------------------------------------

function one<T>(db: Database, sql: string, ...params: (string | number)[]): T {
  return db.query(sql).get(...params) as T;
}

export interface Counts {
  readonly events: number;
  readonly eventBytes: number;
  readonly observations: number;
  readonly observationBytes: number;
  readonly outcomes: number;
  readonly outcomeBytes: number;
  readonly outcomeEvents: number;
  readonly projectionBytes: number;
}

/** What the store holds now: row counts and payload bytes for the event log and the trace. */
export function countRows(db: Database): Counts {
  const events = one<{ n: number; b: number | null }>(
    db,
    "SELECT COUNT(*) AS n, SUM(LENGTH(payload)) AS b FROM events",
  );
  const obs = one<{ n: number; b: number | null }>(
    db,
    "SELECT COUNT(*) AS n, SUM(LENGTH(payload)) AS b FROM trace_observations",
  );
  const out = one<{ n: number; b: number | null }>(
    db,
    "SELECT COUNT(*) AS n, SUM(LENGTH(payload)) AS b FROM trace_proposal_outcomes",
  );
  const links = one<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM trace_outcome_events",
  );
  const projection = one<{ b: number }>(
    db,
    "SELECT LENGTH(data) AS b FROM projections WHERE id = 1",
  );
  return {
    events: events.n,
    eventBytes: events.b ?? 0,
    observations: obs.n,
    observationBytes: obs.b ?? 0,
    outcomes: out.n,
    outcomeBytes: out.b ?? 0,
    outcomeEvents: links.n,
    projectionBytes: projection.b,
  };
}

export function subtractCounts(after: Counts, before: Counts): Counts {
  return {
    events: after.events - before.events,
    eventBytes: after.eventBytes - before.eventBytes,
    observations: after.observations - before.observations,
    observationBytes: after.observationBytes - before.observationBytes,
    outcomes: after.outcomes - before.outcomes,
    outcomeBytes: after.outcomeBytes - before.outcomeBytes,
    outcomeEvents: after.outcomeEvents - before.outcomeEvents,
    projectionBytes: after.projectionBytes,
  };
}

/** The write-ahead log's size right now, or 0 when it is absent (just checkpointed). */
export function walBytes(path: string): number {
  try {
    return statSync(`${path}-wal`).size;
  } catch {
    return 0;
  }
}

export function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// --- Identity of a run -----------------------------------------------------------------------

/**
 * A sha256 over the event log after `fromSequence`, in order, with the
 * observation ids that name each event's correlation and causation replaced by
 * the order they first appear in. Those ids are minted fresh each run (a
 * routine proposal's observation is a new id every tick), so they are the one
 * thing two runs of the same world cannot share; everything else in an event
 * must be byte-for-byte equal for the digests to be.
 */
export function eventStreamDigest(db: Database, fromSequence = 0): string {
  const hash = createHash("sha256");
  const names = new Map<string, string>();
  const nameOf = (id: string) => {
    let name = names.get(id);
    if (name === undefined) {
      name = `id-${names.size}`;
      names.set(id, name);
    }
    return name;
  };
  const rows = db
    .query("SELECT payload FROM events WHERE sequence > ? ORDER BY sequence")
    .iterate(fromSequence) as IterableIterator<{ payload: string }>;
  for (const row of rows) {
    const event = JSON.parse(row.payload) as Record<string, unknown>;
    if (typeof event.correlationId === "string") {
      event.correlationId = nameOf(event.correlationId);
    }
    if (typeof event.causationId === "string") {
      event.causationId = nameOf(event.causationId);
    }
    hash.update(JSON.stringify(event));
    hash.update("\n");
  }
  return hash.digest("hex");
}

/** A sha256 of the stored projection text: the world state the run ended in. */
export function projectionDigest(db: Database): string {
  const row = one<{ data: string }>(
    db,
    "SELECT data FROM projections WHERE id = 1",
  );
  return createHash("sha256").update(row.data).digest("hex");
}

/**
 * A sha256 over every row the trace holds, in insert order, with the ids
 * minted fresh each run (observations, proposals) renamed in order of first
 * appearance and the wall-clock `recorded_at` left out. Two runs of the same
 * world must give the same digest: it is the check that batching or reordering
 * the trace's writes changed no row, no link, and no order.
 */
export function traceDigest(db: Database): string {
  const hash = createHash("sha256");
  const names = new Map<string, string>();
  const nameOf = (id: unknown) => {
    const key = String(id);
    let name = names.get(key);
    if (name === undefined) {
      name = `id-${names.size}`;
      names.set(key, name);
    }
    return name;
  };
  const put = (...parts: unknown[]) => {
    hash.update(JSON.stringify(parts));
    hash.update("\n");
  };
  const renameObservationId = (payload: string) => {
    const record = JSON.parse(payload) as Record<string, unknown>;
    for (const key of ["id", "observationId"]) {
      if (typeof record[key] === "string") record[key] = nameOf(record[key]);
    }
    return JSON.stringify(record);
  };
  for (const row of db
    .query(
      "SELECT id, observer, state_revision, source, payload FROM trace_observations ORDER BY rowid",
    )
    .iterate() as IterableIterator<Record<string, unknown>>) {
    put(
      "obs",
      nameOf(row.id),
      row.observer,
      row.state_revision,
      row.source,
      renameObservationId(String(row.payload)),
    );
  }
  for (const row of db
    .query(
      "SELECT proposal_id, observation_id, correlation_id, causation_id, outcome, reason, payload FROM trace_proposal_outcomes ORDER BY rowid",
    )
    .iterate() as IterableIterator<Record<string, unknown>>) {
    put(
      "outcome",
      nameOf(row.proposal_id),
      nameOf(row.observation_id),
      nameOf(row.correlation_id),
      nameOf(row.causation_id),
      row.outcome,
      row.reason,
      renameObservationId(String(row.payload)),
    );
  }
  for (const row of db
    .query(
      "SELECT event_id, proposal_id, position FROM trace_outcome_events ORDER BY rowid",
    )
    .iterate() as IterableIterator<Record<string, unknown>>) {
    put("link", row.event_id, nameOf(row.proposal_id), row.position);
  }
  return hash.digest("hex");
}

export interface TraceIntegrity {
  /** Outcome rows whose observation is not in the trace. */
  readonly outcomesWithoutObservation: number;
  /** Outcome-to-event links whose event is not in the log, or whose correlation differs from the outcome's. */
  readonly brokenEventLinks: number;
  /** Events whose correlation is a recorded observation but that no outcome lists. */
  readonly eventsWithoutOutcome: number;
  /** Outcome rows with no proposal payload. */
  readonly outcomesWithoutProposal: number;
  /** How many outcome rows were checked, so a check that saw nothing cannot pass. */
  readonly outcomesChecked: number;
}

/**
 * Whether the trace still answers "where did this event come from" for every
 * event a proposal produced: its observation, its proposal, and its outcome,
 * with the event's own correlation matching the outcome's.
 */
export function traceIntegrity(db: Database): TraceIntegrity {
  const n = (sql: string) => one<{ n: number }>(db, sql).n;
  return {
    outcomesWithoutObservation: n(
      `SELECT COUNT(*) AS n FROM trace_proposal_outcomes o
       WHERE o.reason IS NOT 'observation-conflict'
         AND NOT EXISTS (SELECT 1 FROM trace_observations b WHERE b.id = o.observation_id)`,
    ),
    brokenEventLinks: n(
      `SELECT COUNT(*) AS n FROM trace_outcome_events l
       JOIN trace_proposal_outcomes o ON o.proposal_id = l.proposal_id
       LEFT JOIN events e ON e.id = l.event_id
       WHERE e.id IS NULL OR e.correlation_id <> o.correlation_id`,
    ),
    eventsWithoutOutcome: n(
      `SELECT COUNT(*) AS n FROM events e
       WHERE EXISTS (SELECT 1 FROM trace_observations b WHERE b.id = e.correlation_id)
         AND NOT EXISTS (SELECT 1 FROM trace_outcome_events l WHERE l.event_id = e.id)`,
    ),
    outcomesWithoutProposal: n(
      "SELECT COUNT(*) AS n FROM trace_proposal_outcomes WHERE payload IS NULL OR payload = ''",
    ),
    outcomesChecked: n("SELECT COUNT(*) AS n FROM trace_proposal_outcomes"),
  };
}
