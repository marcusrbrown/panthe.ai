// Loads an authored content pack from disk and parses it through
// packages/contracts' `parseContentPack`. Invalid content fails loudly with
// a clear, structured message (Unit 3's "Content loads through contracts
// parsers; invalid content fails loudly at startup") -- a missing required
// file, malformed JSON syntax, and a structurally invalid pack are each
// reported distinctly.
//
// Authored packs split geography from balance/economy across two required
// files (`locations.json`, `rules.json`) plus two files a later unit may add
// (`buildings.json`, `inhabitants.json`): Unit 3 authors no buildings or
// inhabitants, so those two are optional here and default to an empty list
// when absent. When Unit 4 adds them, this loader picks them up with no
// change required.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ContentPack,
  fail,
  isRecord,
  ok,
  type ParseResult,
  parseContentPack,
} from "@panthea/contracts";

function readJsonFile(path: string, label: string): ParseResult<unknown> {
  if (!existsSync(path)) {
    return fail(label, `required content file is missing: ${path}`);
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return fail(label, `could not read ${path}: ${String(error)}`);
  }
  try {
    return ok(JSON.parse(text));
  } catch (error) {
    return fail(label, `${path} is not valid JSON: ${String(error)}`);
  }
}

function readOptionalJsonFile(
  path: string,
  label: string,
): ParseResult<unknown | undefined> {
  if (!existsSync(path)) {
    return ok(undefined);
  }
  return readJsonFile(path, label);
}

/**
 * Loads and parses the content pack authored under `baseDir` (e.g.
 * `content/greek/world`). `locations.json` and `rules.json` must exist;
 * `buildings.json` and `inhabitants.json` are read if present and default
 * to an empty list otherwise.
 */
export function loadContentPack(baseDir: string): ParseResult<ContentPack> {
  const locationsResult = readJsonFile(
    join(baseDir, "locations.json"),
    "locations.json",
  );
  if (!locationsResult.ok) return locationsResult;
  const locationsRaw = locationsResult.value;
  if (!isRecord(locationsRaw)) {
    return fail("locations.json", "expected a JSON object at the top level");
  }

  const rulesResult = readJsonFile(join(baseDir, "rules.json"), "rules.json");
  if (!rulesResult.ok) return rulesResult;
  const rulesRaw = rulesResult.value;
  if (!isRecord(rulesRaw)) {
    return fail("rules.json", "expected a JSON object at the top level");
  }

  const buildingsResult = readOptionalJsonFile(
    join(baseDir, "buildings.json"),
    "buildings.json",
  );
  if (!buildingsResult.ok) return buildingsResult;
  const buildingsRaw = buildingsResult.value;
  if (buildingsRaw !== undefined && !isRecord(buildingsRaw)) {
    return fail("buildings.json", "expected a JSON object at the top level");
  }

  const inhabitantsResult = readOptionalJsonFile(
    join(baseDir, "inhabitants.json"),
    "inhabitants.json",
  );
  if (!inhabitantsResult.ok) return inhabitantsResult;
  const inhabitantsRaw = inhabitantsResult.value;
  if (inhabitantsRaw !== undefined && !isRecord(inhabitantsRaw)) {
    return fail("inhabitants.json", "expected a JSON object at the top level");
  }

  const merged = {
    schemaVersion: locationsRaw.schemaVersion,
    realms: locationsRaw.realms,
    resources: rulesRaw.resources,
    locations: locationsRaw.locations,
    buildings: buildingsRaw?.buildings ?? [],
    inhabitants: inhabitantsRaw?.inhabitants ?? [],
    rules: rulesRaw.rules,
  };

  return parseContentPack(merged);
}
