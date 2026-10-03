// The motif catalogue (content/greek/lore/motifs.json): the sourced Greek
// story-shapes a thread's ending can draw on (R17). Each motif cites its
// sources, notes where accounts differ, labels what is late Roman or a game
// invention, and names the one bounded change the world makes for it. Motifs
// are possible endings, never plots: nothing here schedules anything.
//
// The world's rules own what a motif does (`PRACTICE_MOTIF_CHANGES` in
// packages/contracts) the way a god's ability names a world action: this file
// documents and bounds it, grants nothing, and is checked against the world's
// list in both directions, so a motif the world can apply but the lore never
// sourced fails the parse, and so does a motif the lore invents that the world
// cannot apply.

import {
  fail,
  isRecord,
  ok,
  type ParseResult,
  PRACTICE_BALANCE_KEYS,
  PRACTICE_MOTIF_CHANGES,
  PRACTICE_MOTIFS,
  type PracticeMotif,
  type PracticeMotifChange,
  parseArray,
  parseEnum,
  parseSchemaVersion,
  parseString,
} from "@panthea/contracts";
import {
  type Citation,
  checkUniqueIds,
  type GodInvention,
  type GodSource,
  type GodVariant,
  parseCitations,
  parseInvention,
  parseNonEmptyArray,
  parseOptionalArray,
  parseSource,
  parseVariant,
} from "./god-profile";

export const MOTIF_CATALOGUE_SCHEMA_VERSIONS = [1] as const;

/** What a motif's account is not plain classical lore: a late Roman telling, or a game invention. */
export const MOTIF_LABELS = ["late-roman", "game-invention"] as const;
export type MotifLabel = (typeof MOTIF_LABELS)[number];

/** A source, labeled `late-roman` when it is Ovid or another Roman retelling, so a motif that leans on it says so. */
export interface MotifSource extends GodSource {
  readonly label?: "late-roman";
}

/** The one bounded change a motif applies: what it does, and the practice tunables that bound it. */
export interface MotifChange {
  readonly kind: PracticeMotifChange;
  readonly description: string;
  readonly tunables: readonly string[];
}

export interface Motif {
  readonly id: PracticeMotif;
  readonly name: string;
  /** A paraphrase of the story-shape, not a quotation. */
  readonly summary: string;
  readonly cites: readonly Citation[];
  readonly variants: readonly GodVariant[];
  readonly inventions: readonly GodInvention[];
  readonly labels: readonly MotifLabel[];
  readonly change: MotifChange;
}

/** A motif the game does not apply, and why: kept so its absence is a decision on record. */
export interface OmittedMotif {
  readonly id: string;
  readonly reason: string;
}

export interface MotifCatalogue {
  readonly schemaVersion: number;
  readonly sources: readonly MotifSource[];
  readonly motifs: readonly Motif[];
  readonly omitted: readonly OmittedMotif[];
}

function parseMotifSource(
  value: unknown,
  path: string,
): ParseResult<MotifSource> {
  const source = parseSource(value, path);
  if (!source.ok) return source;
  const label = (value as Record<string, unknown>).label;
  if (label === undefined) return source;
  if (label !== "late-roman") {
    return fail(`${path}.label`, 'expected "late-roman" or nothing');
  }
  return ok({ ...source.value, label });
}

function parseChange(value: unknown, path: string): ParseResult<MotifChange> {
  if (!isRecord(value)) return fail(path, "expected a change object");
  const kind = parseEnum(value.kind, `${path}.kind`, [
    ...new Set(Object.values(PRACTICE_MOTIF_CHANGES)),
  ] as readonly PracticeMotifChange[]);
  if (!kind.ok) return kind;
  const description = parseString(value.description, `${path}.description`);
  if (!description.ok) return description;
  const tunables = parseOptionalArray(
    value.tunables,
    `${path}.tunables`,
    (item, at) => {
      const name = parseEnum(item, at, PRACTICE_BALANCE_KEYS);
      return name;
    },
  );
  if (!tunables.ok) return tunables;
  return ok({
    kind: kind.value,
    description: description.value,
    tunables: tunables.value,
  });
}

function parseLabels(
  value: unknown,
  path: string,
): ParseResult<readonly MotifLabel[]> {
  const labels = parseOptionalArray(value, path, (item, at) =>
    parseEnum(item, at, MOTIF_LABELS),
  );
  if (!labels.ok) return labels;
  if (new Set(labels.value).size !== labels.value.length) {
    return fail(path, "a label appears once");
  }
  return labels;
}

