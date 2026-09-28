// The world slot registry: every world slot other than the active one
// lives under a slots directory, populated only by import (an archive
// from elsewhere) or restore (one of this world's own earlier exports) --
// both go through packages/persistence's staging-then-atomic-rename path,
// and neither ever touches the active world's own store.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type ImportResult,
  importArchive,
  type ProjectionCodec,
} from "@panthea/persistence";

const STAGING_PREFIX = ".staging-";

export interface WorldSlot {
  readonly slotId: string;
  readonly slotPath: string;
}

/**
 * Lists every fully materialized world slot under `slotsDir`. Import's
 * staging directory is removed on both success and failure, and its
 * atomic rename only ever publishes a complete slot, so anything else
 * present here (other than a staging directory mid-import) is always
 * fully materialized -- there is no separate "slot index" file to drift
 * from the filesystem's own state.
 */
export function listWorldSlots(slotsDir: string): readonly WorldSlot[] {
  let entries: string[];
  try {
    entries = readdirSync(slotsDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => !name.startsWith(STAGING_PREFIX))
    .map((slotId) => ({ slotId, slotPath: join(slotsDir, slotId) }))
    .sort((a, b) => a.slotId.localeCompare(b.slotId));
}

/**
 * Imports `archivePath` into a brand-new, service-generated slot under
 * `slotsDir` -- the same path whether the caller is importing an archive
 * from elsewhere or restoring one of this world's own earlier exports.
 * Never touches any other slot, including the active world's.
 */
export function importWorldArchive(
  archivePath: string,
  slotsDir: string,
  codec: ProjectionCodec<unknown>,
): ImportResult {
  return importArchive(archivePath, slotsDir, codec);
}
