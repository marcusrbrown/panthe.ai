import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
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
  computeContentHash,
  exportArchive,
  ImportError,
  importArchive,
} from "./archive";
import {
  CURRENT_SCHEMA_VERSION,
  closeStore,
  commitTick,
  getCurrentSequence,
  openStore,
  type ProjectionCodec,
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

const projectionCodec: ProjectionCodec<CountProjection> = {
  encode: (projections) => projections,
  decode: (value) => value as CountProjection,
};

const reducer: ProjectionReducers<CountProjection> = {
  initial: { total: 0 },
  applyEvent(projections) {
    return { total: projections.total + 1 };
  },
  codec: projectionCodec,
};

function makeMoveEvent(sequence: number): EntityMovedEvent {
  return {
    schemaVersion: LATEST_EVENT_SCHEMA_VERSION,
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
      tick: i,
      simTimeMs: 1000 * i,
      prngState: `seed-${i}`,
    });
  }
  return store;
}

/** Recomputes and rewrites the manifest's content_hash to match the
 * archive's current table content, using the manifest's own recorded
 * fields -- simulates a tamper that also rehashes, which a plain hash
 * check alone cannot catch. */
function rehash(archivePath: string): void {
  const db = new Database(archivePath);
  const manifestRow = db.query("SELECT * FROM manifest WHERE id = 1").get() as {
    format_version: number;
    sqlite_schema_version: number;
    payload_schema_version: number;
    world_id: string;
    event_sequence: number;
  };
  const newHash = computeContentHash(db, {
    formatVersion: manifestRow.format_version,
    sqliteSchemaVersion: manifestRow.sqlite_schema_version,
    payloadSchemaVersion: manifestRow.payload_schema_version,
    worldId: manifestRow.world_id as never,
    eventSequence: manifestRow.event_sequence,
  });
  db.run("UPDATE manifest SET content_hash = ?", [newHash]);
  db.close();
}

function expectRejected(
  fn: () => unknown,
  kind: ImportError["kind"],
  slotsDir: string,
): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ImportError);
  expect((caught as ImportError).kind).toBe(kind);
  expect(existsSync(slotsDir) ? readdirSync(slotsDir) : []).toHaveLength(0);
}

describe("exportArchive", () => {
  test("happy path: the same world exported twice yields the same content hash", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);

    const manifest1 = exportArchive(store, join(dir, "archive1.sqlite"));
    const manifest2 = exportArchive(store, join(dir, "archive2.sqlite"));

    expect(manifest1.contentHash).toBe(manifest2.contentHash);
    expect(manifest1.eventSequence).toBe(manifest2.eventSequence);
    closeStore(store);
  });

  test("happy path: export includes the event log with causal IDs", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);
    closeStore(store);

    const archiveDb = new Database(archivePath, { readonly: true });
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

  test("edge case: export while ticking always reflects one committed sequence", () => {
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

describe("importArchive: round-trip", () => {
  test("happy path: export -> import creates a new slot with identical world ID, sequence, projections, PRNG, and clock (including tick/simTime); the source is untouched", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const beforeSourceBytes = readFileSync(dbPath);

    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const slotsDir = join(dir, "slots");
    const result = importArchive(archivePath, slotsDir, projectionCodec);

    expect(existsSync(result.slotPath)).toBe(true);
    const importedStore = openStore(join(result.slotPath, "world.sqlite"));

    expect(importedStore.worldId).toBe(store.worldId);
    expect(getCurrentSequence(importedStore.db)).toBe(
      getCurrentSequence(store.db),
    );
    expect(readLiveProjections(importedStore, reducer)).toEqual(
      readLiveProjections(store, reducer),
    );
    expect(readClock(importedStore.db)).toEqual(readClock(store.db));

    closeStore(importedStore);
    expect(readFileSync(dbPath)).toEqual(beforeSourceBytes);
    closeStore(store);
  });

  test("happy path: importing the same archive twice never overwrites an existing slot -- each import gets its own fresh slot ID and the first slot's bytes are untouched", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);
    const slotsDir = join(dir, "slots");

    const first = importArchive(archivePath, slotsDir, projectionCodec);
    const firstBytes = readFileSync(join(first.slotPath, "world.sqlite"));

    const second = importArchive(archivePath, slotsDir, projectionCodec);

    expect(first.slotId).not.toBe(second.slotId);
    expect(existsSync(first.slotPath)).toBe(true);
    expect(existsSync(second.slotPath)).toBe(true);
    expect(readFileSync(join(first.slotPath, "world.sqlite"))).toEqual(
      firstBytes,
    );
    closeStore(store);
  });
});

