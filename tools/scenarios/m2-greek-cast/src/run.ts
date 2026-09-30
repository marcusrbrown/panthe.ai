// Headless M2 scenario: the compiled sidecar with the gods taking turns
// through a scripted provider. Exits non-zero on the first violated invariant.
// Not part of `bun run check`: it spawns a binary and runs for minutes.
//
//   bun run scenario:m2                              run the scripted story
//   bun run scenario:m2 --skip-build                 reuse the existing sidecar binary
//   bun run scenario:m2 --positive-control=<name>    break one check on purpose; must fail
//   bun run scenario:m2 --write-readme               run the story and every control, rewrite README.md (uses real-run.json)
//   bun run scenario:m2 --real [--seconds=N]         both gods through local Ollama, unscripted; asserts properties, writes real-run.json
//                                                    (rebuilds the sidecar first, unless --skip-build)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureEnvironment, renderReport } from "@panthea/tools-probes-shared";
import { ScenarioFailure } from "../../m1-living-world/src/helpers";
import { killAllSidecars } from "../../m1-living-world/src/sidecar";
import { resolveSidecarBinary } from "./binary";
import { OllamaUnreachable, type RealRecord, runReal } from "./real";
import { buildReportInput, type ControlResult } from "./report";
import {
  CONTROL_NAMES,
  type ControlName,
  runStory,
  type StoryOptions,
} from "./story";

interface Args extends StoryOptions {
  readonly real: boolean;
  readonly seconds: number;
  readonly writeReadme: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let control: ControlName | undefined;
  let skipBuild = false;
  let real = false;
  let writeReadme = false;
  let seconds = 180;
  for (const arg of argv) {
    if (arg === "--skip-build") skipBuild = true;
    else if (arg === "--real") real = true;
    else if (arg === "--write-readme") writeReadme = true;
    else if (arg.startsWith("--seconds=")) seconds = Number(arg.slice(10));
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
  return {
    ...(control ? { control } : {}),
    skipBuild,
    real,
    seconds,
    writeReadme,
  };
}

const CONTROL_SABOTAGE: Readonly<Record<ControlName, string>> = {
  "kill-journal":
    "After the kill, the harness deletes the pending proposal from the journal, as if the service had kept a turn's proposal only in memory, so nothing runs it after the restart.",
  "kill-inference":
    "The provider answers the re-asked turn with two legends instead of one, so two proposals commit where exactly one is required.",
  chain:
    "Zeus's report carries no claim, so Hera's belief has no consequence and her relationship toward Zeus does not change.",
  isolation:
    "The harness adds the strike's ignition to the last prompt Hera was shown before the check, as if the event had leaked into her context.",
  trace:
    "The harness follows the farmer's fixture move instead of the tavern's destruction, an event no strike caused, so the chain has no model request.",
  stale:
    "The harness skips the fixture that moves Hera while her turn is in flight, so the world is unchanged and the proposal commits instead of being rejected.",
  "catch-up-inference":
    "The harness sends the provider a request inside the restart's catch-up window, as a god's turn would.",
  "restore-memory":
    "The harness drops Hera's memory and feeling from the export it is about to restore and recomputes its hash. Import rebuilds the world from the archive's event log and requires it to equal the archived projection, so the archive is refused at the import step, before any comparison of the restored branch.",
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
    { stdout: "pipe", stderr: "pipe" },
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

async function runRealRun(args: Args): Promise<void> {
  const record = await runReal({
    binary: resolveSidecarBinary(args.skipBuild),
    durationMs: args.seconds * 1000,
    ollama: "http://127.0.0.1:11434",
    model: "llama3.2-3b-4k",
  });
  writeFileSync(
    join(import.meta.dir, "..", "real-run.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  console.log(JSON.stringify(record.analysis, null, 2));
  for (const property of record.analysis.properties) {
    console.log(
      `${property.ok ? "PASS" : "FAIL"} ${property.name}: ${property.detail}`,
    );
  }
  if (record.analysis.properties.some((property) => !property.ok)) {
    console.error(
      "\nFAIL invariant violated: a real-run property did not hold (see above)",
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const startedAt = Date.now();
  process.on("SIGINT", () => {
    killAllSidecars();
    process.exit(130);
  });
  try {
    if (args.real) {
      await runRealRun(args);
      return;
    }
    const { steps, binaryBytes } = await runStory(args, (step) => {
      console.log(
        `PASS ${step.id} ${step.title} (${(step.elapsedMs / 1000).toFixed(1)} s): ${step.result}`,
      );
    });
    console.log(
      `\nOK ${steps.length} steps in ${((Date.now() - startedAt) / 1000).toFixed(1)} s`,
    );
    if (args.control) {
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
      const realPath = join(import.meta.dir, "..", "real-run.json");
      const real = existsSync(realPath)
        ? (JSON.parse(readFileSync(realPath, "utf8")) as RealRecord)
        : undefined;
      const report = renderReport(
        buildReportInput({
          steps,
          controls,
          environment: captureEnvironment(),
          totalMs: Date.now() - startedAt,
          binaryBytes,
          real,
        }),
      );
      writeFileSync(
        join(import.meta.dir, "..", "README.md"),
        `# m2-greek-cast: the M2 causal story against the compiled sidecar\n\n${report}\n`,
      );
      console.log("\nwrote tools/scenarios/m2-greek-cast/README.md");
    }
  } catch (error) {
    killAllSidecars();
    if (error instanceof ScenarioFailure) {
      console.error(`\nFAIL ${error.message}`);
    } else if (error instanceof OllamaUnreachable) {
      console.error(`\nFAIL ${error.message}`);
    } else {
      console.error("\nFAIL unexpected error:", error);
    }
    process.exit(1);
  }
}

await main();
