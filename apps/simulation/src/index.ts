// The simulation service entrypoint: takes the ownership lock, reads the
// launch token from stdin, opens the active world slot (creating one from
// the authored Greek pack on first run), runs catch-up, then starts the
// 1 Hz tick loop and the authenticated server. Stops cleanly on stdin EOF
// or SIGTERM/SIGINT, and self-terminates if its parent process dies.

import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  closeStore,
  openStore,
  readCatchUpSummary,
  readClock,
  readLiveProjections,
  readPrngState,
  type Store,
} from "@panthea/persistence";
import { ensureTraceSchema } from "@panthea/telemetry";
import type { PrngState, WorldState } from "@panthea/world";
import { type CatchUpResult, runCatchUp } from "./catchup";
import { acquireLock, openStdinSession, startParentGuard } from "./lifecycle";
import { startModelPayloadPruner } from "./prune";
import {
  applyLiveTick,
  type CatchUpControl,
  createServiceStatusRef,
  createSimulationServer,
  isHalted,
  type ServiceStatusRef,
  type SimulationServerHandle,
  updateServiceStatus,
} from "./server";
import { buildRoutineQueue, type QueuedProposal, type TickDeps } from "./tick";
import {
  createWorldProjectionReducers,
  deserializePrngState,
  loadGreekWorldState,
  restoreWorldTime,
} from "./world-store";

const APP_IDENTIFIER = "ai.panthe.desktop";
const TICK_INTERVAL_MS = 1000;
const PARENT_POLL_INTERVAL_MS = 2000;
/** A wall-clock gap between ticks larger than this is treated as a sleep/wake event (catch-up), not ordinary timer jitter. */
const SLEEP_GAP_THRESHOLD_MS = 5_000;
const DEFAULT_PRNG_SEED = 1;

/** Resolves the per-platform app data directory. `PANTHEA_APP_DATA_DIR` overrides it for tests so they never touch the real app data dir. */
export function resolveAppDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env.PANTHEA_APP_DATA_DIR;
  if (override) {
    return override;
  }
  const home = homedir();
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", APP_IDENTIFIER);
  }
  if (platform === "win32") {
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, APP_IDENTIFIER);
  }
  const xdgDataHome = env.XDG_DATA_HOME ?? join(home, ".local", "share");
  return join(xdgDataHome, APP_IDENTIFIER);
}

function ensureDirMode(path: string, mode: number): void {
  mkdirSync(path, { recursive: true });
  chmodSync(path, mode);
}

/**
 * Refreshes `statusRef`'s sequence and encoded state from `result.state`
 * (the last chunk that actually committed) whether or not catch-up
 * degraded partway through -- a degraded result still advanced the store
 * by however many chunks succeeded, so `/frame` must reflect that
 * progress rather than staying pinned to whatever state existed before
 * catch-up started.
 *
 * The catch-up summary a frame carries is read back from the store, never
 * taken from `result`: `runCatchUp` persists a summary in the transaction that
 * ends its backlog (or, for a degraded run, in one of its own), so what is
 * exposed here has already survived, and a summary whose write failed is
 * simply not there to expose. A catch-up that applied and skipped less than
 * one tick and found no outcomes persists nothing, so the earlier summary
 * stays.
 *
 * Status comes from the persisted clock, not an assumption: a
 * successful run can still have stopped for a mid-catch-up pause, and
 * `/frame` must show `paused`, not `running`, for that outcome.
 */
export function refreshStatusAfterCatchUp(
  statusRef: ServiceStatusRef,
  result: CatchUpResult,
  store: Pick<Store, "db">,
): void {
  const persisted = readCatchUpSummary(store.db);
  const catchUpSummary = persisted ? { catchUpSummary: persisted } : {};
  if (result.degraded) {
    updateServiceStatus(statusRef, result.state, catchUpSummary);
    statusRef.status = "degraded";
    statusRef.degradedReason = result.degraded.reason;
    return;
  }
  updateServiceStatus(statusRef, result.state, {
    ...catchUpSummary,
    paused: readClock(store.db).paused,
  });
}

/**
 * The status a starting service serves from its first frame. It already
 * carries the summary this store last delivered: that summary is persisted, so
 * a kill after it was shown, or before it was fetched, loses nothing, and a
 * catch-up still running when the first request arrives does not hide it.
 */
export function createHydratedStatusRef(
  state: WorldState,
  store: Pick<Store, "db">,
): ServiceStatusRef {
  return createServiceStatusRef(state, readCatchUpSummary(store.db));
}