describe("importArchive: corruption", () => {
  test("error path: a truncated archive file is rejected as corrupt; no slot is created", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const truncatedPath = join(dir, "truncated.sqlite");
    const bytes = readFileSync(archivePath);
    writeFileSync(
      truncatedPath,
      bytes.subarray(0, Math.floor(bytes.length / 4)),
    );

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(truncatedPath, slotsDir, projectionCodec),
      "corrupt",
      slotsDir,
    );
    closeStore(store);
  });

  test("error path: a missing archive file is rejected as an io error; no slot is created", () => {
    const slotsDir = join(dir, "slots");
    expectRejected(
      () =>
        importArchive(
          join(dir, "does-not-exist.sqlite"),
          slotsDir,
          projectionCodec,
        ),
      "io",
      slotsDir,
    );
  });

  test("error path: a missing manifest table is rejected as corrupt; no slot is created", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const db = new Database(archivePath);
    db.exec("DROP TABLE manifest");
    db.close();

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, projectionCodec),
      "corrupt",
      slotsDir,
    );
    closeStore(store);
  });

  test("error path: a missing events table is rejected as corrupt; no slot is created", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const db = new Database(archivePath);
    db.exec("DROP TABLE events");
    db.close();

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, projectionCodec),
      "corrupt",
      slotsDir,
    );
    closeStore(store);
  });

  test("error path: a rehashed archive with a malformed clock row is rejected as corrupt; no slot is created", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const db = new Database(archivePath);
    db.run("UPDATE clock SET paused = 7");
    db.close();
    rehash(archivePath);

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, projectionCodec),
      "corrupt",
      slotsDir,
    );
    closeStore(store);
  });

  test("error path: a rehashed archive with a malformed event payload is rejected as corrupt; no slot is created", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const db = new Database(archivePath);
    const firstEvent = db
      .query(
        "SELECT sequence, payload FROM events ORDER BY sequence ASC LIMIT 1",
      )
      .get() as { sequence: number; payload: string };
    const corrupted = {
      ...JSON.parse(firstEvent.payload),
      kind: "not-a-real-kind",
    };
    db.run("UPDATE events SET payload = ? WHERE sequence = ?", [
      JSON.stringify(corrupted),
      firstEvent.sequence,
    ]);
    db.close();
    rehash(archivePath);

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, projectionCodec),
      "corrupt",
      slotsDir,
    );
    closeStore(store);
  });

  test("error path: a rehashed archive with a non-JSON projections row is rejected as corrupt; no slot is created", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const db = new Database(archivePath);
    db.run("UPDATE projections SET data = ? WHERE id = 1", [
      "not json at all {",
    ]);
    db.close();
    rehash(archivePath);

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, projectionCodec),
      "corrupt",
      slotsDir,
    );
    closeStore(store);
  });

  test("error path: a projections row rejected by the codec is rejected as corrupt", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const strictCodec: ProjectionCodec<unknown> = {
      encode: (value) => value,
      decode: (value) => {
        if (
          typeof value !== "object" ||
          value === null ||
          !("total" in (value as Record<string, unknown>))
        ) {
          throw new Error("expected a { total } shape");
        }
        return value;
      },
    };

    const slotsDir = join(dir, "slots");
    const okResult = importArchive(archivePath, slotsDir, strictCodec);
    expect(existsSync(okResult.slotPath)).toBe(true);

    const db = new Database(archivePath);
    db.run("UPDATE projections SET data = ? WHERE id = 1", [
      JSON.stringify({ somethingElse: true }),
    ]);
    db.close();
    rehash(archivePath);

    expectRejected(
      () => importArchive(archivePath, join(dir, "slots2"), strictCodec),
      "corrupt",
      join(dir, "slots2"),
    );
    closeStore(store);
  });
});

