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
  type WorldEvent,
} from "@panthea/contracts";
import {
  computeContentHash,
  exportArchive,
  ImportError,
  importArchive,
} from "./archive";
import {
  insertExternalProposal,
  listExternalProposals,
  markExternalProposalConsumed,
} from "./journal";
import {
  bindCatchUpProgressSummary,
  CURRENT_SCHEMA_VERSION,
  closeStore,
  commitTick,
  getCurrentSequence,
  listEvents,
  openStore,
  type ProjectionCodec,
  type ProjectionReducers,
  readCatchUpProgress,
  readCatchUpSummary,
  readClock,
  readLiveProjections,
  rebuildProjections,
  type Store,
  writeCatchUpProgress,
  writeCatchUpSummary,
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
    tick: 1,
    approximate: false,
    kind: "entity-moved",
    entityId: createEntityId(),
    to: createEntityId(),
  };
}

function buildPopulatedStore(dbPath: string): Store {
  const store = openStore(dbPath, reducer);
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

describe("exportArchive: genesis", () => {
  test("happy path: the exported archive carries a genesis row equal to the store's own genesis, and it is bound into the content hash", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const sourceGenesis = store.db
      .query("SELECT data FROM genesis WHERE id = 1")
      .get() as { data: string };

    const archiveDb = new Database(archivePath, { readonly: true });
    const archiveGenesis = archiveDb
      .query("SELECT data FROM genesis WHERE id = 1")
      .get() as { data: string } | null;
    expect(archiveGenesis).not.toBeNull();
    expect(JSON.parse(archiveGenesis?.data ?? "null")).toEqual(
      JSON.parse(sourceGenesis.data),
    );
    archiveDb.close();
    closeStore(store);
  });

  test("a tampered, rehashed genesis row is rejected by import as corrupt; no slot is created", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const db = new Database(archivePath);
    db.run("UPDATE genesis SET data = ? WHERE id = 1", ["not json at all {"]);
    db.close();
    rehash(archivePath);

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, reducer),
      "corrupt",
      slotsDir,
    );
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
    const result = importArchive(archivePath, slotsDir, reducer);

    expect(existsSync(result.slotPath)).toBe(true);
    const importedStore = openStore(
      join(result.slotPath, "world.sqlite"),
      reducer,
    );

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

    const first = importArchive(archivePath, slotsDir, reducer);
    const firstBytes = readFileSync(join(first.slotPath, "world.sqlite"));

    const second = importArchive(archivePath, slotsDir, reducer);

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
      () => importArchive(truncatedPath, slotsDir, reducer),
      "corrupt",
      slotsDir,
    );
    closeStore(store);
  });

  test("error path: a missing archive file is rejected as an io error; no slot is created", () => {
    const slotsDir = join(dir, "slots");
    expectRejected(
      () =>
        importArchive(join(dir, "does-not-exist.sqlite"), slotsDir, reducer),
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
      () => importArchive(archivePath, slotsDir, reducer),
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
      () => importArchive(archivePath, slotsDir, reducer),
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
      () => importArchive(archivePath, slotsDir, reducer),
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
      () => importArchive(archivePath, slotsDir, reducer),
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
      () => importArchive(archivePath, slotsDir, reducer),
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
    const okResult = importArchive(archivePath, slotsDir, {
      applyEvent: reducer.applyEvent,
      codec: strictCodec,
    });
    expect(existsSync(okResult.slotPath)).toBe(true);

    const db = new Database(archivePath);
    db.run("UPDATE projections SET data = ? WHERE id = 1", [
      JSON.stringify({ somethingElse: true }),
    ]);
    db.close();
    rehash(archivePath);

    expectRejected(
      () =>
        importArchive(archivePath, join(dir, "slots2"), {
          applyEvent: reducer.applyEvent,
          codec: strictCodec,
        }),
      "corrupt",
      join(dir, "slots2"),
    );
    closeStore(store);
  });
});