export interface StartOptions {
  readonly token: string;
  readonly appDataDir?: string;
  readonly parentPid?: number;
  readonly onLog?: (message: string) => void;
  /** Test-only OS-assigned port (0) instead of the real service port. */
  readonly port?: number;
}

export interface ServiceHandle {
  readonly port: number;
  readonly lockPath: string;
  /** Runs the same flush-and-exit path as SIGTERM/parent-death. `reason` controls the exit code (0 for a clean shutdown, 1 otherwise). */
  shutdown(reason: string): void;
}

/** Starts the service's store, catch-up, tick loop, server, and lifecycle guards. Returns a handle for tests. */
export function startService(options: StartOptions): ServiceHandle {
  const log = options.onLog ?? ((message: string) => console.log(message));
  const appDataDir = options.appDataDir ?? resolveAppDataDir();
  const parentPid = options.parentPid ?? process.ppid;
  const token = options.token;

  ensureDirMode(appDataDir, 0o700);
  const lockPath = join(appDataDir, "lifecycle.lock");
  const decision = acquireLock(lockPath);
  if (decision.kind === "refused") {
    log(
      "panthea-simulation: refusing to start -- the lock is held by another live process",
    );
    process.exit(3);
  }
  const lockDb = decision.db;

  const activeStorePath = join(appDataDir, "active", "world.sqlite");
  const slotsDir = join(appDataDir, "slots");
  const genesisState = loadGreekWorldState();
  const reducers = createWorldProjectionReducers(genesisState);
  const store = openStore(activeStorePath, reducers);
  ensureTraceSchema(store.db);
  // Model-request payload text is kept seven days: pruned now, then hourly.
  const payloadPruner = startModelPayloadPruner(store.db, {
    onError: (error) =>
      log(
        `panthea-simulation: model payload prune failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });

  const clock = readClock(store.db);
  let state: WorldState = restoreWorldTime(
    readLiveProjections(store, reducers),
    clock,
  );
  let prng: PrngState = deserializePrngState(readPrngState(store.db)) ?? {
    seed: DEFAULT_PRNG_SEED,
  };

  const tickDeps: TickDeps = { store, reducers, traceDb: store.db };
  const statusRef: ServiceStatusRef = createHydratedStatusRef(state, store);

  // Set synchronously at the start of every `runCatchUpNow` call, before
  // that call's first `await` -- so by the time any other code in this
  // process runs, a catch-up run already in flight is visible. This lets
  // the live tick loop skip a cycle rather than racing catch-up's own
  // chunk commits against the same store, and lets `/pause` (via
  // `catchUpControl`) cooperate instead of committing its own pause
  // transition concurrently.
  let catchUpInProgress = false;
  let pauseRequestedDuringCatchUp = false;

  const catchUpControl: CatchUpControl = {
    isRunning: () => catchUpInProgress,
    requestPause: () => {
      pauseRequestedDuringCatchUp = true;
    },
  };

  async function runCatchUpNow(nowWallMs: number): Promise<boolean> {
    catchUpInProgress = true;
    pauseRequestedDuringCatchUp = false;
    try {
      const result = await runCatchUp(state, prng, tickDeps, {
        nowWallMs,
        onChunkCommitted: () => pauseRequestedDuringCatchUp,
      });
      state = result.state;
      prng = result.prng;
      refreshStatusAfterCatchUp(statusRef, result, store);
      return Boolean(result.degraded);
    } finally {
      catchUpInProgress = false;
    }
  }

  let queue: QueuedProposal[] = [];

  const serverHandle: SimulationServerHandle = createSimulationServer({
    token,
    store,
    reducers,
    traceDb: store.db,
    slotsDir,
    statusRef,
    catchUpControl,
    ...(options.port !== undefined ? { port: options.port } : {}),
  });
  // Printed for the parent process (the Tauri shell, or a developer) to
  // discover the OS-assigned port; do not remove or reformat this line.
  log(`PANTHEA_PORT=${serverHandle.port}`);

  let tickTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * One 1 Hz cycle: skips entirely while a catch-up run (startup or
   * sleep-wake) is already advancing the store in the background, and
   * while paused. A wall-clock gap beyond ordinary timer jitter (a
   * sleep/wake cycle) runs catch-up instead of a single tick, since
   * routines still need to act at the same one-simulated-second
   * granularity as live play; that catch-up run itself now executes in
   * the background (chunked, yielding to the event loop) rather than
   * blocking this cycle. Otherwise runs one ordinary tick over the routine
   * proposals decided from the last committed state plus the pending entries
   * of the durable proposal journal, which the tick consumes itself.
   */
  function runOneLiveTick(): void {
    if (catchUpInProgress) {
      return;
    }
    if (isHalted(statusRef)) {
      return;
    }
    const currentClock = readClock(store.db);
    if (currentClock.paused) {
      statusRef.status = "paused";
      return;
    }
    const now = Date.now();
    const gap = now - currentClock.cursorWallMs;
    if (gap > SLEEP_GAP_THRESHOLD_MS) {
      void runCatchUpNow(now).then((degraded) => {
        queue = [...buildRoutineQueue(state)];
        if (degraded && tickTimer) {
          clearInterval(tickTimer);
        }
        serverHandle.broadcastFrame();
      });
      return;
    }

    const step = applyLiveTick(queue, state, prng, tickDeps, {
      cursorWallMs: currentClock.cursorWallMs + TICK_INTERVAL_MS,
      paused: false,
    });
    if (step.kind === "store-error") {
      statusRef.status = "degraded";
      statusRef.degradedReason = step.reason;
      if (tickTimer) {
        clearInterval(tickTimer);
      }
      serverHandle.broadcastFrame();
      return;
    }
    state = step.state;
    prng = step.prng;
    queue = [...step.nextQueue];
    updateServiceStatus(statusRef, state);
    serverHandle.broadcastFrame();
  }

  tickTimer = setInterval(runOneLiveTick, TICK_INTERVAL_MS);

  // Catch-up on start: the persisted cursor may be far behind now if the
  // process was not running (killed, machine restarted). Runs in the
  // background -- the server above is already listening and the tick
  // loop above already skips cycles while `catchUpInProgress`, so
  // `/pause` and every other request are served while this chunks
  // through the backlog.
  void runCatchUpNow(Date.now()).then(() => {
    queue = [...buildRoutineQueue(state)];
    serverHandle.broadcastFrame();
    // Printed last on purpose: by this line the catch-up has run, the status
    // was refreshed from the store (`runCatchUpNow`), and the frame was
    // broadcast, so a reader of this line knows the summary was published.
    log("panthea-simulation: startup catch-up complete");
  });

  let shuttingDown = false;
  function shutdown(reason: string): void {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log(`panthea-simulation: shutting down (${reason})`);
    if (tickTimer) {
      clearInterval(tickTimer);
    }
    payloadPruner.stop();
    parentGuard.stop();
    serverHandle.stop(true);
    try {
      closeStore(store);
    } catch {
      // Best-effort; the process is exiting regardless.
    }
    try {
      lockDb.close();
    } catch {
      // Best-effort; the process is exiting regardless -- the OS releases
      // the lock either way.
    }
    const gracefulReasons = new Set(["SIGTERM", "SIGINT", "stdin-eof"]);
    process.exit(gracefulReasons.has(reason) ? 0 : 1);
  }

  const parentGuard = startParentGuard(
    parentPid,
    () => shutdown("parent-dead"),
    PARENT_POLL_INTERVAL_MS,
  );

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return { port: serverHandle.port, lockPath, shutdown };
}

/** Reads the per-launch token from stdin, then starts the service. Stdin EOF before any token line refuses to start; EOF after a token drives a graceful shutdown. */
function main(): void {
  const session = openStdinSession(process.stdin);
  let handle: ServiceHandle | undefined;
  let tokenReceived = false;

  session.token.then((token) => {
    if (token === undefined) {
      // No token line ever arrived; `onClose` below decides the outcome.
      return;
    }
    tokenReceived = true;
    if (!token) {
      console.error("panthea-simulation: empty token on stdin; exiting");
      process.exit(2);
    }
    handle = startService({ token });
  });

  session.onClose(() => {
    console.log("panthea-simulation: stdin closed");
    if (handle) {
      handle.shutdown("stdin-eof");
    } else if (!tokenReceived) {
      // The real Tauri spawn path always writes a token right after
      // spawn; this only happens on a broken launch. Refuse to start
      // rather than exiting as if asked to shut down gracefully, since a
      // sidecar with no token can never have been authorized to serve.
      console.error(
        "panthea-simulation: stdin closed before a launch token was received; refusing to start",
      );
      process.exit(1);
    }
  });
}

if (import.meta.main) {
  main();
}
