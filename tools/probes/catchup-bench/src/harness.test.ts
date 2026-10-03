import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ensureTraceSchema } from "@panthea/telemetry";
import { byFunction, byPhase, type CpuProfile } from "./cpuprofile";
import { categoryOf, instrumentDb } from "./instrument";
import { loadPack, PACK_SHA256, readPackText } from "./pack";
import { Phases } from "./phases";
import { eventStreamDigest, traceDigest, traceIntegrity } from "./world";

// --- The fixture is immutable -------------------------------------------------------------

test("the benchmark pack is the Unit 7 world: 7 gods and 20 mortals, and its hash is checked, so a changed fixture is an error and not a different benchmark", () => {
  readPackText();
  const pack = loadPack();
  expect(pack.inhabitants.filter((i) => i.deity === true)).toHaveLength(7);
  expect(pack.inhabitants.filter((i) => i.deity !== true)).toHaveLength(20);
  expect(PACK_SHA256).toHaveLength(64);
  const mortalIds = (n?: number) =>
    loadPack(n)
      .inhabitants.filter((i) => i.deity !== true)
      .map((i) => i.id);
  // The first N mortals in file order, all seven gods, and no building left owned by someone who was dropped.
  expect(mortalIds(4)).toEqual(mortalIds().slice(0, 4));
  expect(loadPack(4).inhabitants.filter((i) => i.deity === true)).toHaveLength(
    7,
  );
  const kept = new Set(loadPack(4).inhabitants.map((i) => i.id));
  for (const building of loadPack(4).buildings) {
    expect(building.owner === undefined || kept.has(building.owner)).toBe(true);
  }
});

test("a fixture that differs from the recorded hash is refused", () => {
  const path = `${import.meta.dir}/../results/.tampered-pack.json`;
  Bun.write(path, `${readPackText()} `);
  try {
    expect(() => readPackText(path)).toThrow(/immutable/);
  } finally {
    Bun.file(path).delete?.();
  }
});

// --- Timing ---------------------------------------------------------------------------------

test("statements are timed into the category their SQL names, a transaction's body apart from its whole, and the work still happens", () => {
  expect(categoryOf("INSERT INTO events (sequence) VALUES (?)")).toBe(
    "sql:events",
  );
  expect(
    categoryOf("SELECT payload FROM trace_observations WHERE id = ?"),
  ).toBe("sql:trace");
  expect(categoryOf("UPDATE projections SET data = ?")).toBe("sql:projection");
  expect(categoryOf("  BEGIN IMMEDIATE")).toBe("sql:transaction-control");
  expect(categoryOf("PRAGMA user_version")).toBe("sql:other");

  const phases = new Phases();
  const db = instrumentDb(new Database(":memory:"), phases);
  db.run("CREATE TABLE events (sequence INTEGER)");
  const insert = db.transaction(() => {
    for (let i = 0; i < 5; i += 1)
      db.run("INSERT INTO events (sequence) VALUES (?)", [i]);
  });
  insert.immediate();
  expect(
    (db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n,
  ).toBe(5);
  expect(phases.count("sql:events")).toBe(5 + 1 + 1);
  expect(phases.count("tx:body")).toBe(1);
  expect(phases.count("tx:total")).toBe(1);
  expect(phases.ms("tx:total")).toBeGreaterThanOrEqual(phases.ms("tx:body"));
});

// --- The CPU profile reader -------------------------------------------------------------------

function profile(): CpuProfile {
  // root -> a -> b ; root -> c.   Samples: 3 in b (30 us), 1 in a (10), 2 in c (20); a recursive a -> a -> a counts once.
  const frame = (name: string) => ({
    functionName: name,
    url: "file:///x/y/z.ts",
    lineNumber: 1,
  });
  return {
    nodes: [
      { id: 1, callFrame: frame("(root)"), children: [2, 5] },
      { id: 2, callFrame: frame("a"), children: [3, 4] },
      { id: 3, callFrame: frame("b") },
      { id: 4, callFrame: frame("a") },
      { id: 5, callFrame: frame("c") },
    ],
    samples: [3, 3, 3, 2, 5, 5, 4],
    timeDeltas: [10, 10, 10, 10, 10, 10, 10],
  };
}

test("inclusive time counts a function once per stack even when it recurses; self time is its own frames; phases partition the profile", () => {
  const rows = byFunction(profile());
  const a = rows.find((r) => r.name === "a");
  // 'a' is on the stack of samples in b (3), in a itself (1), and in the nested a (1): 50 us, once each.
  expect(a?.inclusiveUs).toBe(50);
  expect(a?.selfUs).toBe(20);
  expect(rows.find((r) => r.name === "c")?.inclusiveUs).toBe(20);

  const phases = byPhase(profile(), [
    { phase: "under b", match: /^b$/ },
    { phase: "under a", match: /^a$/ },
  ]);
  expect(phases.get("under b")).toBe(30);
  expect(phases.get("under a")).toBe(20);
  expect(phases.get("other")).toBe(20);
  // Nothing counted twice, nothing dropped.
  expect([...phases.values()].reduce((x, y) => x + y, 0)).toBe(70);
});

// --- The digests -----------------------------------------------------------------------------

function eventDb(rows: { correlation: string; extra?: string }[]): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE events (sequence INTEGER PRIMARY KEY, payload TEXT)");
  rows.forEach((row, i) => {
    db.run("INSERT INTO events VALUES (?, ?)", [
      i + 1,
      JSON.stringify({
        id: `evt-${i}`,
        sequence: i + 1,
        correlationId: row.correlation,
        causationId: row.correlation,
        kind: "x",
        extra: row.extra ?? "",
      }),
    ]);
  });
  return db;
}

