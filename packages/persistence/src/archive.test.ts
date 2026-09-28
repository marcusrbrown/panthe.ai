import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCausationId,
  createCorrelationId,
  createEntityId,
  createEventId,
  type EntityMovedEvent,
  LATEST_EVENT_SCHEMA_VERSION,
} from "@panthea/contracts";
import {
  canonicalDump,
  computeContentHash,
  exportArchive,
  fsyncDirectoryBestEffort,
  fsyncFile,
  ImportError,
  type ImportLimits,
  importArchive,
  isTolerableFsyncError,
} from "./archive";
import { LATEST_SCHEMA_VERSION } from "./migrations";
import {
  closeStore,
  commitTick,
  getCurrentSequence,
  openStore,
  type ProjectionReducers,
  readClock,
  readLiveProjections,
  type Store,
} from "./store";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "panthea-archive-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface CountProjection {
  readonly total: number;
}

const reducer: ProjectionReducers<CountProjection> = {
  initial: { total: 0 },
  applyEvent(projections) {
    return { total: projections.total + 1 };
  },
};

function makeMoveEvent(sequence: number): EntityMovedEvent {
  return {
    schemaVersion: 2,
    id: createEventId(),
    sequence,
    simTime: sequence,
    correlationId: createCorrelationId(),
    causationId: createCausationId(),
    approximate: false,
    kind: "entity-moved",
    entityId: createEntityId(),
    to: createEntityId(),
  };
}

function buildPopulatedStore(dbPath: string): Store {
  const store = openStore(dbPath);
  for (let i = 1; i <= 3; i++) {
    commitTick(store, reducer, {
      events: [makeMoveEvent(i)],
      cursorWallMs: 1000 * i,
      paused: false,
      prngState: `seed-${i}`,
    });
  }
  return store;
}

const generousLimits: ImportLimits = {
  maxBytes: 10 * 1024 * 1024,
  maxRows: 10_000,
  maxDurationMs: 30_000,
};

describe("exportArchive", () => {
  test("happy path: same world exported twice yields the same content hash", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);

    const archivePath1 = join(dir, "archive1.sqlite");
    const archivePath2 = join(dir, "archive2.sqlite");
    const manifest1 = exportArchive(store, archivePath1);
    const manifest2 = exportArchive(store, archivePath2);

    expect(manifest1.contentHash).toBe(manifest2.contentHash);
    expect(manifest1.eventSequence).toBe(manifest2.eventSequence);
    closeStore(store);
  });

  test("happy path: export includes the event log and causal IDs but excludes observation/rejection/receipt records (persistence never stores them)", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);
    closeStore(store);

    const archiveDb = new Database(archivePath, { readonly: true });
    const tableNames = (
      archiveDb
        .query("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(tableNames.sort()).toEqual(
      [
        "clock",
        "events",
        "manifest",
        "prng_state",
        "projections",
        "world",
      ].sort(),
    );
    const events = archiveDb.query("SELECT * FROM events").all() as {
      correlation_id: string;
      causation_id: string;
    }[];
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event.correlation_id).toBeTruthy();
      expect(event.causation_id).toBeTruthy();
    }
    archiveDb.close();
  });

  test("edge case: export while ticking always reflects one committed sequence; manifest sequence matches archive contents", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    const manifest = exportArchive(store, archivePath);
    expect(manifest.eventSequence).toBe(getCurrentSequence(store.db));

    const archiveDb = new Database(archivePath, { readonly: true });
    const maxSeq = (
      archiveDb.query("SELECT MAX(sequence) as m FROM events").get() as {
        m: number;
      }
    ).m;
    expect(maxSeq).toBe(manifest.eventSequence);
    archiveDb.close();
    closeStore(store);
  });
});

