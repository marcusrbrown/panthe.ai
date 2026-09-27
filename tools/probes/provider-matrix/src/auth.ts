// Reads OpenCode's credential file at runtime to drive the live provider
// matrix. Every secret string is registered with the shared redaction
// harness (`registerSecret`) before it is used anywhere else, so a provider
// error that echoes the key back is still redacted before it reaches a
// README, a log line, or a thrown error message.
//
// The record never leaves this module except as a `credential` string on
// the returned lookup, which the caller passes directly to a provider
// factory (providers.ts). It is never written into `process.env` (so child
// processes never inherit it), never logged, and never included verbatim in
// a thrown error — malformed-file errors carry the file path, never the
// file's contents.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { registerSecret } from "@panthea/tools-probes-shared";

const DEFAULT_AUTH_RELATIVE_PATH = ".local/share/opencode/auth.json";
const EXPECTED_FILE_MODE = 0o600;

/** The candidate `auth.json` top-level keys tried for Zen, in order. */
export const ZEN_CANDIDATE_KEYS = ["opencode", "opencode-zen", "zen"] as const;
/** The candidate `auth.json` top-level keys tried for Go, in order. */
export const GO_CANDIDATE_KEYS = [
  "opencode-go",
  "opencode-zen-go",
  "zen-go",
] as const;

export interface ApiAuthRecord {
  readonly type: "api";
  readonly key: string;
}

export interface OauthAuthRecord {
  readonly type: "oauth";
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
}

export type AuthRecord = ApiAuthRecord | OauthAuthRecord;

export interface AuthFound {
  readonly configured: true;
  /** Which `auth.json` key matched (e.g. "opencode") — never the credential value. */
  readonly keyName: string;
  readonly mode: "api" | "oauth";
  /** The bearer credential (API key or OAuth access token). Already registered for redaction. */
  readonly credential: string;
}

export interface AuthNotConfigured {
  readonly configured: false;
}

export interface AuthMalformed {
  readonly configured: false;
  readonly error: {
    readonly path: string;
    readonly message: string;
  };
}

export type AuthLookup = AuthFound | AuthNotConfigured | AuthMalformed;

export interface AuthLoadResult {
  /** The path that was read (safe to log/report — never the file's contents). */
  readonly path: string;
  /** Set when the file exists but its mode is not 0600. */
  readonly modeWarning?: string;
  readonly zen: AuthLookup;
  readonly go: AuthLookup;
}

export interface AuthFileOverrides {
  /** Overrides the resolved auth.json path (for tests). */
  readonly path?: string;
  /** Overrides $HOME resolution (for tests). */
  readonly homedir?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveAuthPath(overrides: AuthFileOverrides): string {
  if (overrides.path) {
    return overrides.path;
  }
  const home = overrides.homedir ? overrides.homedir() : homedir();
  return join(home, DEFAULT_AUTH_RELATIVE_PATH);
}

function parseAuthRecord(value: unknown): AuthRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    value.type === "api" &&
    typeof value.key === "string" &&
    value.key.length > 0
  ) {
    return { type: "api", key: value.key };
  }
  if (
    value.type === "oauth" &&
    typeof value.access === "string" &&
    value.access.length > 0 &&
    typeof value.refresh === "string" &&
    typeof value.expires === "number"
  ) {
    return {
      type: "oauth",
      access: value.access,
      refresh: value.refresh,
      expires: value.expires,
    };
  }
  return undefined;
}

/** Checks the auth.json file mode; returns a warning string (never throws) if it isn't 0600. */
function checkFileMode(path: string): string | undefined {
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode !== EXPECTED_FILE_MODE) {
      return `${path} has mode 0${mode.toString(8)}, expected 0${EXPECTED_FILE_MODE.toString(8)}`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function findAuth(
  data: Record<string, unknown>,
  candidates: readonly string[],
): AuthLookup {
  for (const keyName of candidates) {
    const raw = data[keyName];
    if (raw === undefined) {
      continue;
    }
    const record = parseAuthRecord(raw);
    if (!record) {
      // A candidate key exists but doesn't match either known shape; keep
      // looking at the remaining candidates rather than failing the whole
      // lookup on one unrecognized entry.
      continue;
    }
    const credential = record.type === "api" ? record.key : record.access;
    registerSecret(credential);
    if (record.type === "oauth") {
      registerSecret(record.refresh);
    }
    return { configured: true, keyName, mode: record.type, credential };
  }
  return { configured: false };
}

/**
 * Loads OpenCode's `auth.json` and resolves both the Zen and Go provider
 * entries. Never throws: a missing file yields `configured: false` for
 * both; malformed JSON or a non-object root yields a shared `AuthMalformed`
 * result carrying the file path and a parser message, never the raw
 * content.
 */
export function loadOpenCodeAuth(
  overrides: AuthFileOverrides = {},
): AuthLoadResult {
  const path = resolveAuthPath(overrides);

  if (!existsSync(path)) {
    return {
      path,
      zen: { configured: false },
      go: { configured: false },
    };
  }

  let parsed: unknown;
  try {
    const raw = readFileSync(path, "utf8");
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    const malformed: AuthMalformed = {
      configured: false,
      error: { path, message },
    };
    return { path, zen: malformed, go: malformed };
  }

  if (!isRecord(parsed)) {
    const malformed: AuthMalformed = {
      configured: false,
      error: {
        path,
        message: "expected a JSON object keyed by provider id",
      },
    };
    return { path, zen: malformed, go: malformed };
  }

  return {
    path,
    modeWarning: checkFileMode(path),
    zen: findAuth(parsed, ZEN_CANDIDATE_KEYS),
    go: findAuth(parsed, GO_CANDIDATE_KEYS),
  };
}
