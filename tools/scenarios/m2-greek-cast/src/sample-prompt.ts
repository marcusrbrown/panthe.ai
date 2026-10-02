// One god turn, as the model was shown it, saved beside each gate episode: the
// prompt and the model's answer as the trace holds them, the practice
// sections pulled out of the prompt so they can be read at a glance, and the
// god's intent schema. What the trace keeps is already redacted at its write
// boundary; the harness redacts again with every key it holds before anything
// reaches the episode directory, since that directory is committed or shared.
//
// The trace keeps no schema, so the schema is the one the god's intent schema
// builder gives for the end-of-run world, and is labelled that way.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  godIntentSchema,
  PRACTICES_HEADING,
  PRAYERS_HEADING,
  rememberedBy,
} from "@panthea/agents";
import { loadContentPack, loadGodProfiles } from "@panthea/content";
import { createRedactor } from "@panthea/telemetry";
import { perceive, toEntityId, type WorldState } from "@panthea/world";
import { REPO_ROOT } from "../../m1-living-world/src/sidecar";
import { readProjectedState, readSampleRows, type SampleRow } from "./db";

export interface SampleSource {
  readonly rows: readonly SampleRow[];
  /** The god's intent schema for the world as it ended, or `undefined` when it cannot be drawn. */
  readonly schemaFor: (god: string) => unknown | undefined;
}

/** Reads what a sample needs from a stopped run's store. */
export function readSampleSource(path: string): SampleSource {
  const rows = readSampleRows(path);
  let state: WorldState | undefined;
  let profiles: ReturnType<typeof loadGodProfiles> | undefined;
  try {
    state = readProjectedState(path);
    const greek = join(REPO_ROOT, "content/greek");
    const pack = loadContentPack(join(greek, "world"));
    profiles = pack.ok
      ? loadGodProfiles(join(greek, "gods"), pack.value)
      : undefined;
  } catch {
    state = undefined;
  }
  return {
    rows,
    schemaFor(god) {
      if (state === undefined || profiles === undefined || !profiles.ok) {
        return undefined;
      }
      const profile = profiles.value.find((entry) => entry.id === god);
      const snapshot = perceive(state, toEntityId(god), []);
      if (profile === undefined || snapshot === undefined) return undefined;
      return godIntentSchema(
        profile,
        snapshot,
        rememberedBy(state, toEntityId(god)),
      ).jsonSchema;
    },
  };
}

/** Which turn is the sample, and why: the first whose prompt carried a practices section (the one that shows what the god was invited to), else the last answered turn. */
export function chooseSample(
  rows: readonly SampleRow[],
): { row: SampleRow; position: number; why: string } | undefined {
  const answered = rows
    .map((row, position) => ({ row, position }))
    .filter(({ row }) => row.promptPayload !== undefined);
  const withPractices = answered.find(({ row }) =>
    row.promptPayload?.split("\n").includes(PRACTICES_HEADING),
  );
  if (withPractices !== undefined) {
    return {
      ...withPractices,
      why: `the first prompt with a "${PRACTICES_HEADING}" section`,
    };
  }
  const last = answered.at(-1);
  return last === undefined
    ? undefined
    : {
        ...last,
        why: `the last prompt (none carried a "${PRACTICES_HEADING}" section)`,
      };
}

/** A section of a prompt: its heading and the dashed and indented lines under it. */
function sectionOf(prompt: string, heading: string): string {
  const lines = prompt.split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) return `(no "${heading}" section in this prompt)`;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => !l.startsWith("- ") && !l.startsWith("  "));
  return [heading, ...rest.slice(0, end < 0 ? rest.length : end)].join("\n");
}

/** The sample as a document; `secrets` are every key the run held. */
export function renderSamplePrompt(
  source: SampleSource,
  episode: { readonly index: number; readonly total: number },
  secrets: readonly string[],
): string {
  const redact = createRedactor(secrets);
  const chosen = chooseSample(source.rows);
  if (chosen === undefined) {
    return `# Episode ${episode.index} of ${episode.total}: no sample\n\nNo model request recorded a prompt.\n`;
  }
  const { row, position, why } = chosen;
  const prompt = row.promptPayload ?? "";
  const schema = source.schemaFor(row.role);
  const steps = row.steps
    .map((step) => step.mode ?? step.reason ?? "?")
    .join(", ");
  const document = [
    `# Episode ${episode.index} of ${episode.total}: one ${row.role} turn as the model saw it`,
    "",
    `- Request ${position + 1} of ${source.rows.length}, chosen as ${why}.`,
    `- Outcome: ${row.outcome}; ${Math.round(row.elapsedMs)} ms; route: ${steps || "none"}.`,
    `- Prompt: ${prompt.length} characters (instructions, then the scene), exactly as the trace holds it.`,
    "",
    "## The practices section",
    "",
    "```text",
    sectionOf(prompt, PRACTICES_HEADING),
    "```",
    "",
    "## The prayers section",
    "",
    "```text",
    sectionOf(prompt, PRAYERS_HEADING),
    "```",
    "",
    "## Model output",
    "",
    "```json",
    row.outputPayload ?? "(none: no endpoint gave a valid intent)",
    "```",
    "",
    `## The intent schema (as of the end of the run: the trace keeps no schema)`,
    "",
    "```json",
    schema === undefined
      ? "(could not be drawn)"
      : JSON.stringify(schema, null, 2),
    "```",
    "",
    "## The whole prompt",
    "",
    "```text",
    prompt,
    "```",
    "",
  ].join("\n");
  return redact(document);
}

/** Writes `episode-N-sample-prompt.md` into `dir`. */
export function writeSamplePrompt(
  dir: string,
  source: SampleSource,
  episode: { readonly index: number; readonly total: number },
  secrets: readonly string[],
): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `episode-${episode.index}-sample-prompt.md`);
  writeFileSync(file, renderSamplePrompt(source, episode, secrets));
  return file;
}
