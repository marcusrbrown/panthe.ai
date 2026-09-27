// The archive manifest is the self-describing header of an export archive
// (Key Technical Decisions: "a single self-describing SQLite file captured
// at a committed tick boundary"). It tracks three independent version
// numbers on purpose: the archive container format, the SQLite user_version
// (packages/persistence's concern), and the payload schema version these
// contracts define. Import treats every field as hostile until it parses
// and the content hash recomputes (packages/persistence, Unit 2).

import {
  fail,
  isRecord,
  ok,
  type ParseResult,
  parseNonNegativeInteger,
  parseSchemaVersion,
  parseString,
  parseWorldId,
  type WorldId,
} from "./ids";

export const ARCHIVE_FORMAT_VERSIONS = [1] as const;

const CONTENT_HASH_PATTERN = /^[0-9a-f]{16,}$/i;

export interface ArchiveManifest {
  readonly formatVersion: number;
  readonly sqliteSchemaVersion: number;
  readonly payloadSchemaVersion: number;
  readonly worldId: WorldId;
  readonly eventSequence: number;
  readonly contentHash: string;
}

export function parseArchiveManifest(
  input: unknown,
): ParseResult<ArchiveManifest> {
  if (!isRecord(input)) {
    return fail("", "expected an archive manifest object");
  }

  const formatVersion = parseSchemaVersion(
    input.formatVersion,
    ARCHIVE_FORMAT_VERSIONS,
    "formatVersion",
  );
  if (!formatVersion.ok) return formatVersion;

  const sqliteSchemaVersion = parseNonNegativeInteger(
    input.sqliteSchemaVersion,
    "sqliteSchemaVersion",
  );
  if (!sqliteSchemaVersion.ok) return sqliteSchemaVersion;

  const payloadSchemaVersion = parseNonNegativeInteger(
    input.payloadSchemaVersion,
    "payloadSchemaVersion",
  );
  if (!payloadSchemaVersion.ok) return payloadSchemaVersion;

  const worldId = parseWorldId(input.worldId, "worldId");
  if (!worldId.ok) return worldId;

  const eventSequence = parseNonNegativeInteger(
    input.eventSequence,
    "eventSequence",
  );
  if (!eventSequence.ok) return eventSequence;

  const contentHash = parseString(input.contentHash, "contentHash");
  if (!contentHash.ok) return contentHash;
  if (!CONTENT_HASH_PATTERN.test(contentHash.value)) {
    return fail("contentHash", "expected a hex-encoded content hash");
  }

  return ok({
    formatVersion: formatVersion.value,
    sqliteSchemaVersion: sqliteSchemaVersion.value,
    payloadSchemaVersion: payloadSchemaVersion.value,
    worldId: worldId.value,
    eventSequence: eventSequence.value,
    contentHash: contentHash.value,
  });
}
