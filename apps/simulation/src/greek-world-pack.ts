// Statically embeds content/greek/world's four authored JSON files and the
// god profiles under content/greek/gods so the compiled sidecar needs no
// filesystem access to load the Greek world: a static JSON import is
// inlined by `bun build --compile` into the resulting binary, unlike a
// runtime `readFileSync` against a path that does not exist inside a
// compiled binary's virtual module root.
//
// Merges the four world files the same way packages/content's directory
// loader does, then parses the merged shape through the same
// `parseContentPack` -- so an authoring change to
// content/greek/world/*.json only needs updating here if the merge shape
// itself ever changes, never a duplicated parse path. God profiles go
// through the same `parseGodProfiles` the directory loader uses; a new god
// file needs one import and one list entry here.

import {
  type GodProfile,
  type LabeledProfileInput,
  parseGodProfiles,
} from "@panthea/content";
import {
  type ContentPack,
  isRecord,
  type ParseResult,
  parseContentPack,
} from "@panthea/contracts";
import heraFile from "../../../content/greek/gods/hera.json";
import zeusFile from "../../../content/greek/gods/zeus.json";
import buildingsFile from "../../../content/greek/world/buildings.json";
import inhabitantsFile from "../../../content/greek/world/inhabitants.json";
import locationsFile from "../../../content/greek/world/locations.json";
import rulesFile from "../../../content/greek/world/rules.json";

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * The authored rules, with the petition tunables overridden by
 * `env.PANTHEA_PETITION_BALANCE` (a JSON object of tunable names to numbers)
 * when set. The result goes through the same strict parser as authored content,
 * so an unknown name or an invalid value refuses the pack.
 */
function rulesWithOverrides(
  rules: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  const raw = env.PANTHEA_PETITION_BALANCE;
  if (!raw) return rules;
  let overrides: unknown;
  try {
    overrides = JSON.parse(raw);
  } catch {
    return {
      ...rules,
      rules: { ...asRecord(rules.rules), petitionBalance: raw },
    };
  }
  const authored = asRecord(asRecord(rules.rules).petitionBalance);
  return {
    ...rules,
    rules: {
      ...asRecord(rules.rules),
      petitionBalance: isRecord(overrides)
        ? { ...authored, ...overrides }
        : overrides,
    },
  };
}

/** Parses the embedded Greek pack. Never touches the filesystem. */
export function loadEmbeddedGreekWorldPack(
  env: NodeJS.ProcessEnv = process.env,
): ParseResult<ContentPack> {
  const locations = asRecord(locationsFile);
  const buildings = asRecord(buildingsFile);
  const inhabitants = asRecord(inhabitantsFile);
  const rules = rulesWithOverrides(asRecord(rulesFile), env);

  const merged = {
    schemaVersion: locations.schemaVersion,
    realms: locations.realms,
    resources: rules.resources,
    locations: locations.locations,
    buildings: buildings.buildings ?? [],
    inhabitants: inhabitants.inhabitants ?? [],
    rules: rules.rules,
    recipes: rules.recipes ?? {},
  };

  return parseContentPack(merged);
}

export const EMBEDDED_GOD_PROFILE_FILES: readonly LabeledProfileInput[] = [
  { label: "hera.json", value: heraFile },
  { label: "zeus.json", value: zeusFile },
];

/**
 * Parses the embedded god profiles (or `files`, so a test can inject a bad
 * one) against `pack`. Never touches the filesystem.
 */
export function loadEmbeddedGreekGodProfiles(
  pack: ContentPack,
  files: readonly LabeledProfileInput[] = EMBEDDED_GOD_PROFILE_FILES,
): ParseResult<readonly GodProfile[]> {
  return parseGodProfiles(files, pack.inhabitants);
}
