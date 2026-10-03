// What the commit overhead is. Runs one instrumented hour on copies of one aged
// world under different SQLite settings and prints the commit's own cost
// (everything in a transaction beyond its body: BEGIN, COMMIT, the WAL write,
// and any checkpoint a commit triggers).
//
//   bun run src/pragmas.ts [--mortals=20] [--aged-hours=4]
//
// This is a diagnostic. It does not change the store's settings and a setting
// that wins here is not thereby adopted: `synchronous=OFF`, for one, is ruled
// out (docs/plans), and an unbounded WAL is not a fix.

import { runPhases } from "./measure";
import {
  ageWorld,
  cloneWorldDir,
  createWorld,
  makeRunDir,
  reopenWorld,
} from "./world";

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ??
  fallback;

const mortals = Number(arg("mortals", "20"));
const agedHours = Number(arg("aged-hours", "4"));

const SETTINGS: readonly (readonly [string, readonly string[]])[] = [
  ["default (wal_autocheckpoint=1000 pages, cache 2 MiB)", []],
  ["wal_autocheckpoint=0", ["PRAGMA wal_autocheckpoint=0"]],
  ["wal_autocheckpoint=16384 (64 MiB)", ["PRAGMA wal_autocheckpoint=16384"]],
  ["cache_size=64 MiB", ["PRAGMA cache_size=-65536"]],
  [
    "wal_autocheckpoint=16384 + cache_size=64 MiB",
    ["PRAGMA wal_autocheckpoint=16384", "PRAGMA cache_size=-65536"],
  ],
];

const dir = makeRunDir("catchup-bench-pragmas-");
const seed = createWorld(dir, mortals);
await ageWorld(seed, agedHours);
seed.close();

const lines = [
  `| Setting | Hour | commit:total | commit overhead | sql:trace | WAL peak |`,
  `| --- | --- | --- | --- | --- | --- |`,
];
for (const [label, pragmas] of SETTINGS) {
  const world = reopenWorld(cloneWorldDir(dir), mortals);
  for (const pragma of pragmas) world.store.db.exec(pragma);
  const run = await runPhases(world);
  const p = run.phases;
  const overhead = (p["tx:total"]?.ms ?? 0) - (p["tx:body"]?.ms ?? 0);
  lines.push(
    `| ${label} | ${Math.round(run.totalMs)} ms | ${Math.round(p["commit:total"]?.ms ?? 0)} ms | ${Math.round(overhead)} ms | ${Math.round(p["sql:trace"]?.ms ?? 0)} ms | ${Math.round(run.walPeakBytes / 1024)} KiB |`,
  );
  world.dispose();
}
console.log(lines.join("\n"));
