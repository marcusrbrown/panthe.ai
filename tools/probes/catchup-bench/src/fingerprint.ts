// The identity of what catch-up writes, for proving a change did not alter it.
//
//   bun run src/fingerprint.ts --out=results/fingerprint-baseline.json
//   bun run src/fingerprint.ts --compare=results/fingerprint-baseline.json
//
// For each world it runs one hour of the real `runCatchUp` (an aged world
// ages first, by real catch-ups) and records three digests of everything the
// run left in the store: the whole event log, the whole trace (every row and
// link, in order), and the stored projection. Ids minted fresh each run are
// renamed in order of first appearance, so two runs of the same world agree
// exactly or not at all. `--compare` exits non-zero on any difference.

import { readFileSync, writeFileSync } from "node:fs";
import { runEndToEnd } from "./measure";
import {
  ageWorld,
  createWorld,
  eventStreamDigest,
  makeRunDir,
  projectionDigest,
  traceDigest,
} from "./world";

interface Fingerprint {
  readonly name: string;
  readonly events: number;
  readonly eventDigest: string;
  readonly traceDigest: string;
  readonly projectionDigest: string;
}

const WORLDS = [
  { name: "4 mortals, fresh", mortals: 4, agedHours: 0 },
  { name: "20 mortals, fresh", mortals: 20, agedHours: 0 },
  { name: "20 mortals, aged 3 h", mortals: 20, agedHours: 3 },
] as const;

async function fingerprints(): Promise<Fingerprint[]> {
  const out: Fingerprint[] = [];
  for (const spec of WORLDS) {
    const dir = makeRunDir("catchup-bench-fp-");
    const world = createWorld(dir, spec.mortals);
    if (spec.agedHours > 0) await ageWorld(world, spec.agedHours);
    await runEndToEnd(world);
    const db = world.store.db;
    out.push({
      name: spec.name,
      events: (
        db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }
      ).n,
      // The whole log: the aging hours and the measured hour together.
      eventDigest: eventStreamDigest(db, 0),
      traceDigest: traceDigest(db),
      projectionDigest: projectionDigest(db),
    });
    world.dispose();
    console.error(`fingerprinted ${spec.name}`);
  }
  return out;
}

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

const result = await fingerprints();
const out = arg("out");
if (out !== undefined) {
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
}
const compare = arg("compare");
if (compare !== undefined) {
  const expected = JSON.parse(readFileSync(compare, "utf8")) as Fingerprint[];
  let differs = false;
  for (const want of expected) {
    const got = result.find((r) => r.name === want.name);
    for (const key of [
      "events",
      "eventDigest",
      "traceDigest",
      "projectionDigest",
    ] as const) {
      if (got?.[key] !== want[key]) {
        differs = true;
        console.error(
          `DIFFERENT ${want.name}: ${key} ${String(got?.[key])} != ${String(want[key])}`,
        );
      }
    }
  }
  console.log(differs ? "fingerprints differ" : "fingerprints identical");
  process.exit(differs ? 1 : 0);
}
console.log(JSON.stringify(result, null, 2));
