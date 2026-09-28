import { expect, test } from "bun:test";
import { parseArchiveManifest } from "./archive";

function validManifest(): Record<string, unknown> {
  return {
    formatVersion: 1,
    sqliteSchemaVersion: 1,
    payloadSchemaVersion: 1,
    worldId: "world-1",
    eventSequence: 42,
    contentHash: "deadbeefcafebabe0123456789abcdef",
  };
}

test("a valid archive manifest round-trips", () => {
  const manifest = validManifest();
  const result = parseArchiveManifest(manifest);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject(manifest);
  }
});

test("a manifest missing the content hash fails", () => {
  const manifest = validManifest();
  delete manifest.contentHash;
  const result = parseArchiveManifest(manifest);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.path).toBe("contentHash");
  }
});

test("a manifest with a non-hex content hash fails", () => {
  const manifest = validManifest();
  manifest.contentHash = "not-hex!!";
  const result = parseArchiveManifest(manifest);
  expect(result.ok).toBe(false);
});

test("an unsupported format version is rejected distinctly from a malformed manifest", () => {
  const manifest = validManifest();
  manifest.formatVersion = 99;
  const result = parseArchiveManifest(manifest);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe("unsupported-version");
  }
});

test("a non-object manifest is rejected as malformed", () => {
  const result = parseArchiveManifest("not a manifest");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe("malformed");
  }
});
