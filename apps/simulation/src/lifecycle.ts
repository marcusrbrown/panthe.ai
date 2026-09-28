// Ownership lock, launch token, and orphan guards, lifted from
// tools/probes/backend-lifecycle/src/{lock,sidecar}.ts (ADR-0003); the
// probe tree stays untouched as M0 evidence.
//
// Two decisions the lock makes, both driven by liveness of a PID, never by
// the mere existence of a file:
//
// 1. On start: a lock file whose recorded PID is dead is stale -- reclaim
//    it. A lock file whose recorded PID is alive means another sidecar
//    already owns this app data dir -- refuse to start.
// 2. At runtime: a sidecar whose recorded parent PID has died should
//    self-terminate rather than orphan.
//
// The launch token is read once from stdin's first line -- never argv or
// env -- and is never logged or persisted; only its SHA-256 hash goes into
// the lock file. stdin closing (EOF) and the parent-PID poll are two
// independent orphan guards: either one firing is sufficient cause to shut
// down, since the pipe surviving an ancestor's crash is possible.

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";

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

/** Hashes a launch token for storage in the lock file -- never the raw token. */
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
    // Malformed lock file (truncated write, foreign process) -- treat as
    // absent rather than throwing; the caller will overwrite it.
    return undefined;
  }
}

/**
 * Writes the lock file and enforces 0600 regardless of umask --
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
      `lifecycle: failed to enforce file mode 0600 on ${path} (got ${actual.toString(8)})`,
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
 * True when the lock's recorded parent process has died -- the sidecar
 * should self-terminate rather than orphan, even though stdin is still
 * open and its own poll of `process.ppid` hasn't yet caught up.
 */
export function shouldSelfTerminate(
  info: LockInfo,
  isAlive: (pid: number) => boolean = isProcessAlive,
): boolean {
  return !isAlive(info.parentPid);
}

// --- Launch token (stdin) and orphan guards ---------------------------------

export interface StdinSession {
  /** Resolves with the trimmed first line, or `undefined` if stdin closed before any line ever arrived. */
  readonly token: Promise<string | undefined>;
  /** Registers a handler for stdin closing -- every registered handler fires exactly once, whether or not a token was ever received. */
  onClose(handler: () => void): void;
}

/**
 * Reads the per-launch token from `input`'s first line -- never argv or
 * env. `input`'s EOF (the parent closed the pipe, e.g. on force-quit)
 * fires every handler registered via `onClose`, whether or not a token
 * line ever arrived; the caller decides what "closed before any token"
 * means (the real entrypoint refuses to start, since a sidecar with no
 * token can never have been authorized to serve).
 */
export function openStdinSession(input: NodeJS.ReadableStream): StdinSession {
  const rl = createInterface({ input, terminal: false });
  const closeHandlers: (() => void)[] = [];
  let received = false;
  let resolveToken!: (token: string | undefined) => void;
  const token = new Promise<string | undefined>((resolve) => {
    resolveToken = resolve;
  });

  rl.on("line", (line) => {
    if (received) {
      return;
    }
    received = true;
    resolveToken(line.trim());
  });
  rl.on("close", () => {
    if (!received) {
      resolveToken(undefined);
    }
    for (const handler of closeHandlers) {
      handler();
    }
  });

  return {
    token,
    onClose(handler) {
      closeHandlers.push(handler);
    },
  };
}

export interface ParentGuardHandle {
  stop(): void;
}

/**
 * Polls `info.parentPid` every `intervalMs` and calls `onOrphan` once, the
 * first time the parent is found dead. This is the backstop for a scenario
 * where the stdin pipe itself survives an ancestor's crash (e.g. an
 * intermediate process holding the descriptor) -- `onClose` above is the
 * faster path in the common case.
 */
export function startParentGuard(
  info: LockInfo,
  onOrphan: () => void,
  intervalMs = 2000,
  isAlive: (pid: number) => boolean = isProcessAlive,
): ParentGuardHandle {
  let fired = false;
  const timer = setInterval(() => {
    if (fired) {
      return;
    }
    if (shouldSelfTerminate(info, isAlive)) {
      fired = true;
      onOrphan();
    }
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
