import { expect, test } from "bun:test";
import { join } from "node:path";
import { PRACTICE_MOTIFS } from "@panthea/contracts";
import { loadMotifCatalogue } from "./load";
import { parseMotifCatalogue } from "./motifs";

const MOTIFS_FILE = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "content",
  "greek",
  "lore",
  "motifs.json",
);

// A test edits parsed JSON freely, one broken rule at a time.
// biome-ignore lint/suspicious/noExplicitAny: untyped JSON under edit
type Loose = Record<string, any>;

/** The real catalogue as a mutable record, so a test breaks one rule at a time. */
function authored(): Loose {
  const loaded = loadMotifCatalogue(MOTIFS_FILE);
  if (!loaded.ok) throw new Error(loaded.message);
  return JSON.parse(JSON.stringify(loaded.value));
}

function motif(catalogue: Loose, id: string) {
  return catalogue.motifs.find((m: { id: string }) => m.id === id);
}

test("the authored catalogue parses, and gives every motif the world can apply its sources, labels, and bounded change (R17)", () => {
  const loaded = loadMotifCatalogue(MOTIFS_FILE);
  if (!loaded.ok) throw new Error(loaded.message);
  expect(loaded.value.motifs.map((m) => m.id).sort()).toEqual(
    [...PRACTICE_MOTIFS].sort(),
  );
  for (const m of loaded.value.motifs) {
    expect(m.cites.length).toBeGreaterThan(0);
    expect(m.change.description.length).toBeGreaterThan(0);
  }
  // The Styx oath is Hesiod's.
  const oath = loaded.value.motifs.find((m) => m.id === "oath-penalty");
  expect(oath?.cites.map((c) => c.source)).toContain("theogony");
  expect(oath?.labels).toContain("game-invention");
  // Ovid's transformations are labeled late Roman.
  const mercy = loaded.value.motifs.find(
    (m) => m.id === "transformation-mercy",
  );
  expect(mercy?.labels).toContain("late-roman");
  // The curse is omitted with its reason, never silently dropped.
  expect(loaded.value.omitted.map((o) => o.id)).toEqual(["curse"]);
});

test("a motif without sources fails to parse", () => {
  for (const cites of [undefined, []]) {
    const catalogue = authored();
    motif(catalogue, "boon").cites = cites;
    const parsed = parseMotifCatalogue(catalogue);
    expect(parsed.ok).toBe(false);
  }
  // A citation to a source the catalogue never declared is as good as none.
  const unknown = authored();
  motif(unknown, "boon").cites = [{ source: "pliny", locator: "1.1" }];
  expect(parseMotifCatalogue(unknown).ok).toBe(false);
});

test("a late Roman source labels its motif, and a game invention is labeled, never passed off as lore", () => {
  const unlabeled = authored();
  motif(unlabeled, "transformation-mercy").labels = ["game-invention"];
  expect(parseMotifCatalogue(unlabeled).ok).toBe(false);

  const noInventionLabel = authored();
  motif(noInventionLabel, "oath-penalty").labels = [];
  expect(parseMotifCatalogue(noInventionLabel).ok).toBe(false);

  const mislabeled = authored();
  motif(mislabeled, "boon").labels = ["late-roman", "game-invention"];
  expect(parseMotifCatalogue(mislabeled).ok).toBe(false);

  const cited = authored();
  motif(cited, "oath-penalty").inventions[0].cites = [
    { source: "theogony", locator: "775-806" },
  ];
  expect(parseMotifCatalogue(cited).ok).toBe(false);

  const unknownLabel = authored();
  motif(unknownLabel, "boon").labels = ["sourced"];
  expect(parseMotifCatalogue(unknownLabel).ok).toBe(false);
});

test("the catalogue and the world agree: every motif the world can apply is catalogued once, with the change the world makes", () => {
  const missing = authored();
  missing.motifs = missing.motifs.filter(
    (m: { id: string }) => m.id !== "oath-penalty",
  );
  expect(parseMotifCatalogue(missing).ok).toBe(false);

  const duplicate = authored();
  duplicate.motifs.push(JSON.parse(JSON.stringify(motif(duplicate, "boon"))));
  expect(parseMotifCatalogue(duplicate).ok).toBe(false);

  const unknown = authored();
  motif(unknown, "boon").id = "wrath";
  expect(parseMotifCatalogue(unknown).ok).toBe(false);

  const wrongChange = authored();
  motif(wrongChange, "oath-penalty").change.kind = "transformation";
  expect(parseMotifCatalogue(wrongChange).ok).toBe(false);

  const typo = authored();
  motif(typo, "oath-penalty").change.tunables = ["oathDivinityLos"];
  expect(parseMotifCatalogue(typo).ok).toBe(false);

  const omittedAndCatalogued = authored();
  omittedAndCatalogued.omitted.push({ id: "boon", reason: "no" });
  expect(parseMotifCatalogue(omittedAndCatalogued).ok).toBe(false);
});

test("each motif names the practice tunables that bound it, and they are real ones", () => {
  const loaded = loadMotifCatalogue(MOTIFS_FILE);
  if (!loaded.ok) throw new Error(loaded.message);
  const oath = loaded.value.motifs.find((m) => m.id === "oath-penalty");
  expect(oath?.change.tunables).toEqual([
    "oathDivinityLoss",
    "oathAccessTicks",
  ]);
});

test("malformed catalogues are refused with a path", () => {
  for (const bad of [
    undefined,
    [],
    { ...authored(), schemaVersion: 2 },
    { ...authored(), sources: [] },
    { ...authored(), motifs: "boon" },
    { ...authored(), omitted: undefined },
  ]) {
    expect(parseMotifCatalogue(bad).ok).toBe(false);
  }
  const noSummary = authored();
  delete motif(noSummary, "boon").summary;
  const parsed = parseMotifCatalogue(noSummary);
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) expect(parsed.path).toContain("summary");
});
