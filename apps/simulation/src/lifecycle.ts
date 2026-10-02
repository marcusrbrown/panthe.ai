// Ownership lock and orphan guards.
//
// The lock is an OS-held exclusive lock on a SQLite database at
// `<appDataDir>/lifecycle.lock`: `PRAGMA locking_mode = EXCLUSIVE` plus a
// write (`BEGIN EXCLUSIVE; COMMIT;`) makes this connection acquire and
// hold an exclusive file lock for its entire lifetime. The operating
// system releases that lock the instant the process exits, however it
// exits -- clean shutdown, crash, or SIGKILL -- so there is no lock state
// that can ever outlive the process that held it, and nothing to reclaim
// on the next launch. A concurrent launch's own attempt to take the same
// lock fails with `SQLITE_BUSY` while it is held, which is refused the
// same way any other acquire failure is.
//
// The parent-death guard is unrelated to the lock: it polls this
// process's own parent PID and self-terminates if the parent has died,
// independent of how the lock itself works.

import { Database } from "bun:sqlite";
import { createInterface } from "node:readline";

/**
 * True if `pid` identifies a live process. `EPERM` (process exists, but we
 * lack permission to signal it) still counts as alive; `ESRCH` (no such
 * process) is the only "dead" outcome. Any other error is treated
 * conservatively as "alive" so a transient failure never causes a false
 * self-termination.
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

export type LockDecision =
  | { readonly kind: "acquired"; readonly db: Database }
  | { readonly kind: "refused" };

function isBusyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException & { code?: string }).code === "SQLITE_BUSY"
  );
}

/**
 * Attempts to acquire the ownership lock at `path`: opens (creating if
 * needed) a SQLite database there, switches it to `locking_mode =
 * EXCLUSIVE`, and takes the exclusive file lock with a write. A busy lock
 * (another live process already holds it) is a refusal, never a throw;
 * any other error still throws. The caller must keep the returned `db`
 * connection open for the life of the process and close it on shutdown
 * to release the lock.
 */
export function acquireLock(path: string): LockDecision {
  const db = new Database(path, { create: true });
  try {
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE");
    db.exec("COMMIT");
    return { kind: "acquired", db };
  } catch (error) {
    try {
      db.close();
    } catch {
      // Best-effort; the acquire already failed.
    }
    if (isBusyError(error)) {
      return { kind: "refused" };
    }
    throw error;
  }
}

// --- Launch token (stdin) and orphan guards ---------------------------------

export interface StdinSession {
  /** Resolves with the trimmed first line, or `undefined` if stdin closed before any line ever arrived. */
  readonly token: Promise<string | undefined>;
  /** Resolves with the second line (the launch config, untrimmed text), or `undefined` if stdin closed before it arrived. */
  readonly launchConfig: Promise<string | undefined>;
  /** Registers a handler for stdin closing -- every registered handler fires exactly once, whether or not a token was ever received. */
  onClose(handler: () => void): void;
}

/**
 * Reads the per-launch token from `input`'s first line and the launch config
 * (one JSON line of model settings and keys) from its second -- never argv or
 * env. Later lines are ignored. `input` stays open after both: its EOF (the
 * parent closed the pipe, e.g. on force-quit) fires every handler registered
 * via `onClose`, whether or not either line ever arrived; the caller decides
 * what "closed before the token" or "before the config" means (the real
 * entrypoint refuses to start: a sidecar with no token can never have been
 * authorized to serve, and one with no config line is a broken launch).
 */
export function openStdinSession(input: NodeJS.ReadableStream): StdinSession {
  const rl = createInterface({ input, terminal: false });
  const closeHandlers: (() => void)[] = [];
  let lineCount = 0;
  let resolveToken!: (token: string | undefined) => void;
  let resolveConfig!: (line: string | undefined) => void;
  const token = new Promise<string | undefined>((resolve) => {
    resolveToken = resolve;
  });
  const launchConfig = new Promise<string | undefined>((resolve) => {
    resolveConfig = resolve;
  });

  rl.on("line", (line) => {
    lineCount += 1;
    if (lineCount === 1) {
      resolveToken(line.trim());
    } else if (lineCount === 2) {
      resolveConfig(line);
    }
  });
  rl.on("close", () => {
    // A no-op for a line that already resolved its promise.
    resolveToken(undefined);
    resolveConfig(undefined);
    for (const handler of closeHandlers) {
      handler();
    }
  });

  return {
    token,
    launchConfig,
    onClose(handler) {
      closeHandlers.push(handler);
    },
  };
}

export interface ParentGuardHandle {
  stop(): void;
}

/**
 * True when `parentPid` has died -- the sidecar should self-terminate
 * rather than orphan, even though stdin is still open and its own poll
 * hasn't yet caught up.
 */
export function shouldSelfTerminate(
  parentPid: number,
  isAlive: (pid: number) => boolean = isProcessAlive,
): boolean {
  return !isAlive(parentPid);
}

/**
 * Polls `parentPid` every `intervalMs` and calls `onOrphan` once, the
 * first time the parent is found dead. This is the backstop for a scenario
 * where the stdin pipe itself survives an ancestor's crash (e.g. an
 * intermediate process holding the descriptor) -- `onClose` above is the
 * faster path in the common case.
 */
export function startParentGuard(
  parentPid: number,
  onOrphan: () => void,
  intervalMs = 2000,
  isAlive: (pid: number) => boolean = isProcessAlive,
): ParentGuardHandle {
  let fired = false;
  const timer = setInterval(() => {
    if (fired) {
      return;
    }
    if (shouldSelfTerminate(parentPid, isAlive)) {
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
