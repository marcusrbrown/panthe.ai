// The M1 causal story, one module per step under `steps/`. Each step asserts
// its invariant through `check`/`waitFor`, which throw a `ScenarioFailure`
// naming it; the first one stops the run. Facts a step hands to later ones are
// its return value, passed on explicitly below.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStepRecorder, type StepResult } from "./helpers";
import {
  buildSidecar,
  killAllSidecars,
  sidecarBinaryPath,
  startSidecar,
} from "./sidecar";
import type { Story, StoryOptions } from "./steps/context";
import { stepSeed } from "./steps/s01-seed";
import { stepUnattended } from "./steps/s02-unattended";
import { stepTreeStrike } from "./steps/s03-tree-strike";
import { stepStrike } from "./steps/s04-strike";
import { stepFire } from "./steps/s05-fire";
import { stepLostService } from "./steps/s06-lost-service";
import { stepRepair } from "./steps/s07-repair";
import { stepWorship } from "./steps/s08-worship";
import { stepLegends } from "./steps/s09-legends";
import { stepBadProposals } from "./steps/s10-bad-proposals";
import { stepPauseAcrossRestart } from "./steps/s11-pause-across-restart";
import { stepJournalKill } from "./steps/s12-journal-kill";
import { stepKillMidCatchUp } from "./steps/s13-kill-mid-catch-up";
import { stepArchives } from "./steps/s14-archives";
import { stepClientReceipts } from "./steps/s15-client-receipts";
import { stepTrace } from "./steps/s16-trace";

export {
  CONTROL_NAMES,
  type ControlName,
  type StoryOptions,
} from "./steps/context";

export interface StoryResult {
  readonly steps: readonly StepResult[];
  readonly binaryBytes: number;
}

export async function runStory(
  options: StoryOptions,
  onStep: (step: StepResult) => void,
): Promise<StoryResult> {
  const recorder = createStepRecorder(onStep);
  const binary = options.skipBuild ? sidecarBinaryPath() : buildSidecar();
  const binaryBytes = Bun.file(binary).size;
  const root = mkdtempSync(join(tmpdir(), "panthea-m1-"));
  const dataDir = join(root, "app-data");
  // Everything from here on is cleaned up by the `finally`, including a
  // first sidecar that fails to start.
  let story: Story | undefined;
  try {
    const first = await startSidecar(binary, dataDir);
    const running: Story = {
      options,
      binary,
      root,
      dataDir,
      sidecar: first,
      clients: [],
      async restart() {
        const next = await startSidecar(binary, dataDir);
        running.sidecar = next;
        for (const client of running.clients) client.attach(next);
        return next;
      },
    };
    story = running;

    await stepSeed(recorder, running);
    await stepUnattended(recorder, running);
    const oak = await stepTreeStrike(recorder, running);
    const strike = await stepStrike(recorder, running);
    await stepFire(recorder, running, strike);
    await stepLostService(recorder, running, strike);
    await stepRepair(recorder, running);
    const worship = await stepWorship(recorder, running);
    await stepLegends(recorder, running, strike);
    const bad = await stepBadProposals(recorder, running, oak);
    await stepPauseAcrossRestart(recorder, running);
    await stepJournalKill(recorder, running);
    await stepKillMidCatchUp(recorder, running);
    await stepArchives(recorder, running);
    await stepClientReceipts(recorder, running, { oak, strike, worship });
    await stepTrace(recorder, running, { strike, worship, bad });
    return { steps: recorder.results, binaryBytes };
  } finally {
    for (const client of story?.clients ?? []) client.stop();
    await story?.sidecar.stop("SIGTERM").catch(() => undefined);
    killAllSidecars();
    rmSync(root, { recursive: true, force: true });
  }
}