describe("importArchive: social events", () => {
  function socialEvents(): WorldEvent[] {
    const base = (sequence: number) => ({
      schemaVersion: LATEST_EVENT_SCHEMA_VERSION,
      id: createEventId(),
      sequence,
      simTime: sequence,
      correlationId: createCorrelationId(),
      causationId: createCausationId(),
      tick: 1,
      approximate: false,
    });
    const owner = createEntityId();
    const strike = createEntityId();
    const ignited: WorldEvent = {
      ...base(1),
      kind: "building-ignited",
      entityId: createEntityId(),
      cause: { kind: "strike", actor: strike },
    };
    const memory: WorldEvent = {
      ...base(2),
      kind: "memory-recorded",
      memoryKind: "witnessed",
      entityId: owner,
      sourceEventId: ignited.id,
      eventKind: "building-ignited",
      subjects: [strike],
      salience: 8,
      consequence: { effect: "harm", agent: strike },
    };
    const change: WorldEvent = {
      ...base(3),
      kind: "relationship-changed",
      entityId: owner,
      toward: strike,
      affinityDelta: -2,
      grudgeDelta: 0,
      memoryEventId: memory.id,
    };
    return [ignited, memory, change];
  }

  function commitAll(store: Store, events: readonly WorldEvent[]): void {
    events.forEach((event, index) => {
      commitTick(store, reducer, {
        events: [event],
        cursorWallMs: 1000 * (index + 1),
        paused: false,
        tick: index + 1,
        simTimeMs: 1000 * (index + 1),
        prngState: `seed-${index}`,
      });
    });
  }

  test("happy path: memory and relationship events, and the fire cause they cite, survive export and import unchanged", () => {
    const store = openStore(join(dir, "world.sqlite"), reducer);
    const events = socialEvents();
    commitAll(store, events);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const result = importArchive(archivePath, join(dir, "slots"), reducer);
    const imported = openStore(join(result.slotPath, "world.sqlite"), reducer);
    expect(listEvents(imported.db)).toEqual(events);
    closeStore(imported);
    closeStore(store);
  });

  test("error path: a rehashed archive whose memory event lost its salience, or whose ignition lost its cause, is rejected as corrupt; no slot is created", () => {
    for (const [sequence, damage] of [
      [1, { cause: undefined }],
      [2, { salience: undefined }],
      [3, { memoryEventId: undefined }],
    ] as const) {
      const dbPath = join(dir, `world-${sequence}.sqlite`);
      const store = openStore(dbPath, reducer);
      commitAll(store, socialEvents());
      const archivePath = join(dir, `archive-${sequence}.sqlite`);
      exportArchive(store, archivePath);

      const db = new Database(archivePath);
      const row = db
        .query("SELECT payload FROM events WHERE sequence = ?")
        .get(sequence) as { payload: string };
      db.run("UPDATE events SET payload = ? WHERE sequence = ?", [
        JSON.stringify({ ...JSON.parse(row.payload), ...damage }),
        sequence,
      ]);
      db.close();
      rehash(archivePath);

      const slotsDir = join(dir, `slots-${sequence}`);
      expectRejected(
        () => importArchive(archivePath, slotsDir, reducer),
        "corrupt",
        slotsDir,
      );
      closeStore(store);
    }
  });
});