describe("importArchive", () => {
  function exportFreshArchive(): {
    store: Store;
    archivePath: string;
    dbPath: string;
  } {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);
    return { store, archivePath, dbPath };
  }

  test("happy path: export -> import creates a new slot with identical IDs, sequence, projections, and PRNG state; the source is untouched", () => {
    const { store, archivePath, dbPath } = exportFreshArchive();
    const beforeSourceHash = readFileSync(dbPath);

    const slotsDir = join(dir, "slots");
    const result = importArchive(archivePath, slotsDir, generousLimits);

    expect(existsSync(result.slotPath)).toBe(true);
    // Read-write, not readonly: the imported slot is a live WAL-mode store
    // (like any other slot), and opening a WAL database read-only requires
    // creating a -shm reader lock file, which a read-only handle cannot do.
    const importedDb = new Database(join(result.slotPath, "world.sqlite"));
    const worldRow = importedDb.query("SELECT world_id FROM world").get() as {
      world_id: string;
    };
    expect(worldRow.world_id).toBe(store.worldId);

    const importedSequence = (
      importedDb.query("SELECT MAX(sequence) as m FROM events").get() as {
        m: number;
      }
    ).m;
    expect(importedSequence).toBe(getCurrentSequence(store.db));

    const importedProjections = importedDb
      .query("SELECT data FROM projections WHERE id = 1")
      .get() as { data: string };
    expect(JSON.parse(importedProjections.data)).toEqual(
      readLiveProjections(store, reducer),
    );

    const importedPrng = importedDb
      .query("SELECT state FROM prng_state WHERE id = 1")
      .get() as { state: string };
    expect(importedPrng.state).toBe("seed-3");

    const importedClock = importedDb
      .query("SELECT cursor_wall_ms, paused FROM clock WHERE id = 1")
      .get() as { cursor_wall_ms: number; paused: number };
    expect({
      cursorWallMs: importedClock.cursor_wall_ms,
      paused: importedClock.paused !== 0,
    }).toEqual(readClock(store.db));

    importedDb.close();

    // Source untouched.
    expect(readFileSync(dbPath)).toEqual(beforeSourceHash);
    closeStore(store);
  });

  test("happy path: import never overwrites an existing slot (each import gets a fresh slot ID)", () => {
    const { store, archivePath } = exportFreshArchive();
    const slotsDir = join(dir, "slots");
    const first = importArchive(archivePath, slotsDir, generousLimits);
    const second = importArchive(archivePath, slotsDir, generousLimits);
    expect(first.slotId).not.toBe(second.slotId);
    expect(first.slotPath).not.toBe(second.slotPath);
    expect(existsSync(first.slotPath)).toBe(true);
    expect(existsSync(second.slotPath)).toBe(true);
    closeStore(store);
  });

  test("error path: a truncated archive file is rejected as corrupt; no slot is created", () => {
    const { store, archivePath } = exportFreshArchive();
    const truncatedPath = join(dir, "truncated.sqlite");
    const bytes = readFileSync(archivePath);
    writeFileSync(
      truncatedPath,
      bytes.subarray(0, Math.floor(bytes.length / 4)),
    );

    const slotsDir = join(dir, "slots");
    let caught: unknown;
    try {
      importArchive(truncatedPath, slotsDir, generousLimits);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ImportError);
    expect((caught as ImportError).kind).toBe("corrupt");
    expect(existsSync(slotsDir) ? readdirSync(slotsDir) : []).toHaveLength(0);
    closeStore(store);
  });

  test("error path: a flipped byte in the payload is rejected (hash mismatch or corrupt), distinct from other failures; no slot is created", () => {
    const { store, archivePath } = exportFreshArchive();
    const flippedPath = join(dir, "flipped.sqlite");
    const bytes = readFileSync(archivePath);
    const mutable = Buffer.from(bytes);
    // Flip a byte roughly in the middle of the file, away from the header,
    // likely landing inside a page's payload rather than corrupting the
    // format entirely.
    const offset = Math.floor(mutable.length / 2);
    mutable[offset] = (mutable[offset] ?? 0) ^ 0xff;
    writeFileSync(flippedPath, mutable);

    const slotsDir = join(dir, "slots");
    let caught: unknown;
    try {
      importArchive(flippedPath, slotsDir, generousLimits);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ImportError);
    expect(["hash-mismatch", "corrupt"]).toContain(
      (caught as ImportError).kind,
    );
    expect(existsSync(slotsDir) ? readdirSync(slotsDir) : []).toHaveLength(0);
    closeStore(store);
  });

  test("error path: a manifest reporting an unsupported (future) SQLite schema version is rejected distinctly; no slot is created", () => {
    const { store, archivePath } = exportFreshArchive();
    const archiveDb = new Database(archivePath);
    archiveDb.run("UPDATE manifest SET sqlite_schema_version = ?", [
      LATEST_SCHEMA_VERSION + 100,
    ]);
    archiveDb.close();

    const slotsDir = join(dir, "slots");
    let caught: unknown;
    try {
      importArchive(archivePath, slotsDir, generousLimits);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ImportError);
    expect((caught as ImportError).kind).toBe("unsupported-version");
    expect(existsSync(slotsDir) ? readdirSync(slotsDir) : []).toHaveLength(0);
    closeStore(store);
  });

  test("error path: a missing manifest table is rejected distinctly; no slot is created", () => {
    const { store, archivePath } = exportFreshArchive();
    const archiveDb = new Database(archivePath);
    archiveDb.exec("DROP TABLE manifest");
    archiveDb.close();

    const slotsDir = join(dir, "slots");
    let caught: unknown;
    try {
      importArchive(archivePath, slotsDir, generousLimits);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ImportError);
    expect((caught as ImportError).kind).toBe("missing-manifest");
    expect(existsSync(slotsDir) ? readdirSync(slotsDir) : []).toHaveLength(0);
    closeStore(store);
  });

  test("error path: an archive containing a view is rejected before any slot is created", () => {
    const { store, archivePath } = exportFreshArchive();
    const archiveDb = new Database(archivePath);
    archiveDb.exec("CREATE VIEW events_view AS SELECT * FROM events");
    archiveDb.close();

    const slotsDir = join(dir, "slots");
    let caught: unknown;
    try {
      importArchive(archivePath, slotsDir, generousLimits);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ImportError);
    expect((caught as ImportError).kind).toBe("disallowed-schema");
    expect(existsSync(slotsDir) ? readdirSync(slotsDir) : []).toHaveLength(0);
    closeStore(store);
  });

  test("error path: an archive containing a trigger is rejected before any slot is created", () => {
    const { store, archivePath } = exportFreshArchive();
    const archiveDb = new Database(archivePath);
    archiveDb.exec(`
      CREATE TABLE trigger_target (id INTEGER PRIMARY KEY) STRICT;
      CREATE TRIGGER evil_trigger AFTER INSERT ON events
      BEGIN
        INSERT INTO trigger_target (id) VALUES (1);
      END;
    `);
    archiveDb.close();

    const slotsDir = join(dir, "slots");
    let caught: unknown;
    try {
      importArchive(archivePath, slotsDir, generousLimits);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ImportError);
    expect((caught as ImportError).kind).toBe("disallowed-schema");
    expect(existsSync(slotsDir) ? readdirSync(slotsDir) : []).toHaveLength(0);
    closeStore(store);
  });

  test("error path: an archive containing an unexpected table is rejected before any slot is created", () => {
    const { store, archivePath } = exportFreshArchive();
    const archiveDb = new Database(archivePath);
    archiveDb.exec("CREATE TABLE sneaky (id INTEGER PRIMARY KEY) STRICT");
    archiveDb.close();

    const slotsDir = join(dir, "slots");
    let caught: unknown;
    try {
      importArchive(archivePath, slotsDir, generousLimits);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ImportError);
    expect((caught as ImportError).kind).toBe("disallowed-schema");
    expect(existsSync(slotsDir) ? readdirSync(slotsDir) : []).toHaveLength(0);
    closeStore(store);
  });

  test("error path: an archive over the configured byte limit is rejected before staging", () => {
    const { store, archivePath } = exportFreshArchive();
    const tinyLimits: ImportLimits = {
      maxBytes: 10,
      maxRows: 10_000,
      maxDurationMs: 30_000,
    };
    const slotsDir = join(dir, "slots");
    let caught: unknown;
    try {
      importArchive(archivePath, slotsDir, tinyLimits);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ImportError);
    expect((caught as ImportError).kind).toBe("over-limit-bytes");
    expect(existsSync(slotsDir) ? readdirSync(slotsDir) : []).toHaveLength(0);
    closeStore(store);
  });

  test("error path: an archive over the configured row limit is rejected before staging", () => {
    const { store, archivePath } = exportFreshArchive();
    const tinyRowLimits: ImportLimits = {
      maxBytes: 10 * 1024 * 1024,
      maxRows: 1,
      maxDurationMs: 30_000,
    };
    const slotsDir = join(dir, "slots");
    let caught: unknown;
    try {
      importArchive(archivePath, slotsDir, tinyRowLimits);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ImportError);
    expect((caught as ImportError).kind).toBe("over-limit-rows");
    expect(existsSync(slotsDir) ? readdirSync(slotsDir) : []).toHaveLength(0);
    closeStore(store);
  });

  test("error path: an archive validated past the configured time budget is rejected before staging", () => {
    const { store, archivePath } = exportFreshArchive();
    const expiredLimits: ImportLimits = {
      maxBytes: 10 * 1024 * 1024,
      maxRows: 10_000,
      maxDurationMs: -1,
    };
    const slotsDir = join(dir, "slots");
    let caught: unknown;
    try {
      importArchive(archivePath, slotsDir, expiredLimits);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ImportError);
    expect((caught as ImportError).kind).toBe("over-limit-time");
    expect(existsSync(slotsDir) ? readdirSync(slotsDir) : []).toHaveLength(0);
    closeStore(store);
  });

  test("error path: a copy failure while staging the private archive copy leaves no temp file behind", () => {
    // A directory in place of the archive file makes `copyFileSync` fail
    // (EISDIR) after the earlier existsSync/statSync checks have already
    // passed, exercising the copy-step failure path specifically.
    const bogusArchivePath = join(dir, "archive-is-a-directory");
    mkdirSync(bogusArchivePath);
    const slotsDir = join(dir, "slots");

    const tempFilesBefore = readdirSync(tmpdir()).filter((name) =>
      name.startsWith("panthea-import-"),
    );

    let caught: unknown;
    try {
      importArchive(bogusArchivePath, slotsDir, generousLimits);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();

    const tempFilesAfter = readdirSync(tmpdir()).filter((name) =>
      name.startsWith("panthea-import-"),
    );
    expect(tempFilesAfter).toEqual(tempFilesBefore);
  });

  test("error path: the time budget is enforced during staging, not only before it", () => {
    const { store, archivePath } = exportFreshArchive();
    const slotsDir = join(dir, "slots");
    const staleLimits: ImportLimits = {
      maxBytes: 10 * 1024 * 1024,
      maxRows: 10_000,
      maxDurationMs: 30_000,
    };
    const realNow = Date.now();
    let calls = 0;
    // The first three checkDeadline calls happen during pre-staging
    // validation (start, post-row-count, post-hash-check); returning the
    // real clock for those lets validation succeed normally so staging is
    // actually reached. From the fourth call onward -- staging's own
    // checkDeadline calls, the first of which guards the copy transaction
    // -- return a time past the deadline to force an over-limit-time abort
    // mid-staging, after the staging directory already exists.
    const now = () => {
      calls += 1;
      return calls <= 3 ? realNow : realNow + staleLimits.maxDurationMs + 1;
    };

    let caught: unknown;
    try {
      importArchive(archivePath, slotsDir, staleLimits, now);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ImportError);
    expect((caught as ImportError).kind).toBe("over-limit-time");
    expect(existsSync(slotsDir) ? readdirSync(slotsDir) : []).toHaveLength(0);
    closeStore(store);
  });
});

