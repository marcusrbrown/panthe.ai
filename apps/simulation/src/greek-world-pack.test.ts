import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadContentPack, loadGodProfiles } from "@panthea/content";
import {
  createInitialWorldState,
  DEFAULT_MEMORY_BALANCE,
} from "@panthea/world";
import {
  loadEmbeddedGreekGodProfiles,
  loadEmbeddedGreekWorldPack,
} from "./greek-world-pack";

const GREEK_WORLD_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "content",
  "greek",
  "world",
);

const GREEK_GODS_DIR = join(GREEK_WORLD_DIR, "..", "gods");

test("the embedded Greek pack parses to the same content pack as loading content/greek/world from disk", () => {
  const embedded = loadEmbeddedGreekWorldPack();
  expect(embedded.ok).toBe(true);

  const fromDisk = loadContentPack(GREEK_WORLD_DIR);
  expect(fromDisk.ok).toBe(true);

  if (!embedded.ok || !fromDisk.ok) {
    return;
  }
  expect(embedded.value).toEqual(fromDisk.value);
});

test("the embedded pack carries the Zeus and Hera profiles, identical to content/greek/gods on disk", () => {
  const pack = loadEmbeddedGreekWorldPack();
  if (!pack.ok) throw new Error(pack.message);

  const embedded = loadEmbeddedGreekGodProfiles(pack.value);
  const fromDisk = loadGodProfiles(GREEK_GODS_DIR, pack.value);
  if (!embedded.ok) throw new Error(`${embedded.path}: ${embedded.message}`);
  if (!fromDisk.ok) throw new Error(`${fromDisk.path}: ${fromDisk.message}`);

  expect(embedded.value.map((god) => god.id).sort()).toEqual(["hera", "zeus"]);
  expect(embedded.value).toEqual(fromDisk.value);
});

test("the embedded Greek pack builds the same initial WorldState as loading content/greek/world from disk", () => {
  const embedded = loadEmbeddedGreekWorldPack();
  const fromDisk = loadContentPack(GREEK_WORLD_DIR);
  if (!embedded.ok || !fromDisk.ok) {
    throw new Error("expected both loads to succeed");
  }

  const embeddedState = createInitialWorldState(embedded.value);
  const fromDiskState = createInitialWorldState(fromDisk.value);
  expect(embeddedState).toEqual(fromDiskState);
});

test("the Greek pack states the memory tunables the world rules default to, so a retune edits one place and shows in both", () => {
  const pack = loadEmbeddedGreekWorldPack();
  if (!pack.ok) throw new Error(pack.message);
  expect(pack.value.rules.memoryBalance).toEqual(DEFAULT_MEMORY_BALANCE);
});

test("the Greek pack gives the woodcutter a woodshed at the square, so a theft by him can be punished, and carries strict petition tunables", () => {
  const pack = loadEmbeddedGreekWorldPack();
  if (!pack.ok) throw new Error(pack.message);
  const shed = pack.value.buildings.find((b) => b.id === "woodshed");
  expect(shed).toMatchObject({
    owner: "woodcutter",
    locationId: "town-square",
    combustible: true,
  });
  // The woodcutter is the only owner of it, and the farmer's buildings are unchanged.
  expect(
    pack.value.buildings.filter((b) => b.owner === "farmer").map((b) => b.id),
  ).toEqual(["agora-shop", "the-tavern"]);
  expect(Object.keys(pack.value.rules.petitionBalance ?? {}).sort()).toEqual(
    [
      "answerWindowTicks",
      "blessDivinityCost",
      "blessPlanks",
      "blessResourceAmount",
      "causePrayableTicks",
      "directorQuietTicks",
      "goalLockTicks",
      "prayerCooldownTicks",
    ].sort(),
  );
});