describe("importArchive: the projection must be what the event log makes", () => {
  test("error path: a rehashed archive whose live projection no event produced is rejected as corrupt; no slot is created", () => {
    const store = buildPopulatedStore(join(dir, "world.sqlite"));
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    // Three events make a total of 3; the forged row says 99, with the
    // revision, the manifest, and the content hash all still consistent.
    const db = new Database(archivePath);
    db.run("UPDATE projections SET data = ? WHERE id = 1", [
      JSON.stringify({ total: 99 }),
    ]);
    db.close();
    rehash(archivePath);

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, reducer),
      "corrupt",
      slotsDir,
    );
    closeStore(store);
  });

  test("happy path: an honest archive imports, and the imported projection is the one the log makes", () => {
    const store = buildPopulatedStore(join(dir, "world.sqlite"));
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const result = importArchive(archivePath, join(dir, "slots"), reducer);
    const imported = openStore(join(result.slotPath, "world.sqlite"), reducer);
    expect(readLiveProjections(imported, reducer)).toEqual({ total: 3 });
    expect(rebuildProjections(imported, reducer)).toEqual({ total: 3 });
    closeStore(imported);
    closeStore(store);
  });

  test("a rehashed archive whose events were edited after export no longer matches its projection", () => {
    const store = buildPopulatedStore(join(dir, "world.sqlite"));
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);
    // The projection is left honest for three events; an event is then removed
    // from the log and the manifest and revision follow, but the projection
    // does not.
    const db = new Database(archivePath);
    db.run("DELETE FROM events WHERE sequence = 3");
    db.run("UPDATE manifest SET event_sequence = 2");
    db.run("UPDATE projections SET revision = 2 WHERE id = 1");
    db.close();
    rehash(archivePath);

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, reducer),
      "corrupt",
      slotsDir,
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
      () => importArchive(archivePath, slotsDir, reducer),
      "incompatible-version",
      slotsDir,
    );
    closeStore(store);
  });

  test("error path: a version 5 archive is rejected as incompatible-version, never imported; no slot is created", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const db = new Database(archivePath);
    db.run("UPDATE manifest SET sqlite_schema_version = 5");
    db.close();

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, reducer),
      "incompatible-version",
      slotsDir,
    );
    closeStore(store);
  });

  test("error path: a version 4 archive is rejected as incompatible-version, never imported; no slot is created", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const db = new Database(archivePath);
    db.run("UPDATE manifest SET sqlite_schema_version = 4");
    db.close();

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, reducer),
      "incompatible-version",
      slotsDir,
    );
    closeStore(store);
  });

  test("error path: a version 2 archive is rejected as incompatible-version, never imported; no slot is created", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const db = new Database(archivePath);
    db.run("UPDATE manifest SET sqlite_schema_version = 2");
    db.close();

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, reducer),
      "incompatible-version",
      slotsDir,
    );
    closeStore(store);
  });

  test("error path: a version 1 archive is rejected as incompatible-version, never imported; no slot is created", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const db = new Database(archivePath);
    db.run("UPDATE manifest SET sqlite_schema_version = 1");
    db.close();

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, reducer),
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
      () => importArchive(archivePath, slotsDir, reducer),
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
      () => importArchive(archivePath, slotsDir, reducer),
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
      () => importArchive(archivePath, slotsDir, reducer),
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
      () => importArchive(archivePath, slotsDir, reducer),
      "inconsistent-manifest",
      slotsDir,
    );
    closeStore(store);
  });

  test("error path: a flipped byte within a stored event's id (hash left un-rehashed) is rejected as inconsistent-manifest or corrupt; no slot is created", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const inspectDb = new Database(archivePath, { readonly: true });
    const firstEvent = inspectDb
      .query("SELECT id FROM events ORDER BY sequence ASC LIMIT 1")
      .get() as { id: string };
    inspectDb.close();

    const flippedPath = join(dir, "flipped.sqlite");
    const bytes = readFileSync(archivePath);
    // Target a known, unique-enough byte range (an event's own id, a random
    // UUID) rather than an arbitrary file offset, so the flip always lands
    // in real hashed table data instead of possibly landing in SQLite's own
    // page padding, which a byte flip at a fixed numeric offset cannot
    // guarantee once the file's size shifts with schema/content changes.
    const offset = bytes.indexOf(Buffer.from(firstEvent.id, "utf8"));
    if (offset < 0) {
      throw new Error(
        "test fixture: could not locate the event id in the archive bytes",
      );
    }
    const mutable = Buffer.from(bytes);
    mutable[offset] = (mutable[offset] ?? 0) ^ 0xff;
    writeFileSync(flippedPath, mutable);

    const slotsDir = join(dir, "slots");
    let caught: unknown;
    try {
      importArchive(flippedPath, slotsDir, reducer);
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

describe("importArchive: history consistency", () => {
  test("error path: a payload renumbered out of sequence (rows 1,2 with payload sequences 1,3) is rejected; no slot is created", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = openStore(dbPath, reducer);
    commitTick(store, reducer, {
      events: [makeMoveEvent(1)],
      cursorWallMs: 1000,
      paused: false,
      tick: 1,
      simTimeMs: 1000,
      prngState: "seed-1",
    });
    commitTick(store, reducer, {
      events: [makeMoveEvent(2)],
      cursorWallMs: 2000,
      paused: false,
      tick: 2,
      simTimeMs: 2000,
      prngState: "seed-2",
    });
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    // Row stays at sequence=2 (so the raw MAX(sequence) column check still
    // matches manifest.eventSequence), but its payload's own internal
    // `sequence` field is renumbered to 3 -- skipping 2 entirely. A plain
    // MAX(sequence)-column check cannot see this; only cross-checking the
    // parsed payload against its own row does.
    const db = new Database(archivePath);
    const row = db
      .query("SELECT payload FROM events WHERE sequence = 2")
      .get() as { payload: string };
    const renumbered = { ...JSON.parse(row.payload), sequence: 3 };
    db.run("UPDATE events SET payload = ? WHERE sequence = 2", [
      JSON.stringify(renumbered),
    ]);
    db.close();
    rehash(archivePath);

    const slotsDir = join(dir, "slots");
    let caught: unknown;
    try {
      importArchive(archivePath, slotsDir, reducer);
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

  interface HistoryProjection {
    readonly total: number;
    readonly lastSequence: number;
  }

  const historyCodec: ProjectionCodec<HistoryProjection> = {
    encode: (projections) => projections,
    decode: (value) => value as HistoryProjection,
  };

  const historyReducer: ProjectionReducers<HistoryProjection> = {
    initial: { total: 0, lastSequence: 0 },
    applyEvent(projections, event) {
      return { total: projections.total + 1, lastSequence: event.sequence };
    },
    codec: historyCodec,
  };

  test("error path: a rehashed live projection whose lastSequence disagrees with the archive's event log is rejected as inconsistent-manifest; no slot is created", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = openStore(dbPath, historyReducer);
    commitTick(store, historyReducer, {
      events: [makeMoveEvent(1)],
      cursorWallMs: 1000,
      paused: false,
      tick: 1,
      simTimeMs: 1000,
      prngState: "seed-1",
    });
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const db = new Database(archivePath);
    db.run("UPDATE projections SET data = ? WHERE id = 1", [
      JSON.stringify({ total: 1, lastSequence: 99 }),
    ]);
    db.close();
    rehash(archivePath);

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, historyReducer),
      "inconsistent-manifest",
      slotsDir,
    );
    closeStore(store);
  });

  test("error path: a rehashed genesis projection with a nonzero lastSequence is rejected as inconsistent-manifest; no slot is created", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = openStore(dbPath, historyReducer);
    commitTick(store, historyReducer, {
      events: [makeMoveEvent(1)],
      cursorWallMs: 1000,
      paused: false,
      tick: 1,
      simTimeMs: 1000,
      prngState: "seed-1",
    });
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const db = new Database(archivePath);
    db.run("UPDATE genesis SET data = ? WHERE id = 1", [
      JSON.stringify({ total: 0, lastSequence: 7 }),
    ]);
    db.close();
    rehash(archivePath);

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, historyReducer),
      "inconsistent-manifest",
      slotsDir,
    );
    closeStore(store);
  });

  test("error path: a rehashed projections row whose revision column disagrees with the manifest's event sequence is rejected as inconsistent-manifest; no slot is created", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    // The projections row's `revision` column (not its `data` payload,
    // which carries no lastSequence field for this generic
    // CountProjection fixture) disagrees with the archive's own event log.
    const db = new Database(archivePath);
    db.run("UPDATE projections SET revision = ? WHERE id = 1", [999]);
    db.close();
    rehash(archivePath);

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, reducer),
      "inconsistent-manifest",
      slotsDir,
    );
    closeStore(store);
  });

  test("error path: an event row whose id, kind, correlation_id, or causation_id column disagrees with its parsed payload is rejected as corrupt; no slot is created, and staged columns always come from the parsed event", () => {
    const dbPath = join(dir, "world.sqlite");
    const store = buildPopulatedStore(dbPath);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const db = new Database(archivePath);
    // The payload stays internally consistent; only the row's own `id`
    // column is changed to disagree with what the payload actually says.
    db.run("UPDATE events SET id = ? WHERE sequence = 2", [
      "event-does-not-match-payload",
    ]);
    db.close();
    rehash(archivePath);

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, reducer),
      "corrupt",
      slotsDir,
    );
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
      importArchive(archivePath, slotsDir, reducer);
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

    const first = importArchive(archivePath, slotsDir, reducer);
    const firstBytesBefore = readFileSync(join(first.slotPath, "world.sqlite"));

    importArchive(archivePath, slotsDir, reducer);

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
        "CREATE TABLE genesis (id INTEGER PRIMARY KEY, data TEXT NOT NULL) STRICT",
      );
      db.exec(
        "CREATE TABLE projections (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL) STRICT",
      );
      db.exec(
        "CREATE TABLE events (sequence INTEGER PRIMARY KEY, id TEXT NOT NULL, correlation_id TEXT NOT NULL, causation_id TEXT NOT NULL, kind TEXT NOT NULL, approximate INTEGER NOT NULL, payload TEXT NOT NULL) STRICT",
      );
      db.exec(
        "CREATE TABLE external_proposals (input_order INTEGER PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE, target_tick INTEGER NOT NULL, proposal TEXT NOT NULL, observation TEXT NOT NULL, consumed_tick INTEGER) STRICT",
      );
      db.exec(
        "CREATE TABLE catch_up_progress (id INTEGER PRIMARY KEY, applied_ms INTEGER NOT NULL, discarded_ms INTEGER NOT NULL, start_sequence INTEGER NOT NULL) STRICT",
      );
      db.exec(
        "CREATE TABLE catch_up_summary (id INTEGER PRIMARY KEY, summary_id TEXT NOT NULL, at_sequence INTEGER NOT NULL, applied_ms INTEGER NOT NULL, skipped_ms INTEGER NOT NULL, major_outcomes TEXT NOT NULL) STRICT",
      );
      db.run("INSERT INTO world (id, world_id) VALUES (1, 'w')");
      db.run(
        "INSERT INTO clock (id, cursor_wall_ms, paused, tick, sim_time_ms) VALUES (1, 0, 0, 0, 0)",
      );
      db.run("INSERT INTO prng_state (id, state) VALUES (1, '')");
      db.run("INSERT INTO genesis (id, data) VALUES (1, 'null')");
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
      "CREATE TABLE genesis (id INTEGER PRIMARY KEY, data TEXT NOT NULL) STRICT",
    );
    db.exec(
      "CREATE TABLE projections (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL) STRICT",
    );
    db.exec(
      "CREATE TABLE events (sequence INTEGER PRIMARY KEY, id TEXT NOT NULL, correlation_id TEXT NOT NULL, causation_id TEXT NOT NULL, kind TEXT NOT NULL, approximate INTEGER NOT NULL, payload TEXT NOT NULL) STRICT",
    );
    db.exec(
      "CREATE TABLE external_proposals (input_order INTEGER PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE, target_tick INTEGER NOT NULL, proposal TEXT NOT NULL, observation TEXT NOT NULL, consumed_tick INTEGER) STRICT",
    );
    db.exec(
      "CREATE TABLE catch_up_progress (id INTEGER PRIMARY KEY, applied_ms INTEGER NOT NULL, discarded_ms INTEGER NOT NULL, start_sequence INTEGER NOT NULL) STRICT",
    );
    db.exec(
      "CREATE TABLE catch_up_summary (id INTEGER PRIMARY KEY, summary_id TEXT NOT NULL, at_sequence INTEGER NOT NULL, applied_ms INTEGER NOT NULL, skipped_ms INTEGER NOT NULL, major_outcomes TEXT NOT NULL) STRICT",
    );
    db.run("INSERT INTO world (id, world_id) VALUES (1, 'w')");
    db.run(
      "INSERT INTO clock (id, cursor_wall_ms, paused, tick, sim_time_ms) VALUES (1, 0, 0, 0, 0)",
    );
    db.run("INSERT INTO prng_state (id, state) VALUES (1, '')");
    db.run("INSERT INTO genesis (id, data) VALUES (1, 'null')");
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