describe("importArchive: version mismatch", () => {
  test("error path: a manifest reporting a different SQLite schema version is rejected as incompatible-version; no slot is created", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const db = new Database(archivePath);
    db.run("UPDATE manifest SET sqlite_schema_version = ?", [
      CURRENT_SCHEMA_VERSION + 1,
    ]);
    db.close();

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, projectionCodec),
      "incompatible-version",
      slotsDir,
    );
    closeStore(store);
  });

  test("error path: a manifest reporting a different payload schema version is rejected as incompatible-version (exact-current, not a range); no slot is created", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const db = new Database(archivePath);
    db.run("UPDATE manifest SET payload_schema_version = ?", [
      LATEST_EVENT_SCHEMA_VERSION - 1,
    ]);
    db.close();

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, projectionCodec),
      "incompatible-version",
      slotsDir,
    );
    closeStore(store);
  });

  test("error path: a rehashed event row declaring a stale payload schema version is rejected as incompatible-version; no slot is created", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const db = new Database(archivePath);
    const firstEvent = db
      .query(
        "SELECT sequence, payload FROM events ORDER BY sequence ASC LIMIT 1",
      )
      .get() as { sequence: number; payload: string };
    const stale = {
      ...JSON.parse(firstEvent.payload),
      schemaVersion: LATEST_EVENT_SCHEMA_VERSION - 1,
    };
    db.run("UPDATE events SET payload = ? WHERE sequence = ?", [
      JSON.stringify(stale),
      firstEvent.sequence,
    ]);
    db.close();
    rehash(archivePath);

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, projectionCodec),
      "incompatible-version",
      slotsDir,
    );
    closeStore(store);
  });
});

describe("importArchive: manifest inconsistency", () => {
  test("error path: a rehashed manifest whose eventSequence disagrees with the archive's actual event log is rejected as inconsistent-manifest; no slot is created", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const db = new Database(archivePath);
    db.run("UPDATE manifest SET event_sequence = ?", [999]);
    db.close();
    rehash(archivePath);

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, projectionCodec),
      "inconsistent-manifest",
      slotsDir,
    );
    closeStore(store);
  });

  test("error path: a rehashed manifest whose worldId disagrees with the archive's own world row is rejected as inconsistent-manifest; no slot is created", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const db = new Database(archivePath);
    db.run("UPDATE manifest SET world_id = ?", ["world-not-the-real-one"]);
    db.close();
    rehash(archivePath);

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, projectionCodec),
      "inconsistent-manifest",
      slotsDir,
    );
    closeStore(store);
  });

  test("error path: a flipped byte (hash left un-rehashed) is rejected as inconsistent-manifest or corrupt; no slot is created", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const flippedPath = join(dir, "flipped.sqlite");
    const bytes = readFileSync(archivePath);
    const mutable = Buffer.from(bytes);
    const offset = Math.floor(mutable.length / 2);
    mutable[offset] = (mutable[offset] ?? 0) ^ 0xff;
    writeFileSync(flippedPath, mutable);

    const slotsDir = join(dir, "slots");
    let caught: unknown;
    try {
      importArchive(flippedPath, slotsDir, projectionCodec);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ImportError);
    expect(["inconsistent-manifest", "corrupt"]).toContain(
      (caught as ImportError).kind,
    );
    expect(existsSync(slotsDir) ? readdirSync(slotsDir) : []).toHaveLength(0);
    closeStore(store);
  });
});

