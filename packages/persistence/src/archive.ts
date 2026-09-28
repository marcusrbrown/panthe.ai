// Export/import of a single self-describing SQLite archive file (Key
// Technical Decisions). Export takes a snapshot pinned to a committed
// sequence and writes a manifest with a canonical content hash. Import
// treats the archive as hostile: it is copied to a private temp location
// and opened read-only, checked against configured limits, integrity-
// checked, matched against an explicit table allowlist (no triggers,
// views, or virtual tables), manifest-parsed, version-checked, and
// hash-verified — all *before* anything is staged. Only then are the
// validated rows copied into a fresh database created by our own
// migrations in a staging directory, fsynced, and atomically renamed into
// a new, service-generated slot. Nothing overwrites an existing slot;
// any failure removes the staging artifact.

import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ARCHIVE_FORMAT_VERSIONS,
  type ArchiveManifest,
  LATEST_EVENT_SCHEMA_VERSION,
  parseArchiveManifest,
  type WorldId,
} from "@panthea/contracts";
import { LATEST_SCHEMA_VERSION, migrate } from "./migrations";
import { ensureDirMode, ensureFileMode, type Store } from "./store";

const LATEST_ARCHIVE_FORMAT_VERSION =
  ARCHIVE_FORMAT_VERSIONS[ARCHIVE_FORMAT_VERSIONS.length - 1] ?? 1;

/** Fixed order the canonical dump (and therefore the content hash) always uses. */
const HASHED_TABLES: readonly {
  readonly table: string;
  readonly pk: string;
}[] = [
  { table: "world", pk: "id" },
  { table: "clock", pk: "id" },
  { table: "prng_state", pk: "id" },
  { table: "projections", pk: "id" },
  { table: "events", pk: "sequence" },
];

const ALLOWED_TABLE_NAMES = new Set([
  "world",
  "clock",
  "prng_state",
  "projections",
  "events",
  "manifest",
  // sqlite's own bookkeeping table for AUTOINCREMENT columns; none of our
  // tables use AUTOINCREMENT, but tolerate it defensively rather than
  // rejecting a benign artifact.
  "sqlite_sequence",
]);

/**
 * True for the well-known errno codes a directory-fsync refusal shows up
 * as on platforms/filesystems that don't support it. Any other error
 * (e.g. ENOENT, EACCES on a file that should genuinely be syncable)
 * propagates rather than being silently swallowed.
 */
export function isTolerableFsyncError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EISDIR" || code === "EINVAL" || code === "EPERM";
}

/** Fsyncs a single file, propagating any error — a file must always be syncable. */
export function fsyncFile(path: string): void {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Best-effort fsync of a directory — how a rename's atomicity is actually
 * persisted to disk on POSIX filesystems (durability requires the parent
 * directory entry to be flushed, not just the file/inode itself). Some
 * platforms or filesystems refuse to open or fsync a directory fd; those
 * specific, well-known refusals are tolerated silently (see
 * `isTolerableFsyncError`) since this is a durability best-effort, not a
 * correctness requirement — the rename itself is already atomic at the
 * filesystem level.
 */
export function fsyncDirectoryBestEffort(path: string): void {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if (isTolerableFsyncError(error)) {
      return;
    }
    throw error;
  }
  try {
    fsyncSync(fd);
  } catch (error) {
    if (isTolerableFsyncError(error)) {
      return;
    }
    throw error;
  } finally {
    closeSync(fd);
  }
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) {
    const value = row[key];
    result[key] = typeof value === "number" && Object.is(value, -0) ? 0 : value;
  }
  return result;
}

/**
 * Every manifest field except `contentHash` itself (which cannot hash
 * itself). Passed explicitly rather than read from a `manifest` table row
 * so the same function works both at export time (before the manifest row
 * exists) and at import time (from the parsed, not-yet-trusted manifest) —
 * and so the manifest is *bound into* the hash rather than excluded from
 * it, per the P1 manifest-integrity fix: a manifest field tampered without
 * correspondingly recomputing the hash now fails hash verification, and a
 * tampered-and-rehashed manifest (self-consistent but wrong) is still
 * caught by `importArchive`'s separate cross-check against the archive's
 * actual `events`/`world` tables.
 */
export type HashableManifestFields = Omit<ArchiveManifest, "contentHash">;

function manifestFieldsRow(
  manifestFields: HashableManifestFields,
): Record<string, unknown> {
  return {
    format_version: manifestFields.formatVersion,
    sqlite_schema_version: manifestFields.sqliteSchemaVersion,
    payload_schema_version: manifestFields.payloadSchemaVersion,
    world_id: manifestFields.worldId,
    event_sequence: manifestFields.eventSequence,
  };
}

