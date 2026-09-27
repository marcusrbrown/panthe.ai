// SQLite schema migrations, keyed by PRAGMA `user_version` (independent of
// proposal/event/archive payload schema versions, which packages/contracts
// owns — see Key Technical Decisions: "Versioning has two independent
// axes"). Migrations run inside one transaction; an upgrade first takes a
// pre-migration snapshot (a checkpointed file copy) so a failed migration
// never leaves the slot worse off than before the attempt.

import type { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, statSync } from "node:fs";

export interface Migration {
  readonly version: number;
  readonly description: string;
  up(db: Database): void;
}

/**
 * The production migration ladder. Version 1 creates every STRICT table
 * persistence owns: `world` (slot identity), `clock` (persisted cursor +
 * pause), `prng_state` (opaque seeded-PRNG payload), `projections` (the
 * single rebuildable projection document — see store.ts's `ProjectionReducers`
 * for why this is opaque to persistence), and `events` (the append-only
 * source of truth, sequence as primary key for cheap ordered scans).
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description:
      "initial schema: world, clock, prng_state, projections, events",
    up(db) {
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
          paused INTEGER NOT NULL
        ) STRICT
      `);
      db.exec(`
        CREATE TABLE prng_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          state TEXT NOT NULL
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
    },
  },
];

export const LATEST_SCHEMA_VERSION =
  MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

export function currentSchemaVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as {
    user_version: number;
  };
  return row.user_version;
}

export class UnsupportedSchemaVersionError extends Error {
  constructor(
    readonly currentVersion: number,
    readonly latestKnownVersion: number,
  ) {
    super(
      `slot schema version ${currentVersion} is newer than the latest version this build understands (${latestKnownVersion}); refusing to touch it`,
    );
    this.name = "UnsupportedSchemaVersionError";
  }
}

/** Enforces `mode` on an existing file, asserting the result (fails loudly rather than silently leaving a wrong mode). */
function assertFileMode(path: string, mode: number): void {
  chmodSync(path, mode);
  const actual = statSync(path).mode & 0o777;
  if (actual !== mode) {
    throw new Error(
      `migrations: failed to enforce file mode ${mode.toString(8)} on ${path} (got ${actual.toString(8)})`,
    );
  }
}

/**
 * Checkpoints the WAL into the main file and copies it to a sibling
 * `.pre-migration-*.bak` path before an upgrade runs, per Key Technical
 * Decisions ("existing slots migrate forward in place through ordered
 * user_version migrations taken after a pre-migration snapshot").
 */
export function snapshotBeforeMigration(db: Database, path: string): string {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const backupPath = `${path}.pre-migration-v${currentSchemaVersion(db)}-${Date.now()}.bak`;
  copyFileSync(path, backupPath);
  assertFileMode(backupPath, 0o600);
  return backupPath;
}

export interface MigrateOptions {
  /** Injectable ladder, mainly for tests exercising a multi-version upgrade path without adding a real production migration. */
  readonly migrations?: readonly Migration[];
  /** Skips the pre-migration file-copy snapshot. Tests only — production always snapshots a populated upgrade. */
  readonly skipSnapshotForTests?: boolean;
}

/**
 * Applies every pending migration (by `user_version`) in one transaction.
 * A slot whose recorded version is newer than this build's latest known
 * version is left completely untouched and throws
 * `UnsupportedSchemaVersionError` — "a slot that cannot migrate is left
 * untouched and reported."
 */
export function migrate(
  db: Database,
  path: string,
  options: MigrateOptions = {},
): void {
  const migrations = options.migrations ?? MIGRATIONS;
  const latest = migrations[migrations.length - 1]?.version ?? 0;
  const current = currentSchemaVersion(db);

  if (current > latest) {
    throw new UnsupportedSchemaVersionError(current, latest);
  }

  const pending = migrations.filter((m) => m.version > current);
  if (pending.length === 0) {
    return;
  }

  if (current > 0 && !options.skipSnapshotForTests && existsSync(path)) {
    snapshotBeforeMigration(db, path);
  }

  const run = db.transaction(() => {
    for (const migration of pending) {
      migration.up(db);
      // PRAGMA user_version cannot be parameterized; the value here is our
      // own integer literal, never external input.
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
  });
  run.immediate();
}
