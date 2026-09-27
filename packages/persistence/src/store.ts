// The per-world SQLite store: WAL journal with macOS persistent-WAL
// disabled, enforced 0700/0600 modes, STRICT tables, and one IMMEDIATE
// transaction per tick that commits events + projections + clock cursor +
// PRNG state atomically (Key Technical Decisions). Patterned after
// tools/probes/backend-lifecycle/src/sidecar.ts's `openDatabase`/mode
// enforcement, extended with migrations, projections, and tick commit.
//
// Projection ownership (Key Technical Decisions): "packages/world owns
// event reducers and projection definitions and never depends on SQLite;
// packages/persistence owns transactions, storage, snapshot/export/import,
// and projection application/rebuild by calling world reducers." This
// module never imports packages/world. Callers inject a `ProjectionReducers`
// value — a pure `applyEvent`/`initial` pair — so persistence stays
// generic over whatever projection shape packages/world eventually defines.
// Persistence stores that shape as a single opaque JSON document; the
// projection *tables* packages/world may want internally are a concern for
// whichever unit defines their relational shape, not this one.

import { constants, Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { WorldId } from "@panthea/contracts";
import { createWorldId, type WorldEvent } from "@panthea/contracts";
import type { PersistedClockState } from "./clock";
import { type MigrateOptions, migrate } from "./migrations";

/** Creates `path` (recursively) and enforces `mode`, regardless of umask, asserting the result. */
export function ensureDirMode(path: string, mode: number): void {
  mkdirSync(path, { recursive: true });
  chmodSync(path, mode);
  const actual = statSync(path).mode & 0o777;
  if (actual !== mode) {
    throw new Error(
      `store: failed to enforce directory mode ${mode.toString(8)} on ${path} (got ${actual.toString(8)})`,
    );
  }
}

/** Enforces `mode` on an existing file, asserting the result. */
export function ensureFileMode(path: string, mode: number): void {
  chmodSync(path, mode);
  const actual = statSync(path).mode & 0o777;
  if (actual !== mode) {
    throw new Error(
      `store: failed to enforce file mode ${mode.toString(8)} on ${path} (got ${actual.toString(8)})`,
    );
  }
}

/** Enforces 0600 on the main db file and any WAL/SHM siblings that currently exist. */
export function enforceDatabaseFileModes(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const filePath = `${dbPath}${suffix}`;
    if (existsSync(filePath)) {
      ensureFileMode(filePath, 0o600);
    }
  }
}

/**
 * Pure projection definitions injected by the caller (packages/world, via
 * apps/simulation's composition root). `applyEvent` must be a pure function
 * — no I/O, no SQLite access — so `rebuildProjections` can replay the
 * entire log deterministically.
 */
export interface ProjectionReducers<TProjections> {
  readonly initial: TProjections;
  applyEvent(projections: TProjections, event: WorldEvent): TProjections;
}

export interface Store {
  readonly db: Database;
  readonly path: string;
  readonly worldId: WorldId;
}

export interface OpenStoreOptions {
  /** Used only when creating a brand-new store; ignored (and asserted) when opening an existing one. */
  readonly worldId?: WorldId;
  readonly migrateOptions?: MigrateOptions;
}

/**
 * Opens (creating if needed) the WAL SQLite store at `path` with every
 * Key Technical Decisions guarantee: 0700 parent dir / 0600 files enforced,
 * macOS persistent-WAL disabled before WAL mode is enabled (order matters —
 * see bun:sqlite's `SQLITE_FCNTL_PERSIST_WAL` docs), `synchronous=NORMAL`,
 * STRICT tables via migrations, and a `world` row identifying this slot.
 */