/**
 * Canonical dump of the manifest fields (everything but `contentHash`)
 * plus every substantive table: fixed order (manifest first, then the
 * fixed `HASHED_TABLES` order), rows ordered by primary key, sorted
 * object keys, explicit UTF-8 (via `JSON.stringify`, which always emits
 * UTF-8-safe escapes), explicit null, and normalized numbers (no `-0`).
 * No SQLite page or rowid artifacts are included since every `SELECT`
 * names explicit columns.
 */
export function canonicalDump(
  db: Database,
  manifestFields: HashableManifestFields,
): string {
  const parts: string[] = [];
  parts.push("TABLE manifest");
  parts.push(JSON.stringify(normalizeRow(manifestFieldsRow(manifestFields))));
  for (const { table, pk } of HASHED_TABLES) {
    parts.push(`TABLE ${table}`);
    const rows = db
      .query(`SELECT * FROM ${table} ORDER BY ${pk} ASC`)
      .all() as Record<string, unknown>[];
    for (const row of rows) {
      parts.push(JSON.stringify(normalizeRow(row)));
    }
  }
  return parts.join("\n");
}

export function computeContentHash(
  db: Database,
  manifestFields: HashableManifestFields,
): string {
  return createHash("sha256")
    .update(canonicalDump(db, manifestFields), "utf8")
    .digest("hex");
}

function createManifestTable(db: Database): void {
  db.exec(`
    CREATE TABLE manifest (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      format_version INTEGER NOT NULL,
      sqlite_schema_version INTEGER NOT NULL,
      payload_schema_version INTEGER NOT NULL,
      world_id TEXT NOT NULL,
      event_sequence INTEGER NOT NULL,
      content_hash TEXT NOT NULL
    ) STRICT
  `);
}

interface ExportData {
  readonly worldId: WorldId;
  readonly sequence: number;
  readonly clockCursorWallMs: number;
  readonly clockPaused: number;
  readonly prngState: string;
  readonly projectionsRevision: number;
  readonly projectionsData: string;
  readonly eventRows: readonly Record<string, unknown>[];
}

/** Reads everything export needs in one read transaction, pinned to a single committed sequence. */
function readExportData(store: Store): ExportData {
  const run = store.db.transaction((): ExportData => {
    const sequence =
      (
        store.db
          .query("SELECT MAX(sequence) as maxSequence FROM events")
          .get() as {
          maxSequence: number | null;
        }
      ).maxSequence ?? 0;
    const clockRow = store.db
      .query("SELECT cursor_wall_ms, paused FROM clock WHERE id = 1")
      .get() as { cursor_wall_ms: number; paused: number };
    const prngRow = store.db
      .query("SELECT state FROM prng_state WHERE id = 1")
      .get() as { state: string };
    const projectionsRow = store.db
      .query("SELECT revision, data FROM projections WHERE id = 1")
      .get() as { revision: number; data: string };
    const eventRows = store.db
      .query("SELECT * FROM events WHERE sequence <= ? ORDER BY sequence ASC")
      .all(sequence) as Record<string, unknown>[];
    return {
      worldId: store.worldId,
      sequence,
      clockCursorWallMs: clockRow.cursor_wall_ms,
      clockPaused: clockRow.paused,
      prngState: prngRow.state,
      projectionsRevision: projectionsRow.revision,
      projectionsData: projectionsRow.data,
      eventRows,
    };
  });
  return run.deferred();
}

/**
 * Exports `store` to a single archive file at `destPath`, pinned to the
 * sequence committed at the moment the read transaction opens. Built at a
 * temp path first and renamed into place, so a crash mid-export never
 * leaves a partial file at `destPath`.
 */
