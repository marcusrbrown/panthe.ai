// A sampled CPU profile of one hour of catch-up, by function and by phase.
//
//   bun run bench:profile -- --mortals=20 --world=aged [--aged-hours=6]
//
// It builds the world (genesis, or aged by real catch-ups), then runs one hour
// of the real `runCatchUp` in a child process under `bun --cpu-prof` and reads
// the profile back. The phase table is what splits `stepWorldTick` and the
// commit into the parts a timer around the whole call cannot see.

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  byFunction,
  byPhase,
  type CpuProfile,
  type PhaseRule,
} from "./cpuprofile";
import { round } from "./stats";
import { ageWorld, createWorld, makeRunDir } from "./world";

/**
 * Which phase a sample belongs to, tried in order against every function on its
 * stack, so a sample inside `judgePractices` called from `stepWorldTick` is
 * practice judging and not simulation in general.
 */
export const PHASES: readonly PhaseRule[] = [
  { phase: "trace: JS and SQL (traceWorldTick)", match: /^traceWorldTick$/ },
  {
    phase: "transaction control (BEGIN, COMMIT, WAL write)",
    match: /^#runNoArgs$/,
  },
  {
    phase: "commit: projection read/reduce/encode/write",
    match: /^(readProjectionsRow|writeProjectionsRow)$/,
  },
  { phase: "commit: event rows", match: /^insertEventRow$/ },
  {
    phase: "commit: other (commitTick, clock, progress)",
    match:
      /^(commitTick|writeClock|writeCatchUpProgress|writePrngState|getCurrentSequence)$/,
  },
  {
    phase: "summary (closeCatchUpBacklog)",
    match: /^(closeCatchUpBacklog|accountOf)$/,
  },
  {
    phase: "routine planning (buildRoutineQueue)",
    match: /^(buildRoutineQueue|decideRoutineProposal)$/,
  },
  {
    phase: "world: practice judging",
    match: /^(judgePractices|planConsequences)$/,
  },
  { phase: "world: needs", match: /^planNeedStep$/ },
  { phase: "world: income", match: /^planIncomeStep$/ },
  { phase: "world: fire", match: /^planFireStep$/ },
  { phase: "world: director", match: /^planDirectorStep$/ },
  { phase: "world: notices", match: /^planNoticeStep$/ },
  {
    phase: "world: memory and perception",
    match:
      /^(derive|deriveMemories|perceive|recordMemory|getMemories|planMemory|memoryEvents|relationship)/,
  },
  {
    phase: "world: validation and application (runTick)",
    match: /^(runTick|submitProposal|validateProposal|applyEvents|applyEvent)$/,
  },
  {
    phase: "simulation: step and queue (stepWorldTick)",
    match: /^(stepWorldTick|mergeTickQueue|screenObservations)$/,
  },
];

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ??
  fallback;

async function main(): Promise<void> {
  const mortals = Number(arg("mortals", "20"));
  const kind = arg("world", "aged");
  const agedHours = Number(arg("aged-hours", "6"));
  const top = Number(arg("top", "30"));
  const out = arg("out", "");

  const dir = makeRunDir("catchup-bench-profile-");
  const world = createWorld(dir, mortals);
  if (kind === "aged") await ageWorld(world, agedHours);
  world.close();

  const profDir = join(dir, "prof");
  mkdirSync(profDir);
  const child = Bun.spawnSync(
    [
      "bun",
      "--cpu-prof",
      `--cpu-prof-dir=${profDir}`,
      "--cpu-prof-interval=500",
      join(import.meta.dir, "profile-child.ts"),
      dir,
      String(mortals),
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  if (child.exitCode !== 0)
    throw new Error(`profile child exited ${child.exitCode}`);
  const file = readdirSync(profDir).find((f) => f.endsWith(".cpuprofile"));
  if (file === undefined) throw new Error("no cpuprofile written");
  const profile = JSON.parse(
    readFileSync(join(profDir, file), "utf8"),
  ) as CpuProfile;
  rmSync(dir, { recursive: true, force: true });

  const phases = byPhase(profile, PHASES);
  const total = [...phases.values()].reduce((a, b) => a + b, 0);
  const lines = [
    `# CPU profile: ${mortals} mortals, ${kind}${kind === "aged" ? ` (${agedHours} h)` : ""}`,
    "",
    `Sampled ${round(total / 1000)} ms (the child's whole run, startup included); real hour ${child.stdout.toString().trim()}.`,
    "",
    "| Phase | ms | Share |",
    "| --- | --- | --- |",
    ...[...phases.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(
        ([phase, us]) =>
          `| ${phase} | ${round(us / 1000)} | ${round((us / total) * 100)}% |`,
      ),
    "",
    `## Top ${top} functions by inclusive time`,
    "",
    "| Function | File | Inclusive ms | Self ms |",
    "| --- | --- | --- | --- |",
    ...byFunction(profile)
      .filter((f) => !f.name.startsWith("("))
      .slice(0, top)
      .map(
        (f) =>
          `| ${f.name} | ${f.file} | ${round(f.inclusiveUs / 1000)} | ${round(f.selfUs / 1000)} |`,
      ),
    "",
    `## Top ${top} functions by self time`,
    "",
    "| Function | File | Self ms | Inclusive ms |",
    "| --- | --- | --- | --- |",
    ...byFunction(profile)
      .sort((a, b) => b.selfUs - a.selfUs)
      .slice(0, top)
      .map(
        (f) =>
          `| ${f.name} | ${f.file} | ${round(f.selfUs / 1000)} | ${round(f.inclusiveUs / 1000)} |`,
      ),
  ];
  const text = lines.join("\n");
  console.log(text);
  if (out !== "") writeFileSync(out, `${text}\n`);
}

await main();