export function openStore(path: string, options: OpenStoreOptions = {}): Store {
  ensureDirMode(dirname(path), 0o700);
  const existedBefore = existsSync(path);

  const db = new Database(path, { create: true });

  // Order matters (bun:sqlite docs): disable persistent WAL *before*
  // enabling WAL mode, since some macOS SQLite builds default to a
  // persistent WAL and re-enabling journal_mode after the fact does not
  // retroactively clear that setting.
  try {
    db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
  } catch {
    // Non-macOS builds (or SQLite builds without this fcntl) may not
    // support the call; WAL still functions correctly without it.
  }
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  migrate(db, path, options.migrateOptions);

  let worldId: WorldId;
  const worldRow = db.query("SELECT world_id FROM world LIMIT 1").get() as {
    world_id: string;
  } | null;
  if (worldRow) {
    worldId = worldRow.world_id as WorldId;
  } else {
    worldId = options.worldId ?? createWorldId();
    const now = Date.now();
    db.transaction(() => {
      db.run("INSERT INTO world (id, world_id) VALUES (1, ?)", [worldId]);
      db.run(
        "INSERT INTO clock (id, cursor_wall_ms, paused) VALUES (1, ?, 0)",
        [now],
      );
      db.run("INSERT INTO prng_state (id, state) VALUES (1, ?)", [""]);
      db.run("INSERT INTO projections (id, revision, data) VALUES (1, 0, ?)", [
        "null",
      ]);
    }).immediate();
  }

  enforceDatabaseFileModes(path);
  if (!existedBefore) {
    ensureFileMode(path, 0o600);
  }

  return { db, path, worldId };
}

/** Checkpoints the WAL into the main file (TRUNCATE mode) without closing the store. */
export function checkpoint(store: Store): void {
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  enforceDatabaseFileModes(store.path);
}

/** Checkpoints, closes, and re-asserts file modes — the clean-shutdown path (docs/product/defaults.md's autosave row). */
export function closeStore(store: Store): void {
  try {
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // Best-effort checkpoint; closing still flushes committed data.
  }
  store.db.close();
  enforceDatabaseFileModes(store.path);
}

export function getCurrentSequence(db: Database): number {
  const row = db
    .query("SELECT MAX(sequence) as maxSequence FROM events")
    .get() as { maxSequence: number | null };
  return row.maxSequence ?? 0;
}

export function readClock(db: Database): PersistedClockState {
  const row = db
    .query("SELECT cursor_wall_ms, paused FROM clock WHERE id = 1")
    .get() as { cursor_wall_ms: number; paused: number };
  return { cursorWallMs: row.cursor_wall_ms, paused: row.paused !== 0 };
}

function writeClock(db: Database, state: PersistedClockState): void {
  db.run("UPDATE clock SET cursor_wall_ms = ?, paused = ? WHERE id = 1", [
    state.cursorWallMs,
    state.paused ? 1 : 0,
  ]);
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
  reducers: Pick<ProjectionReducers<TProjections>, "initial">,
): ProjectionsRow<TProjections> {
  const row = db
    .query("SELECT revision, data FROM projections WHERE id = 1")
    .get() as { revision: number; data: string } | null;
  if (!row) {
    return { revision: 0, projections: reducers.initial };
  }
  const parsed = JSON.parse(row.data) as TProjections | null;
  return {
    revision: row.revision,
    projections: parsed ?? reducers.initial,
  };
}

function writeProjectionsRow<TProjections>(
  db: Database,
  revision: number,
  projections: TProjections,
): void {
  db.run("UPDATE projections SET revision = ?, data = ? WHERE id = 1", [
    revision,
    JSON.stringify(projections),
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
  /** Opaque seeded-PRNG state, serialized by the caller (packages/world owns the algorithm). */
  readonly prngState: string;
}

export interface TickCommitResult<TProjections> {
  readonly sequence: number;
  readonly projections: TProjections;
}

/**
 * Commits one tick: appends `input.events`, applies each to the injected
 * reducer to advance projections, and persists the clock cursor/pause flag
 * and PRNG state — all inside one `BEGIN IMMEDIATE` transaction. A thrown
 * error at any point (a non-contiguous sequence, a faulting reducer) rolls
 * the whole transaction back automatically; nothing above is left
 * partially applied.
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

    writeProjectionsRow(store.db, sequence, projections);
    writeClock(store.db, {
      cursorWallMs: input.cursorWallMs,
      paused: input.paused,
    });
    writePrngState(store.db, input.prngState);

    return { sequence, projections };
  });

  const result = run.immediate();
  enforceDatabaseFileModes(store.path);
  return result;
}

/** Replays the entire event log from `reducers.initial`, ignoring whatever is currently stored — used to prove rebuild-equals-live. */
export function rebuildProjections<TProjections>(
  store: Store,
  reducers: ProjectionReducers<TProjections>,
): TProjections {
  let projections = reducers.initial;
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
