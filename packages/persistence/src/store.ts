// The per-world SQLite store: WAL journal with macOS persistent-WAL
// disabled, STRICT tables, and one IMMEDIATE transaction per tick that
// commits events + projections + clock cursor + PRNG state atomically.
//
// packages/world owns event reducers and projection definitions and never
// depends on SQLite; this module owns transactions, storage, and
// projection application/rebuild by calling an injected reducer. It never
// imports packages/world. Persistence stores the projection shape as a
// single opaque JSON document via the caller's `ProjectionCodec`.

import { constants, Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { WorldId } from "@panthea/contracts";
import { createWorldId, type WorldEvent } from "@panthea/contracts";
import type { PersistedClockState } from "./clock";

export const CURRENT_SCHEMA_VERSION = 3;

/** Creates every STRICT table the store owns and stamps `user_version`. */
export function createSchema(db: Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE world (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        world_id TEXT NOT NULL
      ) STRICT
    `);
    db.exec(`
      CREATE TABLE clock (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        cursor_wall_ms INTEGER NOT NULL,
        paused INTEGER NOT NULL,
        tick INTEGER NOT NULL,
        sim_time_ms INTEGER NOT NULL
      ) STRICT
    `);
    db.exec(`
      CREATE TABLE prng_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state TEXT NOT NULL
      ) STRICT
    `);
    db.exec(`
      CREATE TABLE genesis (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
      ) STRICT
    `);
    db.exec(`
      CREATE TABLE projections (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL,
        data TEXT NOT NULL
      ) STRICT
    `);
    db.exec(`
      CREATE TABLE events (
        sequence INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        correlation_id TEXT NOT NULL,
        causation_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        approximate INTEGER NOT NULL,
        payload TEXT NOT NULL
      ) STRICT
    `);
    // Every external (fixture or operator) proposal accepted over
    // /proposals, in the order it arrived. Written by intake, consumed by
    // the tick that runs it; kept afterwards (see journal.ts).
    db.exec(`
      CREATE TABLE external_proposals (
        input_order INTEGER PRIMARY KEY,
        proposal_id TEXT NOT NULL UNIQUE,
        target_tick INTEGER NOT NULL,
        proposal TEXT NOT NULL,
        observation TEXT NOT NULL,
        consumed_tick INTEGER,
        outcome TEXT CHECK (outcome IN ('committed', 'rejected')),
        reason TEXT,
        -- A row is pending (no consuming tick, no outcome) or consumed with
        -- its terminal outcome; a rejection always names its reason.
        CHECK ((consumed_tick IS NULL) = (outcome IS NULL)),
        CHECK ((outcome IS 'rejected') = (reason IS NOT NULL))
      ) STRICT
    `);
    // Serves each tick's pending read (unconsumed, target reached, in input
    // order) without walking the consumed history, which is never pruned.
    db.exec(`
      CREATE INDEX idx_external_proposals_pending
      ON external_proposals (input_order) WHERE consumed_tick IS NULL
    `);
    // At most one row, present only while a catch-up backlog is being
    // worked off. Written in the same transaction as the discard or chunk it
    // describes, so a restart resumes from exactly what committed.
    db.exec(`
      CREATE TABLE catch_up_progress (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        applied_ms INTEGER NOT NULL,
        discarded_ms INTEGER NOT NULL
      ) STRICT
    `);
    db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
  }).immediate();
}

/**
 * Returns whether `db` is a brand-new (version 0) file that needs its
 * schema created, and throws for any other version than this build's. Reads
 * only: a mismatched file is never migrated, reset, or otherwise touched.
 */
function needsSchema(db: Database): boolean {
  const current = (
    db.query("PRAGMA user_version").get() as { user_version: number }
  ).user_version;
  if (current === 0) {
    return true;
  }
  if (current !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `store: schema version ${current} does not match the version this build understands (${CURRENT_SCHEMA_VERSION}); this build never migrates or resets a store, so move the file aside to start a new world`,
    );
  }
  return false;
}

/**
 * Converts `TProjections` to and from the JSON-safe value persistence
 * actually stores. Required because a shape carrying `Map`/`Set` values
 * needs an explicit encoding -- plain `JSON.stringify` silently serializes
 * a `Map` to `{}`.
 */
export interface ProjectionCodec<TProjections> {
  encode(projections: TProjections): unknown;
  decode(value: unknown): TProjections;
}

/** Pure projection definitions injected by the caller. `applyEvent` must be pure so `rebuildProjections` can replay the log deterministically. */
export interface ProjectionReducers<TProjections> {
  readonly initial: TProjections;
  applyEvent(projections: TProjections, event: WorldEvent): TProjections;
  readonly codec: ProjectionCodec<TProjections>;
}

export interface Store {
  readonly db: Database;
  readonly path: string;
  readonly worldId: WorldId;
}

export interface OpenStoreOptions {
  /** Used only when creating a brand-new store; ignored (and asserted) when opening an existing one. */
  readonly worldId?: WorldId;
}

/**
 * The projection value and codec a store persists once, at creation, as
 * its genesis row -- the true starting point `rebuildProjections` replays
 * from. Required on every `openStore` call (not just the first) since a
 * brand-new store needs it immediately; an existing store ignores it, the
 * same way `OpenStoreOptions.worldId` is ignored on reopen.
 */
export interface GenesisInput<TProjections> {
  readonly initial: TProjections;
  readonly codec: Pick<ProjectionCodec<TProjections>, "encode">;
}

/**
 * Opens (creating if needed) the WAL SQLite store at `path`: macOS
 * persistent-WAL disabled before WAL mode is enabled (order matters --
 * some macOS SQLite builds default to a persistent WAL and re-enabling
 * journal_mode after the fact does not clear that setting),
 * `synchronous=NORMAL`, STRICT tables, and a `world` row identifying this
 * slot. A new slot's directory and file get 0700/0600 once, at creation.
 * A brand-new store also persists `genesis.initial` (encoded through
 * `genesis.codec`) once, in its own row, in the same creation transaction
 * as `world`/`clock`/`prng_state`/`projections` -- the starting point
 * `rebuildProjections` replays from, independent of whatever `initial`
 * value a later caller's own `ProjectionReducers` happens to carry.
 */
export function openStore<TProjections>(
  path: string,
  genesis: GenesisInput<TProjections>,
  options: OpenStoreOptions = {},
): Store {
  const dir = dirname(path);
  const existedBefore = existsSync(path);
  if (!existedBefore) {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
  }

  const db = new Database(path, { create: true });

  try {
    // Check the version before anything else touches the file: enabling WAL
    // rewrites the header, and a refused store must be left as it was.
    const fresh = needsSchema(db);
    // Set the db file's mode before WAL mode is enabled: SQLite creates the
    // -wal and -shm sibling files with the main file's current mode, so
    // chmod-ing the main file first (rather than after, once its siblings
    // already exist) is what actually gets them created 0600 under a
    // permissive umask, with no separate chmod of the siblings needed.
    if (!existedBefore) {
      chmodSync(path, 0o600);
    }
    try {
      db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
    } catch {
      // Non-macOS builds (or SQLite builds without this fcntl) may not
      // support the call; WAL still functions correctly without it.
    }
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");

    if (fresh) {
      createSchema(db);
    }

    let worldId: WorldId;
    const worldRow = db.query("SELECT world_id FROM world LIMIT 1").get() as {
      world_id: string;
    } | null;
    if (worldRow) {
      worldId = worldRow.world_id as WorldId;
      if (options.worldId !== undefined && options.worldId !== worldId) {
        throw new Error(
          `store: cannot open ${path} with worldId ${options.worldId}; it already belongs to world ${worldId}`,
        );
      }
    } else {
      worldId = options.worldId ?? createWorldId();
      const now = Date.now();
      const genesisData = JSON.stringify(genesis.codec.encode(genesis.initial));
      db.transaction(() => {
        db.run("INSERT INTO world (id, world_id) VALUES (1, ?)", [worldId]);
        db.run(
          "INSERT INTO clock (id, cursor_wall_ms, paused, tick, sim_time_ms) VALUES (1, ?, 0, 0, 0)",
          [now],
        );
        db.run("INSERT INTO prng_state (id, state) VALUES (1, ?)", [""]);
        db.run("INSERT INTO genesis (id, data) VALUES (1, ?)", [genesisData]);
        db.run(
          "INSERT INTO projections (id, revision, data) VALUES (1, 0, ?)",
          [genesisData],
        );
      }).immediate();
    }

    return { db, path, worldId };
  } catch (error) {
    try {
      db.close();
    } catch {
      // Best-effort: the original error is what matters to the caller.
    }
    throw error;
  }
}

/** Checkpoints the WAL into the main file (TRUNCATE mode) without closing the store. */
export function checkpoint(store: Store): void {
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

/** Checkpoints and closes -- the clean-shutdown path. */
export function closeStore(store: Store): void {
  try {
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // Best-effort checkpoint; closing still flushes committed data.
  }
  store.db.close();
}

export function getCurrentSequence(db: Database): number {
  const row = db
    .query("SELECT MAX(sequence) as maxSequence FROM events")
    .get() as { maxSequence: number | null };
  return row.maxSequence ?? 0;
}

/** Every field the `clock` table row carries: wall-clock cursor/pause plus packages/world's tick counter and simulated time, committed atomically with each tick. */
export interface ClockRow extends PersistedClockState {
  readonly tick: number;
  readonly simTimeMs: number;
}

export function readClock(db: Database): ClockRow {
  const row = db
    .query(
      "SELECT cursor_wall_ms, paused, tick, sim_time_ms FROM clock WHERE id = 1",
    )
    .get() as {
    cursor_wall_ms: number;
    paused: number;
    tick: number;
    sim_time_ms: number;
  };
  return {
    cursorWallMs: row.cursor_wall_ms,
    paused: row.paused !== 0,
    tick: row.tick,
    simTimeMs: row.sim_time_ms,
  };
}

function writeClock(db: Database, state: ClockRow): void {
  db.run(
    "UPDATE clock SET cursor_wall_ms = ?, paused = ?, tick = ?, sim_time_ms = ? WHERE id = 1",
    [state.cursorWallMs, state.paused ? 1 : 0, state.tick, state.simTimeMs],
  );
}

/** What the current catch-up backlog has committed so far: time applied as ticks and time discarded beyond the cap, across every run (and restart) that worked on it. */
export interface CatchUpProgress {
  readonly appliedMs: number;
  readonly discardedMs: number;
}

/** The committed progress of an unfinished catch-up backlog, or `undefined` when none is in progress. */
export function readCatchUpProgress(db: Database): CatchUpProgress | undefined {
  const row = db
    .query(
      "SELECT applied_ms, discarded_ms FROM catch_up_progress WHERE id = 1",
    )
    .get() as { applied_ms: number; discarded_ms: number } | null;
  return row
    ? { appliedMs: row.applied_ms, discardedMs: row.discarded_ms }
    : undefined;
}

/** Records backlog progress. Call inside a tick's `onCommitted` so it commits or rolls back with that tick. */
export function writeCatchUpProgress(
  db: Database,
  progress: CatchUpProgress,
): void {
  db.run(
    `INSERT INTO catch_up_progress (id, applied_ms, discarded_ms) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET applied_ms = excluded.applied_ms, discarded_ms = excluded.discarded_ms`,
    [progress.appliedMs, progress.discardedMs],
  );
}

/** Ends the backlog: the next catch-up starts a new one. Call inside a tick's `onCommitted`. */
export function clearCatchUpProgress(db: Database): void {
  db.run("DELETE FROM catch_up_progress WHERE id = 1");
}

export function readPrngState(db: Database): string {
  const row = db.query("SELECT state FROM prng_state WHERE id = 1").get() as {
    state: string;
  };
  return row.state;
}

function writePrngState(db: Database, state: string): void {
  db.run("UPDATE prng_state SET state = ? WHERE id = 1", [state]);
}

export interface ProjectionsRow<TProjections> {
  readonly revision: number;
  readonly projections: TProjections;
}

export function readProjectionsRow<TProjections>(
  db: Database,
  reducers: Pick<ProjectionReducers<TProjections>, "initial" | "codec">,
): ProjectionsRow<TProjections> {
  const row = db
    .query("SELECT revision, data FROM projections WHERE id = 1")
    .get() as { revision: number; data: string } | null;
  if (!row) {
    return { revision: 0, projections: reducers.initial };
  }
  return {
    revision: row.revision,
    projections: reducers.codec.decode(JSON.parse(row.data)),
  };
}

/**
 * Reads the store's genesis projection -- the value persisted once at
 * creation, independent of whatever `initial` value the caller's own
 * `ProjectionReducers` happens to carry. `rebuildProjections` replays the
 * event log starting here, not from `reducers.initial`, so a freshly
 * constructed composition root (no reference to however the store was
 * originally seeded) still rebuilds the true starting state.
 */
export function readGenesisProjection<TProjections>(
  db: Database,
  reducers: Pick<ProjectionReducers<TProjections>, "codec">,
): TProjections {
  const row = db.query("SELECT data FROM genesis WHERE id = 1").get() as {
    data: string;
  } | null;
  if (!row) {
    throw new Error(
      "store: genesis row is missing; every store persists its genesis projection at creation",
    );
  }
  return reducers.codec.decode(JSON.parse(row.data));
}

function writeProjectionsRow<TProjections>(
  db: Database,
  revision: number,
  projections: TProjections,
  codec: ProjectionCodec<TProjections>,
): void {
  db.run("UPDATE projections SET revision = ?, data = ? WHERE id = 1", [
    revision,
    JSON.stringify(codec.encode(projections)),
  ]);
}

function insertEventRow(db: Database, event: WorldEvent): void {
  db.run(
    `INSERT INTO events (sequence, id, correlation_id, causation_id, kind, approximate, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      event.sequence,
      event.id,
      event.correlationId,
      event.causationId,
      event.kind,
      event.approximate ? 1 : 0,
      JSON.stringify(event),
    ],
  );
}

