// Export/import of a single self-describing SQLite archive file. Export
// pins a read to a committed sequence and writes a manifest with a
// canonical content hash. Import opens the archive read-only, validates
// its manifest and rows, and copies validated data into a freshly
// schema'd staging database before an atomic rename into a new slot.
// Nothing overwrites an existing slot; any failure removes staging.

import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import {
  ARCHIVE_FORMAT_VERSIONS,
  type ArchiveManifest,
  isRecord,
  LATEST_EVENT_SCHEMA_VERSION,
  parseArchiveManifest,
  parseEvent,
  parseObservationRecord,
  parseProposal,
  type WorldEvent,
  type WorldId,
} from "@panthea/contracts";
import {
  CURRENT_SCHEMA_VERSION,
  createSchema,
  type ProjectionCodec,
  type Store,
} from "./store";

const CURRENT_ARCHIVE_FORMAT_VERSION =
  ARCHIVE_FORMAT_VERSIONS[ARCHIVE_FORMAT_VERSIONS.length - 1] ?? 1;

/** Fixed order the canonical dump (and therefore the content hash) always uses. */
const HASHED_TABLES: readonly {
  readonly table: string;
  readonly pk: string;
}[] = [
  { table: "world", pk: "id" },
  { table: "clock", pk: "id" },
  { table: "prng_state", pk: "id" },
  { table: "genesis", pk: "id" },
  { table: "projections", pk: "id" },
  { table: "events", pk: "sequence" },
  { table: "external_proposals", pk: "input_order" },
];

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) {
    const value = row[key];
    result[key] = typeof value === "number" && Object.is(value, -0) ? 0 : value;
  }
  return result;
}

/** Every manifest field except `contentHash` itself (which cannot hash itself). */
export type HashableManifestFields = Omit<ArchiveManifest, "contentHash">;

function manifestFieldsRow(
  fields: HashableManifestFields,
): Record<string, unknown> {
  return {
    format_version: fields.formatVersion,
    sqlite_schema_version: fields.sqliteSchemaVersion,
    payload_schema_version: fields.payloadSchemaVersion,
    world_id: fields.worldId,
    event_sequence: fields.eventSequence,
  };
}

/**
 * Canonical content hash: the manifest fields (everything but
 * `contentHash`, binding the manifest into the hash it stores) plus every
 * substantive table, in fixed order, rows ordered by primary key, sorted
 * object keys, normalized numbers (no `-0`). Reads each table through a
 * statement iterator (not `.all()`), so memory stays flat regardless of
 * table size. Export writes this hash and import recomputes it, so the
 * two can never drift apart.
 */
export function computeContentHash(
  db: Database,
  manifestFields: HashableManifestFields,
): string {
  const hash = createHash("sha256");
  let wroteAnything = false;
  const push = (text: string): void => {
    if (wroteAnything) {
      hash.update("\n", "utf8");
    }
    hash.update(text, "utf8");
    wroteAnything = true;
  };

  push("TABLE manifest");
  push(JSON.stringify(normalizeRow(manifestFieldsRow(manifestFields))));

  for (const { table, pk } of HASHED_TABLES) {
    push(`TABLE ${table}`);
    const rows = db
      .query(`SELECT * FROM ${table} ORDER BY ${pk} ASC`)
      .iterate() as IterableIterator<Record<string, unknown>>;
    for (const row of rows) {
      push(JSON.stringify(normalizeRow(row)));
    }
  }

  return hash.digest("hex");
}

/** Fsyncs a file so the bytes are durable before the rename that publishes it. */
function fsyncFile(path: string): void {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function createDirMode0700(path: string): void {
  mkdirSync(path, { recursive: true });
  chmodSync(path, 0o700);
}

// --- Export ------------------------------------------------------------------

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
  readonly clockTick: number;
  readonly clockSimTimeMs: number;
  readonly prngState: string;
  readonly genesisData: string;
  readonly projectionsRevision: number;
  readonly projectionsData: string;
  readonly eventRows: readonly Record<string, unknown>[];
  readonly journalRows: readonly JournalRow[];
}

/** One `external_proposals` row exactly as stored. */
interface JournalRow {
  readonly input_order: number;
  readonly proposal_id: string;
  readonly target_tick: number;
  readonly proposal: string;
  readonly observation: string;
  readonly consumed_tick: number | null;
}