describe("the external proposal journal in an archive", () => {
  function journalEntry(id: string, power = 3) {
    return {
      proposalId: `proposal-${id}`,
      proposal: {
        schemaVersion: 1,
        kind: "strike",
        actor: "zeus",
        target: "the-tavern",
        power,
        targets: [],
        expectedRevisions: [],
        source: "fixture",
        observationId: `obs-${id}`,
      },
      observation: {
        schemaVersion: 1,
        id: `obs-${id}`,
        observer: "zeus",
        stateRevision: 0,
        factsRead: [],
        source: "fixture",
      },
    };
  }

  /** A populated store with one consumed and two pending entries. */
  function storeWithJournal(dbPath: string): Store {
    const store = buildPopulatedStore(dbPath);
    insertExternalProposal(store.db, journalEntry("a"));
    insertExternalProposal(store.db, journalEntry("b"));
    insertExternalProposal(store.db, journalEntry("c"));
    insertExternalProposal(store.db, journalEntry("d"));
    // "a" (committed) and "d" (rejected) were accepted before the store's
    // three ticks and consumed by them; "b" and "c" were accepted after and
    // are still pending.
    store.db.run(
      "UPDATE external_proposals SET target_tick = 1 WHERE proposal_id IN ('proposal-a', 'proposal-d')",
    );
    markExternalProposalConsumed(store.db, "proposal-a", 3, {
      status: "committed",
    });
    markExternalProposalConsumed(store.db, "proposal-d", 2, {
      status: "rejected",
      reason: "busy-actor",
    });
    return store;
  }

  test("an imported slot holds every entry, pending and consumed, with ids, order, target ticks, and consumption preserved", () => {
    const store = storeWithJournal(join(dir, "world.sqlite"));
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const slot = importArchive(archivePath, join(dir, "slots"), reducer);

    const imported = openStore(join(slot.slotPath, "world.sqlite"), reducer);
    expect(listExternalProposals(imported.db)).toEqual(
      listExternalProposals(store.db),
    );
    expect(
      listExternalProposals(imported.db).map((entry) => [
        entry.proposalId,
        entry.inputOrder,
        entry.consumedTick,
      ]),
    ).toEqual([
      ["proposal-a", 1, 3],
      ["proposal-b", 2, undefined],
      ["proposal-c", 3, undefined],
      ["proposal-d", 4, 2],
    ]);
    expect(
      listExternalProposals(imported.db).map((entry) => entry.outcome),
    ).toEqual([
      { status: "committed" },
      undefined,
      undefined,
      { status: "rejected", reason: "busy-actor" },
    ]);
    closeStore(imported);
    closeStore(store);
  });

  test("an imported slot continues allocation above the maximum input order", () => {
    const store = storeWithJournal(join(dir, "world.sqlite"));
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);
    const slot = importArchive(archivePath, join(dir, "slots"), reducer);

    const imported = openStore(join(slot.slotPath, "world.sqlite"), reducer);
    const next = insertExternalProposal(imported.db, journalEntry("e"));

    expect(next.entry.inputOrder).toBe(5);
    closeStore(imported);
    closeStore(store);
  });

  test("the content hash covers the journal: changing an entry without rehashing is rejected; no slot is created", () => {
    const store = storeWithJournal(join(dir, "world.sqlite"));
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const db = new Database(archivePath);
    db.run(
      "UPDATE external_proposals SET proposal = ? WHERE proposal_id = 'proposal-b'",
      [JSON.stringify(journalEntry("b", 99).proposal)],
    );
    db.close();

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, reducer),
      "inconsistent-manifest",
      slotsDir,
    );
    closeStore(store);
  });

  test("a rehashed entry whose proposal no longer parses is rejected as corrupt; no slot is created", () => {
    const store = storeWithJournal(join(dir, "world.sqlite"));
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const db = new Database(archivePath);
    db.run(
      "UPDATE external_proposals SET proposal = ? WHERE proposal_id = 'proposal-b'",
      [JSON.stringify({ kind: "not-a-proposal" })],
    );
    db.close();
    rehash(archivePath);

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, reducer),
      "corrupt",
      slotsDir,
    );
    closeStore(store);
  });

  test("a rehashed entry whose proposal cites a different observation than the one stored beside it is rejected as corrupt; no slot is created", () => {
    const store = storeWithJournal(join(dir, "world.sqlite"));
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const mismatched = {
      ...journalEntry("b").proposal,
      observationId: "obs-someone-else",
    };
    const db = new Database(archivePath);
    db.run(
      "UPDATE external_proposals SET proposal = ? WHERE proposal_id = 'proposal-b'",
      [JSON.stringify(mismatched)],
    );
    db.close();
    rehash(archivePath);

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, reducer),
      "corrupt",
      slotsDir,
    );
    closeStore(store);
  });

  /** Rewrites one journal row in an exported archive, past the schema's own CHECKs, and rehashes it. */
  function corruptOutcome(archivePath: string, set: string): void {
    const db = new Database(archivePath);
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.run(
      `UPDATE external_proposals SET ${set} WHERE proposal_id = 'proposal-d'`,
    );
    db.close();
    rehash(archivePath);
  }

  test.each([
    ["a consumed entry with no outcome", "outcome = NULL, reason = NULL"],
    ["a pending entry that has an outcome", "consumed_tick = NULL"],
    ["a committed entry that has a reason", "outcome = 'committed'"],
    ["a rejected entry with no reason", "reason = NULL"],
    ["a rejected entry with an unknown reason", "reason = 'because'"],
    ["an outcome that is neither committed nor rejected", "outcome = 'lost'"],
  ])(
    "a rehashed archive with %s is rejected as corrupt; no slot is created",
    (_label, set) => {
      const store = storeWithJournal(join(dir, "world.sqlite"));
      const archivePath = join(dir, "archive.sqlite");
      exportArchive(store, archivePath);
      corruptOutcome(archivePath, set);

      const slotsDir = join(dir, "slots");
      expectRejected(
        () => importArchive(archivePath, slotsDir, reducer),
        "corrupt",
        slotsDir,
      );
      closeStore(store);
    },
  );

  test("the content hash covers the outcome: changing it without rehashing is rejected; no slot is created", () => {
    const store = storeWithJournal(join(dir, "world.sqlite"));
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);
    const db = new Database(archivePath);
    db.run(
      "UPDATE external_proposals SET reason = 'stale-target' WHERE proposal_id = 'proposal-d'",
    );
    db.close();

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, reducer),
      "inconsistent-manifest",
      slotsDir,
    );
    closeStore(store);
  });

  test("a rehashed entry consumed before its own target tick is rejected as corrupt; no slot is created", () => {
    const store = storeWithJournal(join(dir, "world.sqlite"));
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    // The archive's clock is at tick 3, so consumed tick 2 is within it, but
    // it is before the tick 3 the entry was targeted at.
    const db = new Database(archivePath);
    db.run(
      "UPDATE external_proposals SET target_tick = 3, consumed_tick = 2 WHERE proposal_id = 'proposal-a'",
    );
    db.close();
    rehash(archivePath);

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, reducer),
      "corrupt",
      slotsDir,
    );
    closeStore(store);
  });

  test("a rehashed entry consumed after the archive's own clock is rejected as corrupt; no slot is created", () => {
    const store = storeWithJournal(join(dir, "world.sqlite"));
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const db = new Database(archivePath);
    db.run(
      "UPDATE external_proposals SET consumed_tick = 500 WHERE proposal_id = 'proposal-a'",
    );
    db.close();
    rehash(archivePath);

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, reducer),
      "corrupt",
      slotsDir,
    );
    closeStore(store);
  });
});