export function getEventRow(db: Database, id: string): WorldEvent | undefined {
  const row = db.query("SELECT payload FROM events WHERE id = ?").get(id) as {
    payload: string;
  } | null;
  return row ? (JSON.parse(row.payload) as WorldEvent) : undefined;
}

export function listEvents(
  db: Database,
  options: {
    readonly fromSequence?: number;
    readonly toSequence?: number;
  } = {},
): readonly WorldEvent[] {
  const from = options.fromSequence ?? 0;
  const to = options.toSequence ?? Number.MAX_SAFE_INTEGER;
  const rows = db
    .query(
      "SELECT payload FROM events WHERE sequence > ? AND sequence <= ? ORDER BY sequence ASC",
    )
    .all(from, to) as { payload: string }[];
  return rows.map((row) => JSON.parse(row.payload) as WorldEvent);
}

export class NonContiguousSequenceError extends Error {
  constructor(
    readonly expected: number,
    readonly received: number,
  ) {
    super(
      `commitTick: non-contiguous event sequence (expected ${expected}, received ${received})`,
    );
    this.name = "NonContiguousSequenceError";
  }
}

export interface TickInput {
  /** Events to append this tick, in order, with sequence numbers contiguous from `getCurrentSequence(db) + 1`. */
  readonly events: readonly WorldEvent[];
  readonly cursorWallMs: number;
  readonly paused: boolean;
  /** The tick counter's value after this tick. */
  readonly tick: number;
  /** Simulated milliseconds elapsed after this tick. */
  readonly simTimeMs: number;
  /** Opaque seeded-PRNG state, serialized by the caller. */
  readonly prngState: string;
  /**
   * Runs inside the same transaction as the tick's own writes, after
   * events/projections/clock/PRNG are written but before the transaction
   * commits. A caller in another package (e.g. writing causal-trace rows
   * to the same physical database) can throw here to roll the whole tick
   * back atomically; this module stays free of any dependency on what the
   * callback actually writes.
   */
  readonly onCommitted?: (db: Database) => void;
}

