// The M2 causal story, one module per step under `steps/`. Each step asserts
// its invariant through `check`/`waitFor`, which throw a `ScenarioFailure`
// naming it; the first one stops the run. Facts a step hands on are its return
// value, passed explicitly below.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStepRecorder,
  type StepResult,
} from "../../m1-living-world/src/helpers";
import {
  killAllSidecars,
  startSidecar,
} from "../../m1-living-world/src/sidecar";
import { resolveSidecarBinary } from "./binary";
import { startProvider } from "./provider";
import {
  heraPolicy,
  stepHera,
  stepIsolation,
  stepReport,
  stepStrike,
  stepTrace,
} from "./steps/chain";
import type { Story, StoryOptions } from "./steps/context";
import { stepIdle } from "./steps/s01-idle";
import { stepKillJournal } from "./steps/s02-kill-journal";
import { stepKillInference } from "./steps/s03-kill-inference";
import { stepStale } from "./steps/s09-stale";
import { stepCatchUp } from "./steps/s10-catch-up";
import { stepRestore } from "./steps/s11-restore";

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
  const binary = resolveSidecarBinary(options.skipBuild);
  const binaryBytes = Bun.file(binary).size;
  const root = mkdtempSync(join(tmpdir(), "panthea-m2-"));
  const dataDir = join(root, "app-data");
  const provider = startProvider();
  provider.policy("hera", heraPolicy());
  const configPath = join(root, "models.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      endpoints: [
        { id: "scripted", baseUrl: provider.baseUrl, model: "scripted" },
      ],
      roles: { zeus: { endpoint: "scripted" }, hera: { endpoint: "scripted" } },
    }),
  );
  const env = { PANTHEA_MODEL_CONFIG: configPath };
  let story: Story | undefined;
  try {
    const first = await startSidecar(binary, dataDir, { env });
    const running: Story = {
      options,
      binary,
      root,
      dataDir,
      provider,
      sidecar: first,
      async restart() {
        const next = await startSidecar(binary, dataDir, { env });
        running.sidecar = next;
        return next;
      },
    };
    story = running;

    await stepIdle(recorder, running);
    await stepKillJournal(recorder, running);
    await stepKillInference(recorder, running);
    const strike = await stepStrike(recorder, running);
    const { destroyedId } = await stepIsolation(recorder, running, strike);
    const report = await stepReport(recorder, running, strike);
    await stepHera(recorder, running, report);
    await stepTrace(recorder, running, strike, destroyedId);
    await stepStale(recorder, running);
    await stepCatchUp(recorder, running);
    await stepRestore(recorder, running, report);
    return { steps: recorder.results, binaryBytes };
  } finally {
    await story?.sidecar.stop("SIGTERM").catch(() => undefined);
    killAllSidecars();
    provider.stop();
    rmSync(root, { recursive: true, force: true });
  }
}