describe("an unfinished catch-up backlog's progress in an archive", () => {
  const progress = {
    appliedMs: 120_000,
    discardedMs: 7_200_000,
    startSequence: 1,
  };

  function storeMidBacklog(dbPath: string): Store {
    const store = buildPopulatedStore(dbPath);
    writeCatchUpProgress(store.db, progress);
    return store;
  }

  test("an imported slot holds the same progress, so its catch-up continues the backlog", () => {
    const store = storeMidBacklog(join(dir, "world.sqlite"));
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const slot = importArchive(archivePath, join(dir, "slots"), reducer);

    const imported = openStore(join(slot.slotPath, "world.sqlite"), reducer);
    expect(readCatchUpProgress(imported.db)).toEqual(progress);
    closeStore(imported);
    closeStore(store);
  });

  test("a backlog whose start sequence equals the archive's last event sequence imports: a discard-only or pause-ended backlog commits no events, and it reports no outcomes", () => {
    // Hand-built: this package cannot run catch-up. The row is what a
    // discard-only backlog (or one ended by a pause before any chunk) leaves:
    // time discarded, nothing applied, start_sequence at the last event.
    const store = buildPopulatedStore(join(dir, "world.sqlite"));
    const lastSequence = getCurrentSequence(store.db);
    const discardOnly = {
      appliedMs: 0,
      discardedMs: 7_200_000,
      startSequence: lastSequence,
    };
    writeCatchUpProgress(store.db, discardOnly);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const slot = importArchive(archivePath, join(dir, "slots"), reducer);

    const imported = openStore(join(slot.slotPath, "world.sqlite"), reducer);
    expect(readCatchUpProgress(imported.db)).toEqual(discardOnly);
    // The summary's outcomes are the events after start_sequence: none.
    expect(
      listEvents(imported.db, { fromSequence: discardOnly.startSequence }),
    ).toEqual([]);
    closeStore(imported);
    closeStore(store);
  });

  test("an archive of a store with no open backlog imports with none", () => {
    const store = buildPopulatedStore(join(dir, "world.sqlite"));
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const slot = importArchive(archivePath, join(dir, "slots"), reducer);

    const imported = openStore(join(slot.slotPath, "world.sqlite"), reducer);
    expect(readCatchUpProgress(imported.db)).toBeUndefined();
    closeStore(imported);
    closeStore(store);
  });

  test("the content hash covers the progress: changing it without rehashing is rejected; no slot is created", () => {
    const store = storeMidBacklog(join(dir, "world.sqlite"));
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);
    const db = new Database(archivePath);
    db.run("UPDATE catch_up_progress SET applied_ms = 60000");
    db.close();

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, reducer),
      "inconsistent-manifest",
      slotsDir,
    );
    closeStore(store);
  });

  test.each([
    ["a start sequence beyond the archive's event log", "start_sequence = 99"],
    ["a negative start sequence", "start_sequence = -1"],
    ["a negative applied time", "applied_ms = -1"],
    ["a negative discarded time", "discarded_ms = -1"],
  ])(
    "a rehashed archive with %s is rejected as corrupt; no slot is created",
    (_label, set) => {
      const store = storeMidBacklog(join(dir, "world.sqlite"));
      const archivePath = join(dir, "archive.sqlite");
      exportArchive(store, archivePath);
      const db = new Database(archivePath);
      db.run(`UPDATE catch_up_progress SET ${set}`);
      db.close();
      rehash(archivePath);

      const slotsDir = join(dir, "slots");
      expectRejected(
        () => importArchive(archivePath, slotsDir, reducer),
        "corrupt",
        slotsDir,
      );
      closeStore(store);
    },
  );
});

