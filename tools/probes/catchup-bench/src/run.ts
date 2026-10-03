// The catch-up benchmark: a fixed 3,600-tick (one simulated hour) catch-up on
// the immutable Unit 7 pack, a fixed seed, and on-disk SQLite, for 4 mortals
// and 20, from a fresh world and from an aged one, several repetitions each.
//
//   bun run bench                          # the full matrix, 5 repetitions
//   bun run bench -- --reps=3 --mortals=20 --worlds=fresh
//   bun run bench -- --label=after-fix-1 --out=results/after-fix-1.json
//
// Per configuration it records the real function's total and per-chunk times
// (`runEndToEnd`), the instrumented hour's phase split (`runPhases`), row
// counts and bytes, WAL growth, and two digests that must not change when the
// code is made faster: the event stream (observation ids renamed in order of
// appearance) and the final projection.

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureEnvironment } from "@panthea/tools-probes-shared";
import { runEndToEnd, runPhases } from "./measure";
import { PACK_SHA256 } from "./pack";
import {
  type ConfigResult,
  countsTable,
  HEADLINE_HEAD,
  headline,
  phaseTable,
} from "./report";
import {
  ageWorld,
  cloneWorldDir,
  createWorld,
  makeRunDir,
  reopenWorld,
} from "./world";

interface Args {
  reps: number;
  mortals: number[];
  worlds: ("fresh" | "aged")[];
  agedHours: number;
  label: string;
  out: string | undefined;
  dir: string | undefined;
  phases: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    reps: 5,
    mortals: [4, 20],
    worlds: ["fresh", "aged"],
    agedHours: 6,
    label: "run",
    out: undefined,
    dir: undefined,
    phases: true,
  };
  for (const arg of argv) {
    const [key, value = ""] = arg.replace(/^--/, "").split("=");
    if (key === "reps") args.reps = Number(value);
    else if (key === "mortals") args.mortals = value.split(",").map(Number);
    else if (key === "worlds") {
      args.worlds = value.split(",") as Args["worlds"];
    } else if (key === "aged-hours") args.agedHours = Number(value);
    else if (key === "label") args.label = value;
    else if (key === "out") args.out = value;
    else if (key === "dir") args.dir = value;
    else if (key === "no-phases") args.phases = false;
    else throw new Error(`unknown option --${key}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const results: ConfigResult[] = [];
  const base = args.dir;

  for (const mortals of args.mortals) {
    for (const kind of args.worlds) {
      console.error(`== ${mortals} mortals, ${kind} world`);
      // A starting point every repetition copies from: genesis, or the aged store.
      let seed: string | undefined;
      if (kind === "aged") {
        const dir = makeRunDir("catchup-bench-aged-", base);
        const world = createWorld(dir, mortals);
        const start = performance.now();
        await ageWorld(world, args.agedHours);
        console.error(
          `   aged ${args.agedHours} h in ${Math.round(performance.now() - start)} ms`,
        );
        world.close();
        seed = dir;
      }
      const fresh = (): ReturnType<typeof createWorld> => {
        if (seed === undefined) {
          return createWorld(makeRunDir("catchup-bench-run-", base), mortals);
        }
        return reopenWorld(cloneWorldDir(seed, base), mortals);
      };

      const endToEnd = [];
      const phases = [];
      for (let rep = 0; rep < args.reps; rep += 1) {
        const world = fresh();
        endToEnd.push(await runEndToEnd(world));
        world.dispose();
        console.error(
          `   rep ${rep + 1} end-to-end ${Math.round(endToEnd[rep]?.totalMs ?? 0)} ms`,
        );
      }
      if (args.phases) {
        for (let rep = 0; rep < args.reps; rep += 1) {
          const world = fresh();
          phases.push(await runPhases(world));
          world.dispose();
          console.error(
            `   rep ${rep + 1} phases ${Math.round(phases[rep]?.totalMs ?? 0)} ms`,
          );
        }
      }
      if (seed !== undefined) rmSync(seed, { recursive: true, force: true });
      results.push({
        mortals,
        world: kind,
        agedHours: kind === "aged" ? args.agedHours : 0,
        endToEnd,
        phases,
      });
    }
  }

  // Every repetition of a configuration drew the same dice: their digests agree.
  const digests = results.map((result) => ({
    mortals: result.mortals,
    world: result.world,
    eventDigests: [...new Set(result.endToEnd.map((r) => r.eventDigest))],
    projectionDigests: [
      ...new Set(result.endToEnd.map((r) => r.projectionDigest)),
    ],
    phaseRunDigestsAgree: result.phases.every(
      (run) => run.eventDigest === result.endToEnd[0]?.eventDigest,
    ),
  }));

  const lines = [
    `# Catch-up benchmark: ${args.label}`,
    "",
    `Pack sha256 ${PACK_SHA256}; ${args.reps} repetitions per configuration.`,
    "",
    ...HEADLINE_HEAD,
    ...results.flatMap(headline),
    "",
  ];
  for (const result of results) {
    lines.push(
      `## ${result.mortals} mortals, ${result.world}`,
      "",
      ...(result.phases.length > 0 ? phaseTable(result) : []),
      "",
      ...countsTable(result),
      "",
    );
  }
  lines.push(
    "## Digests",
    "",
    "```json",
    JSON.stringify(digests, null, 2),
    "```",
  );
  const markdown = lines.join("\n");
  console.log(markdown);
  if (args.out !== undefined) {
    writeFileSync(
      args.out,
      `${JSON.stringify({ label: args.label, args, environment: captureEnvironment(), results, digests }, null, 2)}\n`,
    );
    writeFileSync(args.out.replace(/\.json$/, ".md"), `${markdown}\n`);
  }
  void join;
}

await main();
