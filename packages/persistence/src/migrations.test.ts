import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentSchemaVersion,
  MIGRATIONS,
  type Migration,
  migrate,
  UnsupportedSchemaVersionError,
} from "./migrations";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "panthea-migrations-"));
  dbPath = join(dir, "world.sqlite");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("migrate", () => {
  test("happy path: a fresh database migrates to the latest version and creates every STRICT table", () => {
    const db = new Database(dbPath, { create: true });
    migrate(db, dbPath);

    expect(currentSchemaVersion(db)).toBe(
      MIGRATIONS[MIGRATIONS.length - 1]?.version,
    );
    const tables = db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("world");
    expect(names).toContain("clock");
    expect(names).toContain("prng_state");
    expect(names).toContain("projections");
    expect(names).toContain("events");
    db.close();
  });

  test("happy path: a slot written by a previous schema version migrates forward without loss", () => {
    const v1: Migration = {
      version: 1,
      description: "v1: just a marker table",
      up(db) {
        db.exec("CREATE TABLE legacy_marker (id INTEGER PRIMARY KEY) STRICT");
        db.run("INSERT INTO legacy_marker (id) VALUES (1)");
      },
    };
    const v2: Migration = {
      version: 2,
      description: "v2: adds a second table, leaves v1's data intact",
      up(db) {
        db.exec("CREATE TABLE added_later (id INTEGER PRIMARY KEY) STRICT");
      },
    };

    const db = new Database(dbPath, { create: true });
    migrate(db, dbPath, { migrations: [v1] });
    expect(currentSchemaVersion(db)).toBe(1);

    migrate(db, dbPath, { migrations: [v1, v2] });
    expect(currentSchemaVersion(db)).toBe(2);

    const marker = db.query("SELECT id FROM legacy_marker").get() as {
      id: number;
    };
    expect(marker.id).toBe(1);

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain("added_later");
    db.close();
  });

  test("happy path: a pre-migration snapshot file is written before an upgrade with existing data", () => {
    const v1: Migration = {
      version: 1,
      up(db) {
        db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY) STRICT");
      },
      description: "v1",
    };
    const v2: Migration = {
      version: 2,
      up(db) {
        db.exec("ALTER TABLE t ADD COLUMN note TEXT");
      },
      description: "v2",
    };

    const db = new Database(dbPath, { create: true });
    migrate(db, dbPath, { migrations: [v1] });
    db.run("INSERT INTO t (id) VALUES (1)");

    migrate(db, dbPath, { migrations: [v1, v2] });

    const backups = readdirSync(dir).filter((name) =>
      name.includes("pre-migration"),
    );
    expect(backups.length).toBeGreaterThan(0);
    db.close();
  });

  test("error path: a slot whose schema version is newer than this build understands is left untouched and reported", () => {
    const onlyV1: Migration = {
      version: 1,
      up(db) {
        db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY) STRICT");
      },
      description: "v1",
    };

    const db = new Database(dbPath, { create: true });
    // Fast-forward the raw user_version past what our (test) ladder knows,
    // without ever running migration logic — simulates opening a slot
    // written by a newer build.
    db.exec("PRAGMA user_version = 99");

    expect(() => migrate(db, dbPath, { migrations: [onlyV1] })).toThrow(
      UnsupportedSchemaVersionError,
    );
    expect(currentSchemaVersion(db)).toBe(99);
    db.close();
  });

  test("idempotent: migrating an already-current database is a no-op", () => {
    const db = new Database(dbPath, { create: true });
    migrate(db, dbPath);
    const before = currentSchemaVersion(db);
    migrate(db, dbPath);
    expect(currentSchemaVersion(db)).toBe(before);
    db.close();
  });
});