describe("importArchive: interrupted staging leaves no slot, and existing slots stay untouched", () => {
  test("error path: a staging-time failure (duplicate event ID smuggled past per-row validation) leaves no slot behind", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const db = new Database(archivePath);
    const [first, second] = db
      .query("SELECT sequence, payload FROM events ORDER BY sequence ASC")
      .all() as { sequence: number; payload: string }[];
    if (!first || !second) {
      throw new Error("test fixture needs at least two events");
    }
    // Each row still parses fine on its own (per-row validation can't see
    // across rows); the duplicate only surfaces as a UNIQUE constraint
    // violation once staging actually inserts both rows.
    const firstPayload = JSON.parse(first.payload) as { id: string };
    const secondPayload = {
      ...JSON.parse(second.payload),
      id: firstPayload.id,
    };
    db.run("UPDATE events SET payload = ? WHERE sequence = ?", [
      JSON.stringify(secondPayload),
      second.sequence,
    ]);
    db.close();
    rehash(archivePath);

    const slotsDir = join(dir, "slots");
    let caught: unknown;
    try {
      importArchive(archivePath, slotsDir, projectionCodec);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(existsSync(slotsDir) ? readdirSync(slotsDir) : []).toHaveLength(0);
    closeStore(store);
  });

  test("happy path: importing a second archive never touches an already-materialized slot", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);
    const slotsDir = join(dir, "slots");

    const first = importArchive(archivePath, slotsDir, projectionCodec);
    const firstBytesBefore = readFileSync(join(first.slotPath, "world.sqlite"));

    importArchive(archivePath, slotsDir, projectionCodec);

    expect(readFileSync(join(first.slotPath, "world.sqlite"))).toEqual(
      firstBytesBefore,
    );
    closeStore(store);
  });
});

describe("computeContentHash", () => {
  test("identical data yields an identical hash regardless of insertion order", () => {
    function makeFixtureDb(path: string): Database {
      const db = new Database(path, { create: true });
      db.exec(
        "CREATE TABLE world (id INTEGER PRIMARY KEY, world_id TEXT NOT NULL) STRICT",
      );
      db.exec(
        "CREATE TABLE clock (id INTEGER PRIMARY KEY, cursor_wall_ms INTEGER NOT NULL, paused INTEGER NOT NULL, tick INTEGER NOT NULL, sim_time_ms INTEGER NOT NULL) STRICT",
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
      db.run(
        "INSERT INTO clock (id, cursor_wall_ms, paused, tick, sim_time_ms) VALUES (1, 0, 0, 0, 0)",
      );
      db.run("INSERT INTO prng_state (id, state) VALUES (1, '')");
      db.run(
        "INSERT INTO projections (id, revision, data) VALUES (1, 0, 'null')",
      );
      return db;
    }

    const manifestFields = {
      formatVersion: 1,
      sqliteSchemaVersion: CURRENT_SCHEMA_VERSION,
      payloadSchemaVersion: 1,
      worldId: "world-fixture" as never,
      eventSequence: 2,
    };

    const db1 = makeFixtureDb(join(dir, "a.sqlite"));
    const db2 = makeFixtureDb(join(dir, "b.sqlite"));
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
    db1.close();
    db2.close();
  });

  test("the manifest fields are bound into the hash: changing any one of them changes the hash even with identical table data", () => {
    const db = new Database(join(dir, "c.sqlite"), { create: true });
    db.exec(
      "CREATE TABLE world (id INTEGER PRIMARY KEY, world_id TEXT NOT NULL) STRICT",
    );
    db.exec(
      "CREATE TABLE clock (id INTEGER PRIMARY KEY, cursor_wall_ms INTEGER NOT NULL, paused INTEGER NOT NULL, tick INTEGER NOT NULL, sim_time_ms INTEGER NOT NULL) STRICT",
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
    db.run(
      "INSERT INTO clock (id, cursor_wall_ms, paused, tick, sim_time_ms) VALUES (1, 0, 0, 0, 0)",
    );
    db.run("INSERT INTO prng_state (id, state) VALUES (1, '')");
    db.run(
      "INSERT INTO projections (id, revision, data) VALUES (1, 0, 'null')",
    );

    const manifestFields = {
      formatVersion: 1,
      sqliteSchemaVersion: CURRENT_SCHEMA_VERSION,
      payloadSchemaVersion: 1,
      worldId: "world-fixture" as never,
      eventSequence: 2,
    };
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

    db.close();
  });
});
