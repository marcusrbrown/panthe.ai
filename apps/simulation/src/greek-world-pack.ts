// Statically embeds content/greek/world's four authored JSON files so the
// compiled sidecar needs no filesystem access to load the Greek world: a
// static JSON import is inlined by `bun build --compile` into the
// resulting binary, unlike a runtime `readFileSync` against a path that
// does not exist inside a compiled binary's virtual module root.
//
// Merges the four files the same way packages/content's directory loader
// does, then parses the merged shape through the same `parseContentPack`
// -- so an authoring change to content/greek/world/*.json only needs
// updating here if the merge shape itself ever changes, never a
// duplicated parse path.

import {
  type ContentPack,
  isRecord,
  type ParseResult,
  parseContentPack,
} from "@panthea/contracts";
import buildingsFile from "../../../content/greek/world/buildings.json";
import inhabitantsFile from "../../../content/greek/world/inhabitants.json";
import locationsFile from "../../../content/greek/world/locations.json";
import rulesFile from "../../../content/greek/world/rules.json";

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Parses the embedded Greek pack. Never touches the filesystem. */
export function loadEmbeddedGreekWorldPack(): ParseResult<ContentPack> {
  const locations = asRecord(locationsFile);
  const buildings = asRecord(buildingsFile);
  const inhabitants = asRecord(inhabitantsFile);
  const rules = asRecord(rulesFile);

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