export function exportArchive(store: Store, destPath: string): ArchiveManifest {
  const data = readExportData(store);

  const tempPath = `${destPath}.tmp-${randomUUID()}`;
  const archiveDb = new Database(tempPath, { create: true });
  try {
    // Deliberately *not* WAL: an exported archive is a single self-contained
    // file with no concurrent writers, and the default rollback-journal
    // mode means no sibling -wal/-shm files ever exist — which also avoids
    // a real SQLite constraint: opening a WAL-mode database read-only (as
    // `importArchive` does against a private copy) requires creating a
    // -shm file for the reader's lock, which a read-only open cannot do.
    migrate(archiveDb, tempPath, { skipSnapshotForTests: true });
    createManifestTable(archiveDb);

    archiveDb
      .transaction(() => {
        archiveDb.run("INSERT INTO world (id, world_id) VALUES (1, ?)", [
          data.worldId,
        ]);
        archiveDb.run(
          "INSERT INTO clock (id, cursor_wall_ms, paused) VALUES (1, ?, ?)",
          [data.clockCursorWallMs, data.clockPaused],
        );
        archiveDb.run("INSERT INTO prng_state (id, state) VALUES (1, ?)", [
          data.prngState,
        ]);
        archiveDb.run(
          "INSERT INTO projections (id, revision, data) VALUES (1, ?, ?)",
          [data.projectionsRevision, data.projectionsData],
        );
        for (const row of data.eventRows) {
          archiveDb.run(
            `INSERT INTO events (sequence, id, correlation_id, causation_id, kind, approximate, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              row.sequence as number,
              row.id as string,
              row.correlation_id as string,
              row.causation_id as string,
              row.kind as string,
              row.approximate as number,
              row.payload as string,
            ],
          );
        }
      })
      .immediate();

    const manifestFields: HashableManifestFields = {
      formatVersion: LATEST_ARCHIVE_FORMAT_VERSION,
      sqliteSchemaVersion: LATEST_SCHEMA_VERSION,
      payloadSchemaVersion: LATEST_EVENT_SCHEMA_VERSION,
      worldId: data.worldId,
      eventSequence: data.sequence,
    };
    const contentHash = computeContentHash(archiveDb, manifestFields);
    const manifest: ArchiveManifest = { ...manifestFields, contentHash };

    archiveDb
      .transaction(() => {
        archiveDb.run(
          `INSERT INTO manifest (id, format_version, sqlite_schema_version, payload_schema_version, world_id, event_sequence, content_hash)
           VALUES (1, ?, ?, ?, ?, ?, ?)`,
          [
            manifest.formatVersion,
            manifest.sqliteSchemaVersion,
            manifest.payloadSchemaVersion,
            manifest.worldId,
            manifest.eventSequence,
            manifest.contentHash,
          ],
        );
      })
      .immediate();

    archiveDb.close();
    ensureFileMode(tempPath, 0o600);
    fsyncFile(tempPath);
    renameSync(tempPath, destPath);
    fsyncDirectoryBestEffort(dirname(destPath));
    return manifest;
  } catch (error) {
    try {
      archiveDb.close();
    } catch {
      // already closed or never fully opened; ignore.
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${tempPath}${suffix}`, { force: true });
    }
    throw error;
  }
}

// --- Import ------------------------------------------------------------------

export type ImportErrorKind =
  | "over-limit-bytes"
  | "over-limit-rows"
  | "over-limit-time"
  | "corrupt"
  | "disallowed-schema"
  | "missing-manifest"
  | "malformed-manifest"
  | "unsupported-version"
  | "manifest-mismatch"
  | "hash-mismatch";

export class ImportError extends Error {
  constructor(
    readonly kind: ImportErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

export interface ImportLimits {
  readonly maxBytes: number;
  readonly maxRows: number;
  readonly maxDurationMs: number;
}

export interface ImportResult {
  readonly slotId: string;
  readonly slotPath: string;
  readonly manifest: ArchiveManifest;
}

function checkDeadline(deadline: number, now: () => number = Date.now): void {
  if (now() > deadline) {
    throw new ImportError(
      "over-limit-time",
      "archive validation exceeded the configured time budget",
    );
  }
}

/**
 * Imports `archivePath` into a brand-new slot under `slotsDir`. Every
 * validation step runs against a private read-only copy of the archive
 * before anything is staged; any rejection leaves `slotsDir` untouched.
 */
export function importArchive(
  archivePath: string,
  slotsDir: string,
  limits: ImportLimits,
  now: () => number = Date.now,
): ImportResult {
  const deadline = now() + limits.maxDurationMs;
  checkDeadline(deadline, now);

  if (!existsSync(archivePath)) {
    throw new ImportError("corrupt", `archive not found: ${archivePath}`);
  }
  const size = statSync(archivePath).size;
  if (size > limits.maxBytes) {
    throw new ImportError(
      "over-limit-bytes",
      `archive is ${size} bytes, exceeding the ${limits.maxBytes}-byte limit`,
    );
  }

  const tempPath = join(tmpdir(), `panthea-import-${randomUUID()}.sqlite`);

  let archiveDb: Database | undefined;
  try {
    copyFileSync(archivePath, tempPath);
    ensureFileMode(tempPath, 0o600);

    try {
      archiveDb = new Database(tempPath, { readonly: true });
    } catch (error) {
      throw new ImportError(
        "corrupt",
        `unable to open archive as SQLite: ${(error as Error).message}`,
      );
    }

    let integrity: { integrity_check: string };
    try {
      integrity = archiveDb.query("PRAGMA integrity_check").get() as {
        integrity_check: string;
      };
    } catch (error) {
      throw new ImportError(
        "corrupt",
        `integrity_check failed to run: ${(error as Error).message}`,
      );
    }
    if (integrity.integrity_check !== "ok") {
      throw new ImportError(
        "corrupt",
        `archive failed integrity_check: ${integrity.integrity_check}`,
      );
    }

    const schemaRows = archiveDb
      .query("SELECT name, type, sql FROM sqlite_master")
      .all() as { name: string; type: string; sql: string | null }[];
    for (const row of schemaRows) {
      if (row.type === "trigger" || row.type === "view") {
        throw new ImportError(
          "disallowed-schema",
          `archive contains a disallowed ${row.type}: ${row.name}`,
        );
      }
      if (row.sql && /CREATE VIRTUAL TABLE/i.test(row.sql)) {
        throw new ImportError(
          "disallowed-schema",
          `archive contains a disallowed virtual table: ${row.name}`,
        );
      }
      if (row.type === "table" && !ALLOWED_TABLE_NAMES.has(row.name)) {
        throw new ImportError(
          "disallowed-schema",
          `archive contains an unexpected table: ${row.name}`,
        );
      }
    }

    let rowCount = 0;
    for (const { table } of HASHED_TABLES) {
      const hasTable = schemaRows.some(
        (row) => row.type === "table" && row.name === table,
      );
      if (!hasTable) {
        continue;
      }
      const count = (
        archiveDb.query(`SELECT COUNT(*) as count FROM ${table}`).get() as {
          count: number;
        }
      ).count;
      rowCount += count;
    }
    if (rowCount > limits.maxRows) {
      throw new ImportError(
        "over-limit-rows",
        `archive contains ${rowCount} rows, exceeding the ${limits.maxRows}-row limit`,
      );
    }

    checkDeadline(deadline, now);

    const manifestTableExists = schemaRows.some(
      (row) => row.type === "table" && row.name === "manifest",
    );
    if (!manifestTableExists) {
      throw new ImportError(
        "missing-manifest",
        "archive has no manifest table",
      );
    }
    const manifestRow = archiveDb
      .query("SELECT * FROM manifest WHERE id = 1")
      .get() as Record<string, unknown> | null;
    if (!manifestRow) {
      throw new ImportError(
        "missing-manifest",
        "archive manifest table is empty",
      );
    }

    const parsedManifest = parseArchiveManifest({
      formatVersion: manifestRow.format_version,
      sqliteSchemaVersion: manifestRow.sqlite_schema_version,
      payloadSchemaVersion: manifestRow.payload_schema_version,
      worldId: manifestRow.world_id,
      eventSequence: manifestRow.event_sequence,
      contentHash: manifestRow.content_hash,
    });
    if (!parsedManifest.ok) {
      throw new ImportError(
        parsedManifest.reason === "unsupported-version"
          ? "unsupported-version"
          : "malformed-manifest",
        `archive manifest is invalid at ${parsedManifest.path}: ${parsedManifest.message}`,
      );
    }
    const manifest = parsedManifest.value;

    if (manifest.sqliteSchemaVersion > LATEST_SCHEMA_VERSION) {
      throw new ImportError(
        "unsupported-version",
        `archive's SQLite schema version ${manifest.sqliteSchemaVersion} is newer than the latest this build understands (${LATEST_SCHEMA_VERSION})`,
      );
    }
    if (manifest.payloadSchemaVersion > LATEST_EVENT_SCHEMA_VERSION) {
      throw new ImportError(
        "unsupported-version",
        `archive's payload schema version ${manifest.payloadSchemaVersion} is newer than the latest this build understands (${LATEST_EVENT_SCHEMA_VERSION})`,
      );
    }

    // Cross-check the manifest's claims against the archive's *actual*
    // table content, independent of the hash: a manifest field tampered
    // and then correspondingly rehashed (self-consistent, but wrong) would
    // otherwise pass the hash check below. `eventSequence` gates which
    // events get staged and `worldId` identifies the imported slot, so
    // both are named explicitly in the P1 manifest-integrity fix.
    const actualMaxSequence =
      (
        archiveDb.query("SELECT MAX(sequence) as m FROM events").get() as {
          m: number | null;
        }
      ).m ?? 0;
    if (manifest.eventSequence !== actualMaxSequence) {
      throw new ImportError(
        "manifest-mismatch",
        `archive manifest claims event sequence ${manifest.eventSequence}, but the archive's event log actually ends at ${actualMaxSequence}`,
      );
    }
    const actualWorldRow = archiveDb
      .query("SELECT world_id FROM world WHERE id = 1")
      .get() as { world_id: string } | null;
    if (!actualWorldRow || actualWorldRow.world_id !== manifest.worldId) {
      throw new ImportError(
        "manifest-mismatch",
        "archive manifest's world ID does not match the archive's own world table",
      );
    }

    const manifestFieldsFromManifest: HashableManifestFields = {
      formatVersion: manifest.formatVersion,
      sqliteSchemaVersion: manifest.sqliteSchemaVersion,
      payloadSchemaVersion: manifest.payloadSchemaVersion,
      worldId: manifest.worldId,
      eventSequence: manifest.eventSequence,
    };
    const recomputedHash = computeContentHash(
      archiveDb,
      manifestFieldsFromManifest,
    );
    if (recomputedHash !== manifest.contentHash) {
      throw new ImportError(
        "hash-mismatch",
        "archive content hash does not match its manifest; the file was tampered with or corrupted",
      );
    }

    checkDeadline(deadline, now);

    archiveDb.close();
    archiveDb = undefined;

    // --- Staging: only validated bytes ever reach here ---------------------
    ensureDirMode(slotsDir, 0o700);
    const slotId = `slot-${randomUUID()}`;
    const stagingDir = join(slotsDir, `.staging-${randomUUID()}`);
    ensureDirMode(stagingDir, 0o700);

    const stagingDbPath = join(stagingDir, "world.sqlite");
    try {
      const stagingDb = new Database(stagingDbPath, { create: true });
      try {
        stagingDb.exec("PRAGMA journal_mode = WAL");
        migrate(stagingDb, stagingDbPath, { skipSnapshotForTests: true });

        checkDeadline(deadline, now);

        stagingDb.run("ATTACH DATABASE ? AS src", [tempPath]);
        try {
          stagingDb
            .transaction(() => {
              stagingDb.run("INSERT INTO main.world SELECT * FROM src.world");
              checkDeadline(deadline, now);
              stagingDb.run("INSERT INTO main.clock SELECT * FROM src.clock");
              checkDeadline(deadline, now);
              stagingDb.run(
                "INSERT INTO main.prng_state SELECT * FROM src.prng_state",
              );
              checkDeadline(deadline, now);
              stagingDb.run(
                "INSERT INTO main.projections SELECT * FROM src.projections",
              );
              checkDeadline(deadline, now);
              // No WHERE bound: the manifest's claimed eventSequence has
              // already been cross-checked against MAX(sequence) above, so
              // every validated row is copied unconditionally rather than
              // trusting a manifest-derived bound as a filter.
              stagingDb.run("INSERT INTO main.events SELECT * FROM src.events");
            })
            .immediate();
        } finally {
          stagingDb.exec("DETACH DATABASE src");
        }

        stagingDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        stagingDb.close();
      }
      for (const suffix of ["", "-wal", "-shm"]) {
        const path = `${stagingDbPath}${suffix}`;
        if (existsSync(path)) {
          ensureFileMode(path, 0o600);
        }
      }

      checkDeadline(deadline, now);

      // Durability: fsync the staged database file and its containing
      // staging directory before the atomic rename, then fsync the parent
      // (slots) directory afterward so the rename itself survives a crash.
      fsyncFile(stagingDbPath);
      fsyncDirectoryBestEffort(stagingDir);

      const finalDir = join(slotsDir, slotId);
      if (existsSync(finalDir)) {
        throw new Error(
          `import: generated slot ID ${slotId} already exists; refusing to overwrite`,
        );
      }
      renameSync(stagingDir, finalDir);
      fsyncDirectoryBestEffort(slotsDir);

      return { slotId, slotPath: finalDir, manifest };
    } catch (error) {
      rmSync(stagingDir, { recursive: true, force: true });
      throw error;
    }
  } finally {
    if (archiveDb) {
      try {
        archiveDb.close();
      } catch {
        // ignore
      }
    }
    rmSync(tempPath, { force: true });
  }
}