describe("importArchive manifest integrity", () => {
  function exportFreshArchive(): { store: Store; archivePath: string } {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);
    return { store, archivePath };
  }

  test("error path: a manifest-only tamper of eventSequence (hash left alone) is rejected as a manifest mismatch, distinct from a hash mismatch; no slot is created", () => {
    const { store, archivePath } = exportFreshArchive();
    const archiveDb = new Database(archivePath);
    archiveDb.run("UPDATE manifest SET event_sequence = ?", [999]);
    archiveDb.close();

    const slotsDir = join(dir, "slots");
    let caught: unknown;
    try {
      importArchive(archivePath, slotsDir, generousLimits);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ImportError);
    expect((caught as ImportError).kind).toBe("manifest-mismatch");
    expect(existsSync(slotsDir) ? readdirSync(slotsDir) : []).toHaveLength(0);
    closeStore(store);
  });

  test("error path: a manifest-only tamper of worldId (hash left alone) is rejected as a manifest mismatch; no slot is created", () => {
    const { store, archivePath } = exportFreshArchive();
    const archiveDb = new Database(archivePath);
    archiveDb.run("UPDATE manifest SET world_id = ?", [
      "world-not-the-real-one",
    ]);
    archiveDb.close();

    const slotsDir = join(dir, "slots");
    let caught: unknown;
    try {
      importArchive(archivePath, slotsDir, generousLimits);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ImportError);
    expect((caught as ImportError).kind).toBe("manifest-mismatch");
    expect(existsSync(slotsDir) ? readdirSync(slotsDir) : []).toHaveLength(0);
    closeStore(store);
  });

  test("error path: a manifest-only tamper of a version field (hash left alone) is rejected as a hash mismatch, since no other table can cross-check a version claim; no slot is created", () => {
    const { store, archivePath } = exportFreshArchive();
    const archiveDb = new Database(archivePath);
    // 0 is a valid non-negative integer and still <= LATEST_SCHEMA_VERSION,
    // so this does not trip the explicit "newer than we understand" gate --
    // only hash binding can catch it.
    archiveDb.run("UPDATE manifest SET sqlite_schema_version = 0");
    archiveDb.close();

    const slotsDir = join(dir, "slots");
    let caught: unknown;
    try {
      importArchive(archivePath, slotsDir, generousLimits);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ImportError);
    expect((caught as ImportError).kind).toBe("hash-mismatch");
    expect(existsSync(slotsDir) ? readdirSync(slotsDir) : []).toHaveLength(0);
    closeStore(store);
  });

  test("happy path: a clean archive still round-trips with an identical hash when exported twice (no false positives from the manifest binding)", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath1 = join(dir, "clean1.sqlite");
    const archivePath2 = join(dir, "clean2.sqlite");
    const manifest1 = exportArchive(store, archivePath1);
    const manifest2 = exportArchive(store, archivePath2);
    expect(manifest1.contentHash).toBe(manifest2.contentHash);

    const slotsDir = join(dir, "slots");
    const result = importArchive(archivePath1, slotsDir, generousLimits);
    expect(existsSync(result.slotPath)).toBe(true);
    closeStore(store);
  });

  test("happy path: all events are copied unconditionally (not filtered by the manifest's eventSequence) once the manifest is verified to match", () => {
    const { store, archivePath } = exportFreshArchive();
    const slotsDir = join(dir, "slots");
    const result = importArchive(archivePath, slotsDir, generousLimits);
    const importedDb = new Database(join(result.slotPath, "world.sqlite"));
    const count = (
      importedDb.query("SELECT COUNT(*) as c FROM events").get() as {
        c: number;
      }
    ).c;
    expect(count).toBe(3);
    importedDb.close();
    closeStore(store);
  });
});