/** Reads everything export needs in one read transaction, pinned to a single committed sequence. */
function readExportData(store: Store): ExportData {
  const run = store.db.transaction((): ExportData => {
    const sequence =
      (
        store.db
          .query("SELECT MAX(sequence) as maxSequence FROM events")
          .get() as { maxSequence: number | null }
      ).maxSequence ?? 0;
    const clockRow = store.db
      .query(
        "SELECT cursor_wall_ms, paused, tick, sim_time_ms FROM clock WHERE id = 1",
      )
      .get() as {
      cursor_wall_ms: number;
      paused: number;
      tick: number;
      sim_time_ms: number;
    };
    const prngRow = store.db
      .query("SELECT state FROM prng_state WHERE id = 1")
      .get() as { state: string };
    const genesisRow = store.db
      .query("SELECT data FROM genesis WHERE id = 1")
      .get() as { data: string };
    const projectionsRow = store.db
      .query("SELECT revision, data FROM projections WHERE id = 1")
      .get() as { revision: number; data: string };
    const eventRows = store.db
      .query("SELECT * FROM events WHERE sequence <= ? ORDER BY sequence ASC")
      .all(sequence) as Record<string, unknown>[];
    const journalRows = store.db
      .query("SELECT * FROM external_proposals ORDER BY input_order ASC")
      .all() as JournalRow[];
    return {
      worldId: store.worldId,
      sequence,
      clockCursorWallMs: clockRow.cursor_wall_ms,
      clockPaused: clockRow.paused,
      clockTick: clockRow.tick,
      clockSimTimeMs: clockRow.sim_time_ms,
      prngState: prngRow.state,
      genesisData: genesisRow.data,
      projectionsRevision: projectionsRow.revision,
      projectionsData: projectionsRow.data,
      eventRows,
      journalRows,
    };
  });
  return run.deferred();
}

/**
 * Exports `store` to a single archive file at `destPath`, pinned to the
 * sequence committed at the moment the read transaction opens. Built at a
 * temp path first and renamed into place, so a crash mid-export never
 * leaves a partial file at `destPath`. The archive stays in SQLite's
 * default rollback-journal mode (no WAL): it has no concurrent writers,
 * and a WAL-mode file can't be opened read-only without creating a `-shm`
 * reader-lock file, which import's read-only open must not need to do.
 */
