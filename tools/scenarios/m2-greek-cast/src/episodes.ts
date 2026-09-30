// The experience gate's runner: several fresh worlds, each with Zeus and Hera
// on the local model for the same wall time, each written out as a transcript
// for the owner before its temporary store is deleted, and a summary across
// them. It runs the automated checks and never scores.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../../m1-living-world/src/sidecar";
import { analyzeEpisode, type GodIdentity } from "./episode-analysis";
import { collectRun, prepareOllama, type RealOptions } from "./real";
import {
  type EpisodeRecord,
  renderSummary,
  renderTranscript,
} from "./transcript";

export const GODS = ["zeus", "hera"] as const;

/** Reads each god's identity from its authored profile file. */
export function loadGodIdentities(
  dir: string,
  ids: readonly string[],
): Map<string, GodIdentity> {
  const identities = new Map<string, GodIdentity>();
  for (const id of ids) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
    } catch (error) {
      throw new Error(
        `no profile for ${id} in ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    identities.set(id, {
      id,
      name: String(raw.name),
      domains: raw.domains as string[],
      drives: raw.drives as Record<string, number>,
      abilities: (raw.abilities as { name: string; action: string }[]).map(
        (a) => ({ name: a.name, action: a.action }),
      ),
    });
  }
  return identities;
}

/** `tools/scenarios/m2-greek-cast/episodes/<timestamp>/`, the timestamp safe as a file name. */
export function defaultOutDir(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replaceAll(":", "-");
  return join(REPO_ROOT, "tools/scenarios/m2-greek-cast/episodes", stamp);
}

export interface EpisodesOptions extends RealOptions {
  readonly episodes: number;
  readonly outDir: string;
}

/** Runs the episodes and writes `episode-N.md` for each and `summary.md`. */
export async function runEpisodes(
  options: EpisodesOptions,
): Promise<readonly EpisodeRecord[]> {
  await prepareOllama(options);
  const identities = loadGodIdentities(
    join(REPO_ROOT, "content/greek/gods"),
    GODS,
  );
  mkdirSync(options.outDir, { recursive: true });
  const records: EpisodeRecord[] = [];
  for (let index = 1; index <= options.episodes; index += 1) {
    await collectRun(options, (run) => {
      const record: EpisodeRecord = {
        index,
        total: options.episodes,
        settings: {
          model: options.model,
          seconds: options.durationMs / 1000,
          ranAt: run.record.ranAt,
          ticks: run.record.ticks,
          hardware: run.record.hardware,
        },
        identities: GODS.flatMap((god) => {
          const identity = identities.get(god);
          return identity ? [identity] : [];
        }),
        input: run.input,
        analysis: run.record.analysis,
        episode: analyzeEpisode(run.input, identities, GODS),
      };
      writeFileSync(
        join(options.outDir, `episode-${index}.md`),
        renderTranscript(record),
      );
      records.push(record);
    });
  }
  writeFileSync(
    join(options.outDir, "summary.md"),
    renderSummary(records, {
      seconds: options.durationMs / 1000,
      model: options.model,
      files: records.map((r) => `episode-${r.index}.md`),
    }),
  );
  return records;
}