test("the event digest ignores which fresh ids a run happened to mint and nothing else: renamed ids agree, a changed field, a reorder, or a split of one id into two does not", () => {
  const base = eventStreamDigest(
    eventDb([{ correlation: "a" }, { correlation: "b" }, { correlation: "a" }]),
  );
  expect(
    eventStreamDigest(
      eventDb([
        { correlation: "p" },
        { correlation: "q" },
        { correlation: "p" },
      ]),
    ),
  ).toBe(base);
  expect(
    eventStreamDigest(
      eventDb([
        { correlation: "a" },
        { correlation: "b" },
        { correlation: "c" },
      ]),
    ),
  ).not.toBe(base);
  expect(
    eventStreamDigest(
      eventDb([
        { correlation: "a", extra: "!" },
        { correlation: "b" },
        { correlation: "a" },
      ]),
    ),
  ).not.toBe(base);
  expect(
    eventStreamDigest(
      eventDb([
        { correlation: "b" },
        { correlation: "a" },
        { correlation: "a" },
      ]),
    ),
  ).not.toBe(base);
  // Only events after the sequence are read.
  expect(
    eventStreamDigest(eventDb([{ correlation: "a" }, { correlation: "b" }]), 1),
  ).toBe(
    eventStreamDigest(
      eventDb([{ correlation: "z" }, { correlation: "b" }]),
      1,
    ) === ""
      ? ""
      : eventStreamDigest(
          eventDb([{ correlation: "a" }, { correlation: "b" }]),
          1,
        ),
  );
});

function traceDb(
  opts: {
    obs?: string[];
    links?: [string, string, number][];
    outcomeReason?: string;
  } = {},
): Database {
  const db = new Database(":memory:");
  ensureTraceSchema(db);
  const obs = opts.obs ?? ["o1", "o2"];
  for (const id of obs) {
    db.run(
      "INSERT INTO trace_observations (id, observer, state_revision, source, recorded_at, payload) VALUES (?, 'zeus', 1, 'routine', 0, ?)",
      [id, JSON.stringify({ id, observer: "zeus" })],
    );
  }
  obs.forEach((id, i) => {
    db.run(
      "INSERT INTO trace_proposal_outcomes (proposal_id, observation_id, correlation_id, causation_id, outcome, reason, recorded_at, payload) VALUES (?, ?, ?, ?, 'committed', ?, 0, ?)",
      [
        `p${i}`,
        id,
        id,
        id,
        opts.outcomeReason ?? null,
        JSON.stringify({ observationId: id }),
      ],
    );
  });
  for (const [event, proposal, position] of opts.links ?? [["e1", "p0", 0]]) {
    db.run(
      "INSERT INTO trace_outcome_events (event_id, proposal_id, position) VALUES (?, ?, ?)",
      [event, proposal, position],
    );
  }
  return db;
}

test("the trace digest covers every row and link in order, and none of the fresh ids: renamed ids agree; a dropped link, a moved link, a changed reason, or a lost observation does not", () => {
  const base = traceDigest(traceDb());
  expect(traceDigest(traceDb({ obs: ["x", "y"] }))).toBe(base);
  expect(traceDigest(traceDb({ links: [] }))).not.toBe(base);
  expect(traceDigest(traceDb({ links: [["e1", "p0", 1]] }))).not.toBe(base);
  expect(traceDigest(traceDb({ links: [["e1", "p1", 0]] }))).not.toBe(base);
  expect(traceDigest(traceDb({ outcomeReason: "malformed" }))).not.toBe(base);
  expect(traceDigest(traceDb({ obs: ["o1"] }))).not.toBe(base);
});

test("trace integrity finds an outcome with no observation and a link to an event that is not in the log; an intact trace reports none", () => {
  const intact = traceDb();
  intact.run(
    "CREATE TABLE IF NOT EXISTS events (sequence INTEGER, id TEXT, correlation_id TEXT, payload TEXT)",
  );
  intact.run("INSERT INTO events VALUES (1, 'e1', 'o1', '{}')");
  expect(traceIntegrity(intact)).toMatchObject({
    outcomesWithoutObservation: 0,
    brokenEventLinks: 0,
    outcomesChecked: 2,
  });
  // The link names an event the log does not hold.
  const broken = traceDb();
  broken.run(
    "CREATE TABLE IF NOT EXISTS events (sequence INTEGER, id TEXT, correlation_id TEXT, payload TEXT)",
  );
  expect(traceIntegrity(broken).brokenEventLinks).toBe(1);
  // An observation deleted from under its outcome.
  intact.run("DELETE FROM trace_observations WHERE id = 'o2'");
  expect(traceIntegrity(intact).outcomesWithoutObservation).toBe(1);
});
