// Headless M1 causal scenario. Drives the compiled sidecar (no Tauri)
// through the persistent living-world story and exits non-zero on the
// first violated invariant. Not part of `bun run check`: it builds and
// spawns a binary and runs for minutes.
//
//   bun run scenario:m1                              run the story
//   bun run scenario:m1 --skip-build                 reuse the existing sidecar binary
//   bun run scenario:m1 --positive-control=<name>    break one check on purpose; must fail
//   bun run scenario:m1 --write-readme               run the story and both controls, rewrite README.md

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureEnvironment, renderReport } from "@panthea/tools-probes-shared";
import { ScenarioFailure } from "./helpers";
import { buildReportInput, type ControlResult } from "./report";
import { killAllSidecars, REPO_ROOT } from "./sidecar";
import {
  CONTROL_NAMES,
  type ControlName,
  runStory,
  type StoryOptions,
} from "./story";

interface Args extends StoryOptions {
  readonly writeReadme: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let control: ControlName | undefined;
  let writeReadme = false;
  let skipBuild = false;
  for (const arg of argv) {
    if (arg === "--write-readme") writeReadme = true;
    else if (arg === "--skip-build") skipBuild = true;
    else if (arg === "--positive-control") control = "archive";
    else if (arg.startsWith("--positive-control=")) {
      const name = arg.slice("--positive-control=".length);
      if (!(CONTROL_NAMES as readonly string[]).includes(name)) {
        throw new Error(
          `unknown positive control: ${name} (expected ${CONTROL_NAMES.join(", ")})`,
        );
      }
      control = name as ControlName;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { ...(control ? { control } : {}), writeReadme, skipBuild };
}

const CONTROL_SABOTAGE: Readonly<Record<ControlName, string>> = {
  archive:
    'The harness skips the byte change, so the "corrupted" copy is a clean export and importing it must be refused.',
  "catch-up":
    "After the kill, the harness rewinds the persisted cursor to where the chunks began, so the restart replays time the committed chunks already applied.",
  journal:
    "After the kill, the harness deletes the accepted proposal from the journal, as if the service had kept it only in memory, so nothing consumes it after the restart.",
};

/** Runs the story again in a child process with a control enabled, and reports how it ended. */
async function runControl(name: ControlName): Promise<ControlResult> {
  const child = Bun.spawn(
    [
      "bun",
      "run",
      import.meta.path,
      "--skip-build",
      `--positive-control=${name}`,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const failure =
    `${out}\n${err}`.split("\n").find((line) => line.startsWith("FAIL")) ??
    "(no FAIL line)";
  return { name, sabotage: CONTROL_SABOTAGE[name], exitCode, failure };
}

function commitHash(): string {
  const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
    cwd: REPO_ROOT,
  });
  return result.stdout.toString().trim() || "unknown";
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const startedAt = Date.now();
  process.on("SIGINT", () => {
    killAllSidecars();
    process.exit(130);
  });
  try {
    const { steps, binaryBytes } = await runStory(args, (step) => {
      console.log(
        `PASS ${step.id} ${step.title} (${(step.elapsedMs / 1000).toFixed(1)} s): ${step.result}`,
      );
    });
    const totalMs = Date.now() - startedAt;
    console.log(
      `\nOK ${steps.length} steps in ${(totalMs / 1000).toFixed(1)} s`,
    );
    if (args.control) {
      // A control that gets here broke nothing: the assertions it targets are not live.
      console.error(
        `\nFAIL positive control ${args.control} did not trip any invariant`,
      );
      process.exit(1);
    }
    if (args.writeReadme) {
      const controls: ControlResult[] = [];
      for (const name of CONTROL_NAMES) {
        console.log(`\nrunning positive control ${name}`);
        const result = await runControl(name);
        console.log(`  exit ${result.exitCode}: ${result.failure}`);
        if (
          result.exitCode === 0 ||
          !result.failure.startsWith("FAIL invariant violated")
        ) {
          throw new Error(
            `positive control ${name} did not fail on an invariant (exit ${result.exitCode}: ${result.failure})`,
          );
        }
        controls.push(result);
      }
      const report = renderReport(
        buildReportInput({
          steps,
          controls,
          environment: captureEnvironment(),
          totalMs: Date.now() - startedAt,
          binaryBytes,
          commit: commitHash(),
        }),
      );
      writeFileSync(
        join(import.meta.dir, "..", "README.md"),
        `# m1-living-world: headless causal scenario\n\n${report}\n`,
      );
      console.log("\nwrote tools/scenarios/m1-living-world/README.md");
    }
  } catch (error) {
    killAllSidecars();
    if (error instanceof ScenarioFailure) {
      console.error(`\nFAIL ${error.message}`);
    } else {
      console.error("\nFAIL unexpected error:", error);
    }
    process.exit(1);
  }
}

await main();
