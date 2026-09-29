// Turns the recorded steps and positive-control runs into the shared
// report harness's input, so every number in the README comes from the run.

import type {
  EnvironmentInfo,
  ReportInput,
} from "@panthea/tools-probes-shared";
import type { StepResult } from "./helpers";

export interface ControlResult {
  readonly name: string;
  /** What the control breaks on purpose, in one sentence. */
  readonly sabotage: string;
  readonly exitCode: number;
  /** The `FAIL` line the control run printed. */
  readonly failure: string;
}

export interface RunSummary {
  readonly steps: readonly StepResult[];
  readonly controls: readonly ControlResult[];
  readonly environment: EnvironmentInfo;
  readonly totalMs: number;
  readonly binaryBytes: number;
  readonly commit: string;
}

const HOW_TO_RUN = `\`\`\`sh
bun run --cwd tools/scenarios scenario:m1                                  # build the sidecar, run the story
bun run --cwd tools/scenarios scenario:m1 --skip-build                     # reuse the built sidecar
bun run --cwd tools/scenarios scenario:m1 --positive-control=archive       # must exit non-zero
bun run --cwd tools/scenarios scenario:m1 --positive-control=catch-up      # must exit non-zero
bun run --cwd tools/scenarios scenario:m1 --write-readme                   # story + both controls, rewrites this file
\`\`\`

The scenario builds the sidecar with \`apps/simulation/scripts/build-sidecar.sh\`
and runs the compiled binary directly, with no Tauri. Each run uses a fresh
temporary app-data directory (\`PANTHEA_APP_DATA_DIR\`), so the authored Greek
world is the seed. The harness writes a launch token to the binary's stdin,
keeps stdin open, reads \`PANTHEA_PORT\` from stdout, and calls the sidecar
over authenticated loopback HTTP. It stops at the first violated invariant,
exits 1, kills every child, and removes its temporary directory. It is not
part of \`bun run check\`; only the pure helpers in \`src/helpers.test.ts\` and
\`src/report.test.ts\` are.

Assertions are about committed world state: the events table and clock row
(read from the store read-only), the decoded frame, and the trace queries.
Waits are bounded polls that name the invariant they wait for, never fixed
sleeps that decide a result. The harness does manipulate wall time and
processes; that is the fault injection, described per step below.

Fault injections, one per negative claim:

- **Machine slept for 50 minutes:** with the sidecar stopped, the harness
  moves the persisted wall cursor back by 3,000,000 ms. The next start sees
  a 50-minute gap and runs startup catch-up.
- **Killed during catch-up:** \`SIGKILL\` once catch-up has committed at
  least two 60-second chunks.
- **Corrupted archive:** one byte inside stored event data is changed in a
  copy of an export.
- **Malformed, false, and stale proposals:** posted from JSON files in
  \`src/fixtures/\`.`;

const NOT_COVERED = `- **Worship and favor.** Not driven. A fixture proposal from the woodcutter or
  the farmer is rejected as \`busy-actor\`: their routines commit an action every
  tick and run ahead of fixtures, and an actor may commit one action per tick.
  Zeus is the only actor without a routine, and a deity cannot worship itself.
  The S7 note measures one such rejection. The same starvation means no fixture
  repair that spends planks can commit; the run asserts the owner's unattended
  repair instead.
- **A strike's presentation receipt through the trace query.** The strike's
  chain is asserted through its projection change; the receipt hop is asserted
  on a routine trade (see the S13 note).
- **The packaged desktop app and the view.** No Tauri, no rendering. The client
  modules run headlessly against a polling transport; the Unit 8 view gate is
  separate.
- **The shell's exact forwarding.** The harness polls \`GET /frame\` every 250 ms
  and forwards a frame when its sequence, status, or session id changes. The
  shell polls once a second.
- **Real sleep, real clock jumps.** The 50-minute gap is a rewritten cursor,
  not a slept machine. Backward clock jumps and gaps over the one-hour cap are
  not driven here.
- **Power loss.** \`SIGKILL\` stops the process; it does not drop unsynced pages.
- **Disk-full and store errors.** No degraded status is provoked.
- **Reject-before-commit for import staging crashes.** Only a corrupted
  archive is injected, not a crash during import.
- **M2 and later.** No model proposals, memory, or generated behaviors; the
  causal chain is the M1 part of O04 only.
- **Balance.** Fire spread, economy, and repair numbers are observed, not
  tuned or asserted beyond the rules in the content files.`;

function kib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MiB`;
}

export function buildReportInput(summary: RunSummary): ReportInput {
  const metrics = summary.steps.flatMap((step) =>
    step.measurements.map((measurement) => ({
      name: `${step.id} ${measurement.name}`,
      unit: measurement.unit,
      samples: [measurement.value],
    })),
  );

  const stepFindings = summary.steps.map(
    (step) =>
      `**${step.id} ${step.title}** (${(step.elapsedMs / 1000).toFixed(1)} s). Asserts: ${step.invariant} Measured: ${step.result}.`,
  );
  const noteFindings = summary.steps.flatMap((step) =>
    step.notes.map((note) => `**${step.id} note.** ${note}`),
  );
  const controlFindings = summary.controls.map(
    (control) =>
      `**Positive control \`${control.name}\`.** ${control.sabotage} The run exited ${control.exitCode} with: ${control.failure}`,
  );

  const allNonZero = summary.controls.every(
    (control) => control.exitCode !== 0,
  );
  const bottomLine = `All ${summary.steps.length} steps held, on a tree built on commit ${summary.commit}. The story ran in ${(summary.steps.reduce((sum, step) => sum + step.elapsedMs, 0) / 1000).toFixed(0)} s; the whole evidence run, with both controls, took ${(summary.totalMs / 1000).toFixed(0)} s. ${
    allNonZero && summary.controls.length > 0
      ? `Both positive controls exited non-zero, so the assertions they target are live. `
      : ""
  }The compiled sidecar binary was ${kib(summary.binaryBytes)}.`;

  return {
    question:
      "Does the compiled sidecar keep a persistent living world causally honest end to end: routines act unattended, a strike becomes fire, lost service, and repair, legends stay attributed records, bad proposals are rejected without effect, pause and a mid-catch-up kill never apply time twice, archives survive corruption and restore into a branch, and a headless client's receipts trace back to the observation that started the chain?",
    howToRun: HOW_TO_RUN,
    caveat: `Not covered:\n\n${NOT_COVERED}`,
    environment: summary.environment,
    metrics,
    findings: [...stepFindings, ...noteFindings, ...controlFindings],
    bottomLine,
  };
}
