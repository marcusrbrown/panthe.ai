// What every step shares: the run's options and the running story (the current
// sidecar, the scripted provider, the data directory). Facts one step hands to a
// later one are its return value, passed on explicitly by `runStory`.

import type { StepRecorder } from "../../../m1-living-world/src/helpers";
import type { Sidecar } from "../../../m1-living-world/src/sidecar";
import type { ScriptedProvider } from "../provider";

export type ControlName =
  | "kill-journal"
  | "kill-inference"
  | "chain"
  | "isolation"
  | "trace"
  | "stale"
  | "catch-up-inference"
  | "restore-memory";

export const CONTROL_NAMES: readonly ControlName[] = [
  "kill-journal",
  "kill-inference",
  "chain",
  "isolation",
  "trace",
  "stale",
  "catch-up-inference",
  "restore-memory",
];

export interface StoryOptions {
  readonly control?: ControlName;
  readonly skipBuild: boolean;
}

export interface Story {
  readonly options: StoryOptions;
  readonly binary: string;
  readonly root: string;
  readonly dataDir: string;
  readonly provider: ScriptedProvider;
  sidecar: Sidecar;
  /** Starts a new sidecar on the same data directory, with the same model config. */
  restart(): Promise<Sidecar>;
}

export type Recorder = StepRecorder;
