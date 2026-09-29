// What every step shares: the run's options and the running story (the
// current sidecar, the headless clients, the data directory). Facts one step
// hands to a later one are not kept here: the step returns them and
// `runStory` passes them on explicitly.

import type { HeadlessClient } from "../client";
import type { StepRecorder } from "../helpers";
import type { Sidecar } from "../sidecar";

export type ControlName =
  | "archive"
  | "catch-up"
  | "journal"
  | "bad-proposals"
  | "claim-owner"
  | "pause"
  | "underworld";

export const CONTROL_NAMES: readonly ControlName[] = [
  "archive",
  "catch-up",
  "journal",
  "bad-proposals",
  "claim-owner",
  "pause",
  "underworld",
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
  sidecar: Sidecar;
  readonly clients: HeadlessClient[];
  /** Starts a new sidecar on the same data directory and points every client at it. */
  restart(): Promise<Sidecar>;
}

export type Recorder = StepRecorder;