describe("importArchive future payload version", () => {
  test("error path: a manifest reporting an unsupported (future) payload schema version is rejected distinctly from the SQLite schema version gate; no slot is created", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const archiveDb = new Database(archivePath);
    archiveDb.run("UPDATE manifest SET payload_schema_version = ?", [
      LATEST_EVENT_SCHEMA_VERSION + 100,
    ]);
    archiveDb.close();

    const slotsDir = join(dir, "slots");
    let caught: unknown;
    try {
      importArchive(archivePath, slotsDir, generousLimits);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ImportError);
    expect((caught as ImportError).kind).toBe("unsupported-version");
    expect(existsSync(slotsDir) ? readdirSync(slotsDir) : []).toHaveLength(0);
    closeStore(store);
  });
});

describe("fsync durability helpers", () => {
  test("isTolerableFsyncError recognizes the well-known directory-fsync refusal codes and nothing else", () => {
    expect(isTolerableFsyncError({ code: "EISDIR" })).toBe(true);
    expect(isTolerableFsyncError({ code: "EINVAL" })).toBe(true);
    expect(isTolerableFsyncError({ code: "EPERM" })).toBe(true);
    expect(isTolerableFsyncError({ code: "ENOENT" })).toBe(false);
    expect(isTolerableFsyncError(new Error("no code"))).toBe(false);
    expect(isTolerableFsyncError(undefined)).toBe(false);
  });

  test("fsyncFile succeeds on a real file", () => {
    const filePath = join(dir, "fsync-target.txt");
    writeFileSync(filePath, "hello");
    expect(() => fsyncFile(filePath)).not.toThrow();
  });

  test("fsyncFile propagates a genuine error (missing file)", () => {
    expect(() => fsyncFile(join(dir, "does-not-exist.txt"))).toThrow();
  });

  test("fsyncDirectoryBestEffort succeeds on a real directory", () => {
    expect(() => fsyncDirectoryBestEffort(dir)).not.toThrow();
  });

  test("fsyncDirectoryBestEffort propagates a genuine (non-tolerable) error for a missing directory", () => {
    expect(() =>
      fsyncDirectoryBestEffort(join(dir, "does-not-exist-dir")),
    ).toThrow();
  });

  test("exportArchive still succeeds end-to-end with fsync calls exercised on the happy path", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "durable.sqlite");
    const manifest = exportArchive(store, archivePath);
    expect(existsSync(archivePath)).toBe(true);
    expect(manifest.eventSequence).toBe(3);
    closeStore(store);
  });

  test("importArchive still succeeds end-to-end with fsync calls exercised during staging", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "durable-import.sqlite");
    exportArchive(store, archivePath);
    const slotsDir = join(dir, "slots");
    const result = importArchive(archivePath, slotsDir, generousLimits);
    expect(existsSync(join(result.slotPath, "world.sqlite"))).toBe(true);
    closeStore(store);
  });
});