function parseMotif(
  sourceIds: ReadonlySet<string>,
  lateSourceIds: ReadonlySet<string>,
): (value: unknown, path: string) => ParseResult<Motif> {
  return (value, path) => {
    if (!isRecord(value)) return fail(path, "expected a motif entry");
    const id = parseEnum(value.id, `${path}.id`, PRACTICE_MOTIFS);
    if (!id.ok) return id;
    const name = parseString(value.name, `${path}.name`);
    if (!name.ok) return name;
    const summary = parseString(value.summary, `${path}.summary`);
    if (!summary.ok) return summary;
    const cites = parseCitations(value.cites, `${path}.cites`, sourceIds);
    if (!cites.ok) return cites;
    const variants = parseOptionalArray(
      value.variants,
      `${path}.variants`,
      parseVariant(sourceIds),
    );
    if (!variants.ok) return variants;
    const inventions = parseOptionalArray(
      value.inventions,
      `${path}.inventions`,
      parseInvention,
    );
    if (!inventions.ok) return inventions;
    const labels = parseLabels(value.labels, `${path}.labels`);
    if (!labels.ok) return labels;
    const change = parseChange(value.change, `${path}.change`);
    if (!change.ok) return change;

    if (change.value.kind !== PRACTICE_MOTIF_CHANGES[id.value]) {
      return fail(
        `${path}.change.kind`,
        `the world applies ${id.value} as ${PRACTICE_MOTIF_CHANGES[id.value]}, not ${change.value.kind}`,
      );
    }
    // A label says what the account leans on: nothing more, and nothing less.
    const leansOnLate = [
      ...cites.value,
      ...variants.value.flatMap((v) => v.cites),
    ].some((cite) => lateSourceIds.has(cite.source));
    if (leansOnLate !== labels.value.includes("late-roman")) {
      return fail(
        `${path}.labels`,
        leansOnLate
          ? "a motif citing a late Roman source is labeled late-roman"
          : "late-roman labels a motif that cites a late Roman source",
      );
    }
    if (
      inventions.value.length > 0 !==
      labels.value.includes("game-invention")
    ) {
      return fail(
        `${path}.labels`,
        inventions.value.length > 0
          ? "a motif with a game invention is labeled game-invention"
          : "game-invention labels a motif that lists an invention",
      );
    }
    const unique = checkUniqueIds(
      [...variants.value, ...inventions.value],
      path,
      "variant or invention",
    );
    if (!unique.ok) return unique;
    return ok({
      id: id.value,
      name: name.value,
      summary: summary.value,
      cites: cites.value,
      variants: variants.value,
      inventions: inventions.value,
      labels: labels.value,
      change: change.value,
    });
  };
}

function parseOmitted(value: unknown, path: string): ParseResult<OmittedMotif> {
  if (!isRecord(value)) return fail(path, "expected an omitted entry");
  const id = parseString(value.id, `${path}.id`);
  if (!id.ok) return id;
  const reason = parseString(value.reason, `${path}.reason`);
  if (!reason.ok) return reason;
  return ok({ id: id.value, reason: reason.value });
}

/**
 * Parses the catalogue: every motif cites at least one declared source, its
 * labels match what it leans on, its change is the one the world applies, and
 * the motifs are exactly the world's list, each once, none also omitted.
 */
export function parseMotifCatalogue(
  input: unknown,
  path = "motifs",
): ParseResult<MotifCatalogue> {
  if (!isRecord(input)) return fail(path, "expected a motif catalogue object");
  const schemaVersion = parseSchemaVersion(
    input.schemaVersion,
    MOTIF_CATALOGUE_SCHEMA_VERSIONS,
    `${path}.schemaVersion`,
  );
  if (!schemaVersion.ok) return schemaVersion;
  const sources = parseNonEmptyArray(
    input.sources,
    `${path}.sources`,
    parseMotifSource,
  );
  if (!sources.ok) return sources;
  const sourceIds = new Set(sources.value.map((source) => source.id));
  const lateSourceIds = new Set(
    sources.value
      .filter((source) => source.label === "late-roman")
      .map((source) => source.id),
  );
  const motifs = parseArray(
    input.motifs,
    `${path}.motifs`,
    parseMotif(sourceIds, lateSourceIds),
  );
  if (!motifs.ok) return motifs;
  const omitted = parseArray(input.omitted, `${path}.omitted`, parseOmitted);
  if (!omitted.ok) return omitted;

  for (const [items, key, what] of [
    [sources.value, "sources", "source"],
    [motifs.value, "motifs", "motif"],
    [omitted.value, "omitted", "omitted motif"],
  ] as const) {
    const unique = checkUniqueIds(items, `${path}.${key}`, what);
    if (!unique.ok) return unique;
  }
  const catalogued = new Set<string>(motifs.value.map((motif) => motif.id));
  for (const id of PRACTICE_MOTIFS) {
    if (!catalogued.has(id)) {
      return fail(
        `${path}.motifs`,
        `the world can apply ${id}, so the catalogue must source it`,
      );
    }
  }
  for (const [index, entry] of omitted.value.entries()) {
    if (catalogued.has(entry.id)) {
      return fail(
        `${path}.omitted[${index}].id`,
        `${entry.id} is catalogued, so it is not omitted`,
      );
    }
  }
  return ok({
    schemaVersion: schemaVersion.value,
    sources: sources.value,
    motifs: motifs.value,
    omitted: omitted.value,
  });
}
