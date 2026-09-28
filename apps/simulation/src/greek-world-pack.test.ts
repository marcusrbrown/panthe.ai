import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadContentPack } from "@panthea/content";
import { createInitialWorldState } from "@panthea/world";
import { loadEmbeddedGreekWorldPack } from "./greek-world-pack";

const GREEK_WORLD_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "content",
  "greek",
  "world",
);

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