export function exportArchive(store: Store, destPath: string): ArchiveManifest {
  const data = readExportData(store);

  const tempPath = `${destPath}.tmp-${randomUUID()}`;
  const archiveDb = new Database(tempPath, { create: true });
  try {
    createSchema(archiveDb);
    createManifestTable(archiveDb);

    archiveDb
      .transaction(() => {
        archiveDb.run("INSERT INTO world (id, world_id) VALUES (1, ?)", [
          data.worldId,
        ]);
        archiveDb.run(
          "INSERT INTO clock (id, cursor_wall_ms, paused, tick, sim_time_ms) VALUES (1, ?, ?, ?, ?)",
          [
            data.clockCursorWallMs,
            data.clockPaused,
            data.clockTick,
            data.clockSimTimeMs,
          ],
        );
        archiveDb.run("INSERT INTO prng_state (id, state) VALUES (1, ?)", [
          data.prngState,
        ]);
        archiveDb.run("INSERT INTO genesis (id, data) VALUES (1, ?)", [
          data.genesisData,
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
        for (const row of data.journalRows) {
          archiveDb.run(
            `INSERT INTO external_proposals (input_order, proposal_id, target_tick, proposal, observation, consumed_tick)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              row.input_order,
              row.proposal_id,
              row.target_tick,
              row.proposal,
              row.observation,
              row.consumed_tick,
            ],
          );
        }
      })
      .immediate();

    const manifestFields: HashableManifestFields = {
      formatVersion: CURRENT_ARCHIVE_FORMAT_VERSION,
      sqliteSchemaVersion: CURRENT_SCHEMA_VERSION,
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
    chmodSync(tempPath, 0o600);
    fsyncFile(tempPath);
    renameSync(tempPath, destPath);
    return manifest;
  } catch (error) {
    try {
      archiveDb.close();
    } catch {
      // already closed or never fully opened; ignore.
    }
    rmSync(tempPath, { force: true });
    throw error;
  }
}

// --- Import ------------------------------------------------------------------

export type ImportErrorKind =
  | "corrupt"
  | "incompatible-version"
  | "inconsistent-manifest"
  | "io";

export class ImportError extends Error {
  constructor(
    readonly kind: ImportErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

export interface ImportResult {
  readonly slotId: string;
  readonly slotPath: string;
  readonly manifest: ArchiveManifest;
}

/** Runs `fn`, wrapping any thrown error (a missing or incompatible table, malformed data) as `ImportError("corrupt")`. */
function readOrCorrupt<T>(fn: () => T, context: string): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ImportError) {
      throw error;
    }
    throw new ImportError("corrupt", `${context}: ${(error as Error).message}`);
  }
}

interface ClockRowData {
  readonly cursor_wall_ms: number;
  readonly paused: number;
  readonly tick: number;
  readonly sim_time_ms: number;
}

function validClockRow(row: ClockRowData): boolean {
  return (
    (row.paused === 0 || row.paused === 1) &&
    Number.isFinite(row.cursor_wall_ms) &&
    Number.isInteger(row.tick) &&
    row.tick >= 0 &&
    Number.isFinite(row.sim_time_ms) &&
    row.sim_time_ms >= 0
  );
}

/**
 * A decoded projection may or may not carry a `lastSequence` field --
 * generic `TProjections` shapes (persistence's own test fixtures) don't.
 * When one is present and numeric, import cross-checks it against the
 * archive's actual event-log length; when absent, there is nothing to
 * check, so import doesn't require every projection shape to have one.
 */
function extractLastSequence(value: unknown): number | undefined {
  return isRecord(value) && typeof value.lastSequence === "number"
    ? value.lastSequence
    : undefined;
}

/**
 * Imports `archivePath` into a brand-new slot under `slotsDir`. The
 * archive is opened read-only and every row is validated -- decoded
 * through `projectionsCodec`, event payloads through contracts' event
 * parser -- while being read into the values that get copied into a
 * fresh, app-created staging database. A missing or incompatible table,
 * a manifest that disagrees with the archive's own tables, or a content
 * hash mismatch is rejected before anything is staged.
 */
export function importArchive(
  archivePath: string,
  slotsDir: string,
  projectionsCodec: ProjectionCodec<unknown>,
): ImportResult {
  if (!existsSync(archivePath)) {
    throw new ImportError("io", `archive not found: ${archivePath}`);
  }

  let archiveDb: Database | undefined;
  try {
    try {
      archiveDb = new Database(archivePath, { readonly: true });
    } catch (error) {
      throw new ImportError(
        "corrupt",
        `unable to open archive as SQLite: ${(error as Error).message}`,
      );
    }
    const db = archiveDb;

    const integrity = readOrCorrupt(
      () =>
        db.query("PRAGMA integrity_check").get() as {
          integrity_check: string;
        },
      "archive failed integrity_check",
    );
    if (integrity.integrity_check !== "ok") {
      throw new ImportError(
        "corrupt",
        `archive failed integrity_check: ${integrity.integrity_check}`,
      );
    }

    const manifestRow = readOrCorrupt(
      () =>
        db.query("SELECT * FROM manifest WHERE id = 1").get() as Record<
          string,
          unknown
        > | null,
      "archive manifest table is missing or unreadable",
    );
    if (!manifestRow) {
      throw new ImportError("corrupt", "archive manifest table is empty");
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
          ? "incompatible-version"
          : "corrupt",
        `archive manifest is invalid at ${parsedManifest.path}: ${parsedManifest.message}`,
      );
    }
    const manifest = parsedManifest.value;

    if (manifest.sqliteSchemaVersion !== CURRENT_SCHEMA_VERSION) {
      throw new ImportError(
        "incompatible-version",
        `archive's SQLite schema version ${manifest.sqliteSchemaVersion} does not match this build's version ${CURRENT_SCHEMA_VERSION}`,
      );
    }
    if (manifest.payloadSchemaVersion !== LATEST_EVENT_SCHEMA_VERSION) {
      throw new ImportError(
        "incompatible-version",
        `archive's payload schema version ${manifest.payloadSchemaVersion} does not match this build's version ${LATEST_EVENT_SCHEMA_VERSION}`,
      );
    }

    const worldRow = readOrCorrupt(
      () =>
        db.query("SELECT world_id FROM world WHERE id = 1").get() as {
          world_id: unknown;
        } | null,
      "archive world table is missing or unreadable",
    );
    if (
      !worldRow ||
      typeof worldRow.world_id !== "string" ||
      worldRow.world_id.length === 0
    ) {
      throw new ImportError(
        "corrupt",
        "archive world row is missing or invalid",
      );
    }
    const worldId = worldRow.world_id as WorldId;
    if (worldId !== manifest.worldId) {
      throw new ImportError(
        "inconsistent-manifest",
        "archive manifest's world ID does not match the archive's own world table",
      );
    }

    const actualMaxSequence =
      readOrCorrupt(
        () =>
          db.query("SELECT MAX(sequence) as m FROM events").get() as {
            m: number | null;
          } | null,
        "archive events table is missing or unreadable",
      )?.m ?? 0;
    if (manifest.eventSequence !== actualMaxSequence) {
      throw new ImportError(
        "inconsistent-manifest",
        `archive manifest claims event sequence ${manifest.eventSequence}, but the archive's event log actually ends at ${actualMaxSequence}`,
      );
    }

    const { contentHash: claimedHash, ...manifestFields } = manifest;
    const recomputedHash = computeContentHash(db, manifestFields);
    if (recomputedHash !== claimedHash) {
      throw new ImportError(
        "inconsistent-manifest",
        "archive content hash does not match its manifest; the file was tampered with or corrupted",
      );
    }

    const clockRow = readOrCorrupt(
      () =>
        db
          .query(
            "SELECT cursor_wall_ms, paused, tick, sim_time_ms FROM clock WHERE id = 1",
          )
          .get() as ClockRowData | null,
      "archive clock table is missing or unreadable",
    );
    if (!clockRow || !validClockRow(clockRow)) {
      throw new ImportError(
        "corrupt",
        "archive clock row is missing or invalid",
      );
    }

    const prngRow = readOrCorrupt(
      () =>
        db.query("SELECT state FROM prng_state WHERE id = 1").get() as {
          state: unknown;
        } | null,
      "archive PRNG table is missing or unreadable",
    );
    if (!prngRow || typeof prngRow.state !== "string") {
      throw new ImportError(
        "corrupt",
        "archive PRNG row is missing or not a string",
      );
    }
    const prngState: string = prngRow.state;

    const genesisRow = readOrCorrupt(
      () =>
        db.query("SELECT data FROM genesis WHERE id = 1").get() as {
          data: string;
        } | null,
      "archive genesis table is missing or unreadable",
    );
    if (!genesisRow) {
      throw new ImportError("corrupt", "archive genesis row is missing");
    }
    const genesisProjections = readOrCorrupt(
      () => projectionsCodec.decode(JSON.parse(genesisRow.data)),
      "archive genesis row is not valid JSON or failed to decode",
    );
    const genesisLastSequence = extractLastSequence(genesisProjections);
    if (genesisLastSequence !== undefined && genesisLastSequence !== 0) {
      throw new ImportError(
        "inconsistent-manifest",
        `archive genesis projection's lastSequence is ${genesisLastSequence}, expected 0`,
      );
    }

    const projectionsRow = readOrCorrupt(
      () =>
        db
          .query("SELECT revision, data FROM projections WHERE id = 1")
          .get() as {
          revision: number;
          data: string;
        } | null,
      "archive projections table is missing or unreadable",
    );
    if (!projectionsRow) {
      throw new ImportError("corrupt", "archive projections row is missing");
    }
    if (projectionsRow.revision !== manifest.eventSequence) {
      throw new ImportError(
        "inconsistent-manifest",
        `archive's projections row revision is ${projectionsRow.revision}, but its manifest declares event sequence ${manifest.eventSequence}`,
      );
    }
    const liveProjections = readOrCorrupt(
      () => projectionsCodec.decode(JSON.parse(projectionsRow.data)),
      "archive projections row is not valid JSON or failed to decode",
    );
    const liveLastSequence = extractLastSequence(liveProjections);
    if (
      liveLastSequence !== undefined &&
      liveLastSequence !== manifest.eventSequence
    ) {
      throw new ImportError(
        "inconsistent-manifest",
        `archive's live projection lastSequence is ${liveLastSequence}, but its manifest declares event sequence ${manifest.eventSequence}`,
      );
    }

    // --- Staging: only validated values ever reach here -------------------
    if (!existsSync(slotsDir)) {
      createDirMode0700(slotsDir);
    }
    const slotId = `slot-${randomUUID()}`;
    const stagingDir = join(slotsDir, `.staging-${randomUUID()}`);
    createDirMode0700(stagingDir);

    try {
      const stagingDbPath = join(stagingDir, "world.sqlite");
      const stagingDb = new Database(stagingDbPath, { create: true });
      try {
        createSchema(stagingDb);
        stagingDb.exec("PRAGMA journal_mode = WAL");
        stagingDb
          .transaction(() => {
            stagingDb.run("INSERT INTO world (id, world_id) VALUES (1, ?)", [
              worldId,
            ]);
            stagingDb.run(
              "INSERT INTO clock (id, cursor_wall_ms, paused, tick, sim_time_ms) VALUES (1, ?, ?, ?, ?)",
              [
                clockRow.cursor_wall_ms,
                clockRow.paused,
                clockRow.tick,
                clockRow.sim_time_ms,
              ],
            );
            stagingDb.run("INSERT INTO prng_state (id, state) VALUES (1, ?)", [
              prngState,
            ]);
            stagingDb.run("INSERT INTO genesis (id, data) VALUES (1, ?)", [
              genesisRow.data,
            ]);
            stagingDb.run(
              "INSERT INTO projections (id, revision, data) VALUES (1, ?, ?)",
              [projectionsRow.revision, projectionsRow.data],
            );
            // A statement iterator, not `.all()`, so memory stays flat
            // regardless of event-log size. Each row is parsed and
            // validated here, in the same pass that writes it into
            // staging: the stored sequence/id/kind/correlation/causation
            // columns come from the parsed event, never copied from the
            // archive's own denormalized columns. The archive's own
            // columns are read only to cross-check them against the
            // parsed payload's own fields -- an archive whose row and
            // payload disagree about an event's own identity, or whose
            // payload sequences skip a number, is corrupt even when its
            // manifest and content hash are internally self-consistent.
            const eventRows = db
              .query(
                "SELECT sequence, id, correlation_id, causation_id, kind, payload FROM events ORDER BY sequence ASC",
              )
              .iterate() as IterableIterator<{
              sequence: number;
              id: string;
              correlation_id: string;
              causation_id: string;
              kind: string;
              payload: string;
            }>;
            let expectedSequence = 1;
            let lastWrittenSequence = 0;
            for (const row of eventRows) {
              const raw = readOrCorrupt(
                () => JSON.parse(row.payload) as unknown,
                "event row has invalid JSON payload",
              );
              if (!isRecord(raw)) {
                throw new ImportError(
                  "corrupt",
                  "event row payload is not an object",
                );
              }
              if (raw.schemaVersion !== LATEST_EVENT_SCHEMA_VERSION) {
                throw new ImportError(
                  "incompatible-version",
                  `event payload schema version ${String(raw.schemaVersion)} does not match this build's version ${LATEST_EVENT_SCHEMA_VERSION}`,
                );
              }
              const parsed = parseEvent(raw);
              if (!parsed.ok) {
                throw new ImportError(
                  "corrupt",
                  `event row failed to parse: ${parsed.message}`,
                );
              }
              const event: WorldEvent = parsed.value;
              if (event.sequence !== row.sequence) {
                throw new ImportError(
                  "corrupt",
                  `event payload's sequence (${event.sequence}) does not match its own row's sequence column (${row.sequence})`,
                );
              }
              if (event.id !== row.id) {
                throw new ImportError(
                  "corrupt",
                  `event payload's id (${event.id}) does not match its own row's id column (${row.id})`,
                );
              }
              if (event.kind !== row.kind) {
                throw new ImportError(
                  "corrupt",
                  `event payload's kind (${event.kind}) does not match its own row's kind column (${row.kind})`,
                );
              }
              if (event.correlationId !== row.correlation_id) {
                throw new ImportError(
                  "corrupt",
                  `event payload's correlationId (${event.correlationId}) does not match its own row's correlation_id column (${row.correlation_id})`,
                );
              }
              if (event.causationId !== row.causation_id) {
                throw new ImportError(
                  "corrupt",
                  `event payload's causationId (${event.causationId}) does not match its own row's causation_id column (${row.causation_id})`,
                );
              }
              if (event.sequence !== expectedSequence) {
                throw new ImportError(
                  "inconsistent-manifest",
                  `archive event log is not contiguous: expected sequence ${expectedSequence}, found ${event.sequence}`,
                );
              }
              expectedSequence += 1;
              lastWrittenSequence = event.sequence;
              stagingDb.run(
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
            if (lastWrittenSequence !== manifest.eventSequence) {
              throw new ImportError(
                "inconsistent-manifest",
                `archive's event log ends at sequence ${lastWrittenSequence}, but its manifest declares ${manifest.eventSequence}`,
              );
            }
            // The journal: every entry is parsed as the versioned proposal
            // and observation it claims to be, must follow the previous
            // entry's input order, and may only have been consumed by a
            // tick this archive's own clock has reached.
            const journalRows = db
              .query(
                "SELECT input_order, proposal_id, target_tick, proposal, observation, consumed_tick FROM external_proposals ORDER BY input_order ASC",
              )
              .iterate() as IterableIterator<JournalRow>;
            let expectedOrder = 1;
            for (const row of journalRows) {
              if (row.input_order !== expectedOrder) {
                throw new ImportError(
                  "inconsistent-manifest",
                  `archive journal is not contiguous: expected input order ${expectedOrder}, found ${row.input_order}`,
                );
              }
              expectedOrder += 1;
              const proposal = parseProposal(
                readOrCorrupt(
                  () => JSON.parse(row.proposal) as unknown,
                  "journal entry has invalid JSON proposal",
                ),
              );
              const observation = parseObservationRecord(
                readOrCorrupt(
                  () => JSON.parse(row.observation) as unknown,
                  "journal entry has invalid JSON observation",
                ),
              );
              if (!proposal.ok || !observation.ok) {
                throw new ImportError(
                  "corrupt",
                  `journal entry ${row.proposal_id} failed to parse`,
                );
              }
              // Live intake requires the proposal to cite the observation
              // it is stored with; an archive must hold the same pairing.
              if (proposal.value.observationId !== observation.value.id) {
                throw new ImportError(
                  "corrupt",
                  `journal entry ${row.proposal_id}: proposal.observationId does not match observation.id`,
                );
              }
              if (
                typeof row.proposal_id !== "string" ||
                row.proposal_id.length === 0 ||
                !Number.isInteger(row.target_tick) ||
                row.target_tick < 1 ||
                (row.consumed_tick !== null &&
                  (!Number.isInteger(row.consumed_tick) ||
                    row.consumed_tick < 1 ||
                    row.consumed_tick < row.target_tick ||
                    row.consumed_tick > clockRow.tick))
              ) {
                throw new ImportError(
                  "corrupt",
                  `journal entry ${String(row.proposal_id)} has an invalid id, target tick, or consumed tick (a tick consumes an entry no earlier than its target)`,
                );
              }
              stagingDb.run(
                `INSERT INTO external_proposals (input_order, proposal_id, target_tick, proposal, observation, consumed_tick)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                  row.input_order,
                  row.proposal_id,
                  row.target_tick,
                  JSON.stringify(proposal.value),
                  JSON.stringify(observation.value),
                  row.consumed_tick,
                ],
              );
            }
          })
          .immediate();
        stagingDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        stagingDb.close();
      }
      archiveDb.close();
      archiveDb = undefined;
      chmodSync(stagingDbPath, 0o600);
      fsyncFile(stagingDbPath);

      const finalDir = join(slotsDir, slotId);
      if (existsSync(finalDir)) {
        throw new Error(
          `import: generated slot ID ${slotId} already exists; refusing to overwrite`,
        );
      }
      renameSync(stagingDir, finalDir);
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
  }
}
