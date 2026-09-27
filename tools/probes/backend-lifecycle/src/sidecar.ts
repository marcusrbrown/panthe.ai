// ADR-0003 backend-lifecycle probe sidecar. Extends the
// apps/simulation/src/index.ts skeleton (loopback Bun.serve, OS-assigned
// port printed on stdout, SIGTERM/SIGINT shutdown) with everything the
// lifecycle probe measures:
//
//   - a per-launch auth token delivered over stdin (never argv or env),
//     required as `Authorization: Bearer <token>` on every request —
//     localhost is not a security boundary, so the token is the boundary;
//   - a bun:sqlite WAL database in the app data dir (directory 0700, files
//     0600, enforced and asserted) with an `events` table and a `clock`
//     table holding the persisted cursor;
//   - a 1Hz tick that commits an event and advances the clock cursor in the
//     same transaction (see clock.ts for the at-most-once guarantee this
//     depends on);
//   - stdin-EOF graceful exit, parent-PID poll (exit if the parent dies),
//     an ownership lock file (see lock.ts) for stale-lock recovery and
//     duplicate-start refusal, and SIGTERM flush + exit.
//
// This file is compiled to a standalone binary by scripts/build-sidecar.sh
// (`bun build --compile`) for the packaged app, and run directly via
// `bun run src/sidecar.ts` for tests and local development.

import { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { applyElapsed } from "./clock";
import {
  acquireLock,
  hashToken,
  type LockInfo,
  shouldSelfTerminate,
} from "./lock";

export const VERSION = "0.1.0";

const TICK_INTERVAL_MS = 1000;
const PARENT_POLL_INTERVAL_MS = 2000;
const APP_IDENTIFIER = "ai.panthe.desktop";

/**
 * Resolves the per-platform app data directory. `PANTHEA_APP_DATA_DIR`
 * overrides it for tests so they never touch the real app data dir.
 */
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

/** Creates `path` (recursively) and enforces `mode`, regardless of umask, asserting the result. */
function ensureDirMode(path: string, mode: number): void {
  mkdirSync(path, { recursive: true });
  chmodSync(path, mode);
  const actual = statSync(path).mode & 0o777;
  if (actual !== mode) {
    throw new Error(
      `sidecar: failed to enforce directory mode ${mode.toString(8)} on ${path} (got ${actual.toString(8)})`,
    );
  }
}

/** Enforces `mode` on an existing file, asserting the result. */
function ensureFileMode(path: string, mode: number): void {
  chmodSync(path, mode);
  const actual = statSync(path).mode & 0o777;
  if (actual !== mode) {
    throw new Error(
      `sidecar: failed to enforce file mode ${mode.toString(8)} on ${path} (got ${actual.toString(8)})`,
    );
  }
}

export interface OpenedDatabase {
  readonly db: Database;
  readonly path: string;
}

/** Opens (creating if needed) the WAL SQLite database with 0700/0600 modes enforced. */
export function openDatabase(appDataDir: string): OpenedDatabase {
  ensureDirMode(appDataDir, 0o700);
  const path = join(appDataDir, "probe.sqlite");
  const existedBefore = existsSync(path);
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(
    `CREATE TABLE IF NOT EXISTS events (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       sim_t INTEGER NOT NULL,
       wall_t INTEGER NOT NULL,
       note TEXT
     )`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS clock (
       cursor_wall_ms INTEGER NOT NULL
     )`,
  );
  const clockRow = db.query("SELECT cursor_wall_ms FROM clock LIMIT 1").get();
  if (!clockRow) {
    db.run("INSERT INTO clock (cursor_wall_ms) VALUES (?)", [Date.now()]);
  }
  // WAL mode creates -wal/-shm sidecar files; enforce 0600 on every file
  // that exists right now, and again after the first checkpoint below in
  // case a fresh -wal file appears from this process's own writes.
  for (const suffix of ["", "-wal", "-shm"]) {
    const filePath = `${path}${suffix}`;
    if (existsSync(filePath)) {
      ensureFileMode(filePath, 0o600);
    }
  }
  if (!existedBefore) {
    ensureFileMode(path, 0o600);
  }
  return { db, path };
}

function enforceDatabaseFileModes(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const filePath = `${dbPath}${suffix}`;
    if (existsSync(filePath)) {
      ensureFileMode(filePath, 0o600);
    }
  }
}

/** Constant-time bearer-token comparison; never throws on length mismatch. */
export function tokensMatch(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, providedBuf);
}

function extractBearerToken(header: string | null): string | undefined {
  if (!header) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match?.[1];
}

interface StatusResponse {
  readonly ok: true;
  readonly version: string;
  readonly eventCount: number;
  readonly lastEventId: number | null;
  readonly lastSimT: number | null;
  readonly cursorWallMs: number;
}

/** Reads the app data dir, token, and parent PID from the process environment (test overrides). */
export interface SidecarOptions {
  readonly token: string;
  readonly appDataDir?: string;
  readonly parentPid?: number;
  readonly onLog?: (message: string) => void;
}

export interface SidecarHandle {
  readonly port: number;
  readonly lockPath: string;
  /** Runs the same flush-and-exit path as SIGTERM/parent-death. `reason` controls the exit code (0 for a clean shutdown, 1 otherwise). */
  shutdown(reason: string): void;
}

/** Starts the sidecar's HTTP server, database, tick loop, and lifecycle guards. Returns a handle for tests. */
export function startSidecar(options: SidecarOptions): SidecarHandle {
  const log = options.onLog ?? ((message: string) => console.log(message));
  const appDataDir = options.appDataDir ?? resolveAppDataDir();
  const parentPid = options.parentPid ?? process.ppid;
  const token = options.token;

  ensureDirMode(appDataDir, 0o700);
  const lockPath = join(appDataDir, "lifecycle.lock");
  const lockInfo: LockInfo = {
    pid: process.pid,
    parentPid,
    tokenHash: hashToken(token),
    startedAt: new Date().toISOString(),
  };
  const decision = acquireLock(lockPath, lockInfo);
  if (decision.kind === "refused") {
    log(
      `sidecar: refusing to start — lock held by live pid ${decision.holder.pid}`,
    );
    process.exit(3);
  }
  if (decision.kind === "reclaimed") {
    log(
      `sidecar: reclaimed stale lock from dead pid ${decision.staleInfo.pid}`,
    );
  }

  const { db, path: dbPath } = openDatabase(appDataDir);
  let simT =
    (
      db.query("SELECT MAX(sim_t) as maxSimT FROM events").get() as {
        maxSimT: number | null;
      }
    ).maxSimT ?? 0;

  let shuttingDown = false;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let parentPollTimer: ReturnType<typeof setInterval> | undefined;

  function tick(): void {
    const now = Date.now();
    const row = db.query("SELECT cursor_wall_ms FROM clock LIMIT 1").get() as {
      cursor_wall_ms: number;
    };
    const { applied, newCursor } = applyElapsed(row.cursor_wall_ms, now, log);
    simT += 1;
    const commit = db.transaction(() => {
      db.run("UPDATE clock SET cursor_wall_ms = ?", [newCursor]);
      db.run("INSERT INTO events (sim_t, wall_t, note) VALUES (?, ?, ?)", [
        simT,
        now,
        `tick applied=${applied}ms`,
      ]);
    });
    commit();
    enforceDatabaseFileModes(dbPath);
  }

  function shutdown(reason: string): void {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log(`sidecar: shutting down (${reason})`);
    if (tickTimer !== undefined) {
      clearInterval(tickTimer);
    }
    if (parentPollTimer !== undefined) {
      clearInterval(parentPollTimer);
    }
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Best-effort checkpoint; closing still flushes the WAL.
    }
    db.close();
    server.stop();
    const gracefulReasons = new Set(["SIGTERM", "SIGINT", "stdin-eof"]);
    process.exit(gracefulReasons.has(reason) ? 0 : 1);
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const provided = extractBearerToken(request.headers.get("authorization"));
      if (!provided || !tokensMatch(token, provided)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const url = new URL(request.url);
      if (url.pathname === "/status") {
        const eventCount = (
          db.query("SELECT COUNT(*) as count FROM events").get() as {
            count: number;
          }
        ).count;
        const last = db
          .query("SELECT id, sim_t FROM events ORDER BY id DESC LIMIT 1")
          .get() as { id: number; sim_t: number } | null;
        const cursor = (
          db.query("SELECT cursor_wall_ms FROM clock LIMIT 1").get() as {
            cursor_wall_ms: number;
          }
        ).cursor_wall_ms;
        const body: StatusResponse = {
          ok: true,
          version: VERSION,
          eventCount,
          lastEventId: last?.id ?? null,
          lastSimT: last?.sim_t ?? null,
          cursorWallMs: cursor,
        };
        return Response.json(body);
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  const port = server.port;
  if (port === undefined) {
    throw new Error("sidecar: server did not bind to a TCP port");
  }
  // Printed for the parent process (the Tauri shell, or a developer) to
  // discover the OS-assigned port; do not remove or reformat this line.
  console.log(`PANTHEA_PORT=${port}`);

  tickTimer = setInterval(tick, TICK_INTERVAL_MS);

  parentPollTimer = setInterval(() => {
    if (shouldSelfTerminate(lockInfo)) {
      shutdown("parent-dead");
    }
  }, PARENT_POLL_INTERVAL_MS);

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return {
    port,
    lockPath,
    shutdown,
  };
}

/**
 * Reads the per-launch token from stdin's first line — never argv or env —
 * then starts the sidecar. Stdin EOF (the parent closed the pipe, e.g. on
 * force-quit) triggers a graceful exit.
 */
function main(): void {
  const rl = createInterface({ input: process.stdin, terminal: false });
  let started = false;
  let handle: SidecarHandle | undefined;

  rl.on("line", (line) => {
    if (started) {
      return;
    }
    started = true;
    const token = line.trim();
    if (!token) {
      console.error("sidecar: empty token on stdin; exiting");
      process.exit(2);
    }
    handle = startSidecar({ token });
  });

  rl.on("close", () => {
    // stdin EOF — the parent closed the pipe (e.g. force-quit). Run the
    // same flush-and-exit path as SIGTERM rather than a bare process.exit,
    // so the DB is checkpointed and the server socket is released.
    console.log("sidecar: stdin closed");
    if (handle) {
      handle.shutdown("stdin-eof");
    } else {
      // EOF arrived before any token line — nothing was started yet.
      process.exit(0);
    }
  });
}

if (import.meta.main) {
  main();
}