describe("the catch-up summary in an archive", () => {
  const summary = {
    id: "3f2c9d64-1a5e-4c8b-9a53-2e6f0b7d1c11",
    atSequence: 1,
    appliedMs: 3_600_000,
    skippedMs: 7_200_000,
    majorOutcomes: ["building-ignited:the-tavern", "legend-recorded:zeus"],
  };

  function storeWithSummary(dbPath: string): Store {
    const store = buildPopulatedStore(dbPath);
    writeCatchUpSummary(store.db, summary);
    return store;
  }

  test("an imported slot holds the same summary, id and outcomes included", () => {
    const store = storeWithSummary(join(dir, "world.sqlite"));
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const slot = importArchive(archivePath, join(dir, "slots"), reducer);

    const imported = openStore(join(slot.slotPath, "world.sqlite"), reducer);
    expect(readCatchUpSummary(imported.db)).toEqual(summary);
    closeStore(imported);
    closeStore(store);
  });

  test("the summary and an open backlog travel together, each in its own row", () => {
    const store = storeWithSummary(join(dir, "world.sqlite"));
    writeCatchUpProgress(store.db, {
      appliedMs: 60_000,
      discardedMs: 0,
      startSequence: 1,
    });
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const slot = importArchive(archivePath, join(dir, "slots"), reducer);

    const imported = openStore(join(slot.slotPath, "world.sqlite"), reducer);
    expect(readCatchUpSummary(imported.db)).toEqual(summary);
    expect(readCatchUpProgress(imported.db)?.appliedMs).toBe(60_000);
    closeStore(imported);
    closeStore(store);
  });

  test("a backlog bound to its partial summary keeps the binding across an import, so closing it there still keeps the summary's id", () => {
    const store = storeWithSummary(join(dir, "world.sqlite"));
    writeCatchUpProgress(store.db, {
      appliedMs: 60_000,
      discardedMs: 0,
      startSequence: 1,
    });
    bindCatchUpProgressSummary(store.db, summary.id);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const slot = importArchive(archivePath, join(dir, "slots"), reducer);

    const imported = openStore(join(slot.slotPath, "world.sqlite"), reducer);
    expect(readCatchUpProgress(imported.db)?.summaryId).toBe(summary.id);
    closeStore(imported);
    closeStore(store);
  });

  test("a rehashed archive whose open backlog is bound to a summary the archive does not carry is rejected as corrupt; no slot is created", () => {
    const store = storeWithSummary(join(dir, "world.sqlite"));
    writeCatchUpProgress(store.db, {
      appliedMs: 60_000,
      discardedMs: 0,
      startSequence: 1,
    });
    bindCatchUpProgressSummary(store.db, summary.id);
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);
    const db = new Database(archivePath);
    db.run("UPDATE catch_up_progress SET summary_id = 'someone-else'");
    db.close();
    rehash(archivePath);

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, reducer),
      "corrupt",
      slotsDir,
    );
    closeStore(store);
  });

  test("an archive of a store with no summary imports with none", () => {
    const store = buildPopulatedStore(join(dir, "world.sqlite"));
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);

    const slot = importArchive(archivePath, join(dir, "slots"), reducer);

    const imported = openStore(join(slot.slotPath, "world.sqlite"), reducer);
    expect(readCatchUpSummary(imported.db)).toBeUndefined();
    closeStore(imported);
    closeStore(store);
  });

  test("the content hash covers the summary: changing it without rehashing is rejected; no slot is created", () => {
    const store = storeWithSummary(join(dir, "world.sqlite"));
    const archivePath = join(dir, "archive.sqlite");
    exportArchive(store, archivePath);
    const db = new Database(archivePath);
    db.run("UPDATE catch_up_summary SET summary_id = 'forged'");
    db.close();

    const slotsDir = join(dir, "slots");
    expectRejected(
      () => importArchive(archivePath, slotsDir, reducer),
      "inconsistent-manifest",
      slotsDir,
    );
    closeStore(store);
  });

  test.each([
    ["an empty id", "summary_id = ''"],
    ["a sequence beyond the archive's event log", "at_sequence = 99"],
    ["a negative sequence", "at_sequence = -1"],
    ["a negative applied time", "applied_ms = -1"],
    ["a negative skipped time", "skipped_ms = -1"],
    ["outcomes that are not JSON", "major_outcomes = 'not json'"],
    ["outcomes that are not a list", "major_outcomes = '{\"a\":1}'"],
    ["outcomes with a non-string entry", "major_outcomes = '[\"ok\", 7]'"],
  ])(
    "a rehashed archive with %s is rejected as corrupt; no slot is created",
    (_label, set) => {
      const store = storeWithSummary(join(dir, "world.sqlite"));
      const archivePath = join(dir, "archive.sqlite");
      exportArchive(store, archivePath);
      const db = new Database(archivePath);
      // Past the schema's own CHECKs, as a hand-edited archive would be.
      db.exec("PRAGMA ignore_check_constraints = ON");
      db.run(`UPDATE catch_up_summary SET ${set}`);
      db.close();
      rehash(archivePath);

      const slotsDir = join(dir, "slots");
      expectRejected(
        () => importArchive(archivePath, slotsDir, reducer),
        "corrupt",
        slotsDir,
      );
      closeStore(store);
    },
  );
});