export interface TickCommitResult<TProjections> {
  readonly sequence: number;
  readonly projections: TProjections;
}

/**
 * Commits one tick: appends `input.events`, applies each to the injected
 * reducer to advance projections, and persists the clock (cursor, pause,
 * tick, sim time) and PRNG state -- all inside one `BEGIN IMMEDIATE`
 * transaction. A thrown error at any point (a non-contiguous sequence, a
 * faulting reducer) rolls the whole transaction back automatically.
 */
export function commitTick<TProjections>(
  store: Store,
  reducers: ProjectionReducers<TProjections>,
  input: TickInput,
): TickCommitResult<TProjections> {
  const run = store.db.transaction(() => {
    let sequence = getCurrentSequence(store.db);
    let { projections } = readProjectionsRow(store.db, reducers);

    for (const event of input.events) {
      const expected = sequence + 1;
      if (event.sequence !== expected) {
        throw new NonContiguousSequenceError(expected, event.sequence);
      }
      insertEventRow(store.db, event);
      projections = reducers.applyEvent(projections, event);
      sequence = event.sequence;
    }

    writeProjectionsRow(store.db, sequence, projections, reducers.codec);
    writeClock(store.db, {
      cursorWallMs: input.cursorWallMs,
      paused: input.paused,
      tick: input.tick,
      simTimeMs: input.simTimeMs,
    });
    writePrngState(store.db, input.prngState);
    input.onCommitted?.(store.db);

    return { sequence, projections };
  });

  return run.immediate();
}

/** Replays the entire event log from the store's persisted genesis row, ignoring whatever is currently stored in `projections` -- used to prove rebuild-equals-live. */
export function rebuildProjections<TProjections>(
  store: Store,
  reducers: ProjectionReducers<TProjections>,
): TProjections {
  let projections = readGenesisProjection(store.db, reducers);
  for (const event of listEvents(store.db)) {
    projections = reducers.applyEvent(projections, event);
  }
  return projections;
}

/** Reads the currently-stored (live) projections without replaying the log. */
export function readLiveProjections<TProjections>(
  store: Store,
  reducers: ProjectionReducers<TProjections>,
): TProjections {
  return readProjectionsRow(store.db, reducers).projections;
}
