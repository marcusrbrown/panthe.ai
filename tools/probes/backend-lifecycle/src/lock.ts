// Ownership lock file: the launchd-free stale-lock recovery mechanism from
// ADR-0003's Key Technical Decisions. stdin-EOF and parent-PID polling
// alone are insufficient (PID reuse, a held pipe on an ancestor crash, a
// missed fast exit), so the sidecar also writes a lock file in the app
// data dir holding its own PID, its parent's PID, a hash of the launch
// token, and a start timestamp.
//
// Two decisions this module makes, both driven by liveness of a PID, never
// by the mere existence of a file:
//
// 1. On start: a lock file whose recorded PID is dead is stale — reclaim
//    it. A lock file whose recorded PID is alive means another sidecar
//    already owns this app data dir — refuse to start (exit code 3 is the
//    caller's job, not this module's).
// 2. At runtime: a sidecar whose recorded parent PID has died should
//    self-terminate rather than orphan.
//
// This is recovery state, not the primary exclusivity mechanism — ADR-0003
// fixes the order as tauri-plugin-single-instance first, then this lock
// interpreted as recovery state.

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";

export interface LockInfo {
  readonly pid: number;
  readonly parentPid: number;
  readonly tokenHash: string;
  readonly startedAt: string;
}

export type LockDecision =
  | { readonly kind: "acquired"; readonly info: LockInfo }
  | {
      readonly kind: "reclaimed";
      readonly info: LockInfo;
      readonly staleInfo: LockInfo;
    }
  | { readonly kind: "refused"; readonly holder: LockInfo };

/** Hashes a launch token for storage in the lock file — never the raw token. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * True if `pid` identifies a live process. `EPERM` (process exists, but we
 * lack permission to signal it) still counts as alive; `ESRCH` (no such
 * process) is the only "dead" outcome. Any other error is treated
 * conservatively as "alive" so a transient failure never causes a false
 * reclaim of a live owner's lock.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

export function readLock(path: string): LockInfo | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockInfo>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.parentPid === "number" &&
      typeof parsed.tokenHash === "string" &&
      typeof parsed.startedAt === "string"
    ) {
      return {
        pid: parsed.pid,
        parentPid: parsed.parentPid,
        tokenHash: parsed.tokenHash,
        startedAt: parsed.startedAt,
      };
    }
    return undefined;
  } catch {
    // Malformed lock file (truncated write, foreign process) — treat as
    // absent rather than throwing; the caller will overwrite it.
    return undefined;
  }
}

/**
 * Writes the lock file and enforces 0600 regardless of umask —
 * `writeFileSync`'s `mode` option is still subject to the process umask, so
 * a fresh acquire *and* a reclaim of an existing (differently-moded) lock
 * file both need an explicit `chmodSync` afterward, asserted by re-reading
 * the mode rather than trusted blindly.
 */
export function writeLock(path: string, info: LockInfo): void {
  writeFileSync(path, JSON.stringify(info), "utf8");
  chmodSync(path, 0o600);
  const actual = statSync(path).mode & 0o777;
  if (actual !== 0o600) {
    throw new Error(
      `lock: failed to enforce file mode 0600 on ${path} (got ${actual.toString(8)})`,
    );
  }
}

export interface AcquireLockDeps {
  readonly readLock: (path: string) => LockInfo | undefined;
  readonly writeLock: (path: string, info: LockInfo) => void;
  readonly isProcessAlive: (pid: number) => boolean;
}

const defaultDeps: AcquireLockDeps = { readLock, writeLock, isProcessAlive };

/**
 * Attempts to acquire the ownership lock at `path` for `info`. A held lock
 * whose PID is alive refuses; a held lock whose PID is dead (or unreadable)
 * is reclaimed; no lock file acquires cleanly.
 */
export function acquireLock(
  path: string,
  info: LockInfo,
  deps: AcquireLockDeps = defaultDeps,
): LockDecision {
  const existing = deps.readLock(path);
  if (existing && deps.isProcessAlive(existing.pid)) {
    return { kind: "refused", holder: existing };
  }
  deps.writeLock(path, info);
  return existing
    ? { kind: "reclaimed", info, staleInfo: existing }
    : { kind: "acquired", info };
}

/**
 * True when the lock's recorded parent process has died — the sidecar
 * should self-terminate rather than orphan, even though stdin is still
 * open and its own poll of `process.ppid` hasn't yet caught up.
 */
export function shouldSelfTerminate(
  info: LockInfo,
  isAlive: (pid: number) => boolean = isProcessAlive,
): boolean {
  return !isAlive(info.parentPid);
}
