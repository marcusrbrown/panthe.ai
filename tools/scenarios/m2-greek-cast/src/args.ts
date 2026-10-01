// Command-line flags of the M2 scenario runner.

import { CONTROL_NAMES, type ControlName, type StoryOptions } from "./story";

/** The model the real run and the experience gate use unless told otherwise. */
export const DEFAULT_MODEL = "llama3.2-3b-4k";

export interface Args extends StoryOptions {
  readonly real: boolean;
  readonly seconds: number;
  readonly writeReadme: boolean;
  /** Experience-gate episodes to run; 0 when not asked for. */
  readonly episodes: number;
  readonly episodeSeconds: number;
  readonly out: string | undefined;
  /** The Ollama model for the real run and the episodes. */
  readonly model: string;
  /** Set to "none" to ask the model not to reason before answering. */
  readonly reasoningEffort: "none" | undefined;
}

function positiveInt(flag: string, text: string): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive whole number, got ${text}`);
  }
  return value;
}

export function parseArgs(argv: readonly string[]): Args {
  let control: ControlName | undefined;
  let skipBuild = false;
  let real = false;
  let writeReadme = false;
  let seconds = 180;
  let episodes = 0;
  let episodeSeconds = 300;
  let out: string | undefined;
  let model = DEFAULT_MODEL;
  let reasoningEffort: "none" | undefined;
  for (const arg of argv) {
    if (arg === "--skip-build") skipBuild = true;
    else if (arg === "--real") real = true;
    else if (arg === "--write-readme") writeReadme = true;
    else if (arg.startsWith("--seconds=")) seconds = Number(arg.slice(10));
    else if (arg.startsWith("--episodes=")) {
      episodes = positiveInt("--episodes", arg.slice(11));
    } else if (arg.startsWith("--episode-seconds=")) {
      episodeSeconds = positiveInt("--episode-seconds", arg.slice(18));
    } else if (arg.startsWith("--out=")) out = arg.slice(6);
    else if (arg.startsWith("--model=")) {
      model = arg.slice(8);
      if (model === "") throw new Error("--model needs a model name");
    } else if (arg.startsWith("--reasoning-effort=")) {
      if (arg.slice(19) !== "none") {
        throw new Error('--reasoning-effort accepts only "none"');
      }
      reasoningEffort = "none";
    } else if (arg.startsWith("--positive-control=")) {
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
    episodes,
    episodeSeconds,
    out,
    model,
    reasoningEffort,
  };
}