describe("computeContentHash / canonicalDump", () => {
  const manifestFields = {
    formatVersion: 1,
    sqliteSchemaVersion: LATEST_SCHEMA_VERSION,
    payloadSchemaVersion: 1,
    worldId: "world-fixture" as never,
    eventSequence: 2,
  };

  function makeFixtureDb(path: string): Database {
    const db = new Database(path, { create: true });
    db.exec(
      "CREATE TABLE world (id INTEGER PRIMARY KEY, world_id TEXT NOT NULL) STRICT",
    );
    db.exec(
      "CREATE TABLE clock (id INTEGER PRIMARY KEY, cursor_wall_ms INTEGER NOT NULL, paused INTEGER NOT NULL) STRICT",
    );
    db.exec(
      "CREATE TABLE prng_state (id INTEGER PRIMARY KEY, state TEXT NOT NULL) STRICT",
    );
    db.exec(
      "CREATE TABLE projections (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL) STRICT",
    );
    db.exec(
      "CREATE TABLE events (sequence INTEGER PRIMARY KEY, id TEXT NOT NULL, correlation_id TEXT NOT NULL, causation_id TEXT NOT NULL, kind TEXT NOT NULL, approximate INTEGER NOT NULL, payload TEXT NOT NULL) STRICT",
    );
    db.run("INSERT INTO world (id, world_id) VALUES (1, 'w')");
    db.run("INSERT INTO clock (id, cursor_wall_ms, paused) VALUES (1, 0, 0)");
    db.run("INSERT INTO prng_state (id, state) VALUES (1, '')");
    db.run(
      "INSERT INTO projections (id, revision, data) VALUES (1, 0, 'null')",
    );
    return db;
  }

  test("identical data yields an identical hash regardless of insertion order (fixed table order, rows ordered by primary key)", () => {
    const db1 = makeFixtureDb(join(dir, "a.sqlite"));
    const db2 = makeFixtureDb(join(dir, "b.sqlite"));
    // Insert events in reverse order between the two DBs — the canonical
    // dump orders by primary key, so insertion order must not matter.
    db1.run(
      "INSERT INTO events (sequence, id, correlation_id, causation_id, kind, approximate, payload) VALUES (1, 'e1', 'c1', 'k1', 'kind', 0, '{}')",
    );
    db1.run(
      "INSERT INTO events (sequence, id, correlation_id, causation_id, kind, approximate, payload) VALUES (2, 'e2', 'c2', 'k2', 'kind', 0, '{}')",
    );
    db2.run(
      "INSERT INTO events (sequence, id, correlation_id, causation_id, kind, approximate, payload) VALUES (2, 'e2', 'c2', 'k2', 'kind', 0, '{}')",
    );
    db2.run(
      "INSERT INTO events (sequence, id, correlation_id, causation_id, kind, approximate, payload) VALUES (1, 'e1', 'c1', 'k1', 'kind', 0, '{}')",
    );

    expect(computeContentHash(db1, manifestFields)).toBe(
      computeContentHash(db2, manifestFields),
    );
    expect(canonicalDump(db1, manifestFields)).toBe(
      canonicalDump(db2, manifestFields),
    );
    db1.close();
    db2.close();
  });

  test("the manifest fields are bound into the hash: changing any one of them changes the hash even though the tables are identical", () => {
    const db = makeFixtureDb(join(dir, "c.sqlite"));
    const baseline = computeContentHash(db, manifestFields);

    expect(
      computeContentHash(db, { ...manifestFields, eventSequence: 3 }),
    ).not.toBe(baseline);
    expect(
      computeContentHash(db, {
        ...manifestFields,
        worldId: "world-other" as never,
      }),
    ).not.toBe(baseline);
    expect(
      computeContentHash(db, { ...manifestFields, sqliteSchemaVersion: 0 }),
    ).not.toBe(baseline);
    db.close();
  });
});
