// Why the trace's writes were slow: not statement overhead, but where a
// random-key insert lands. 72,000 observation-shaped rows are inserted in
// 1,200-row transactions (a 60-second chunk) into a table that already holds
// 500,000, with the same settings the store uses (WAL, synchronous=NORMAL).
//
//   bun run src/index-locality.ts
//
// A statement-level change (prepared and cached, multi-row, `ON CONFLICT DO
// NOTHING` in place of a select first) moves the total by about a fifth; the
// keys' order moves it by a factor of twelve. A bigger page cache alone does
// nothing, since the pages touched are spread over the whole index.

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timeOrderedIdFactory } from "@panthea/contracts";

const PRE = 500_000;
const N = 72_000;
const CHUNK = 1_200;
const payload = JSON.stringify({
  schemaVersion: 1,
  observer: "farmer",
  stateRevision: 12,
  factsRead: ["actor:farmer", "needs:food", "place:square"],
  source: "routine",
});
const row = (id: string): [string, string, number, string, number, string] => [
  id,
  "farmer",
  1,
  "routine",
  0,
  payload,
];

const random = () => `obs-${crypto.randomUUID()}`;
const ordered = timeOrderedIdFactory<"X">("obs");

function prefilled(next: () => string, cacheKiB?: number) {
  const dir = mkdtempSync(join(tmpdir(), "catchup-bench-locality-"));
  const db = new Database(join(dir, "w.sqlite"), { create: true });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL");
  db.exec(
    "CREATE TABLE o (id TEXT PRIMARY KEY, observer TEXT NOT NULL, state_revision INTEGER NOT NULL, source TEXT NOT NULL, recorded_at INTEGER NOT NULL, payload TEXT NOT NULL) STRICT",
  );
  const insert = db.query("INSERT INTO o VALUES (?,?,?,?,?,?)");
  db.transaction(() => {
    for (let i = 0; i < PRE; i += 1) insert.run(...row(next()));
  }).immediate();
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  if (cacheKiB !== undefined) db.exec(`PRAGMA cache_size=-${cacheKiB}`);
  return { db, dir };
}

type Insert = (db: Database, ids: string[]) => void;

function run(
  label: string,
  next: () => string,
  insert: Insert,
  cacheKiB?: number,
): string {
  const { db, dir } = prefilled(next, cacheKiB);
  const start = performance.now();
  for (let i = 0; i < N; i += CHUNK) {
    const ids = Array.from({ length: CHUNK }, next);
    db.transaction(() => insert(db, ids)).immediate();
  }
  const ms = Math.round(performance.now() - start);
  db.close();
  rmSync(dir, { recursive: true, force: true });
  return `| ${label} | ${ms} ms |`;
}

const selectThenInsert: Insert = (db, ids) => {
  const get = db.query("SELECT payload FROM o WHERE id = ?");
  for (const id of ids) {
    get.get(id);
    db.run("INSERT INTO o VALUES (?,?,?,?,?,?)", row(id));
  }
};
const cached: Insert = (db, ids) => {
  const insert = db.query("INSERT INTO o VALUES (?,?,?,?,?,?)");
  for (const id of ids) insert.run(...row(id));
};
const onConflict: Insert = (db, ids) => {
  const insert = db.query(
    "INSERT INTO o VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
  );
  for (const id of ids) insert.run(...row(id));
};

console.log(
  [
    "| 72,000 inserts into a 500,000-row table | Total |",
    "| --- | --- |",
    run(
      "random ids, select then insert (what the trace did)",
      random,
      selectThenInsert,
    ),
    run("random ids, cached statement", random, cached),
    run("random ids, `ON CONFLICT DO NOTHING`", random, onConflict),
    run("random ids, cached, 64 MiB page cache", random, cached, 65_536),
    run("time-ordered ids, select then insert", ordered, selectThenInsert),
    run("time-ordered ids, cached statement", ordered, cached),
  ].join("\n"),
);
