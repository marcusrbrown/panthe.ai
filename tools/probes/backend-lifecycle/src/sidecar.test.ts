// Spawns the TypeScript entry directly via `bun run` — never the compiled
// binary — per the plan's test scenarios. Compiled-binary behavior
// (offline bun:sqlite, no build-host leakage) is covered by
// scripts/scan-binary.sh and the packaged lifecycle.sh run, recorded in
// README.md.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SIDECAR_ENTRY = join(import.meta.dir, "sidecar.ts");
const STARTUP_TIMEOUT_MS = 10_000;

let appDataDir: string;

beforeEach(() => {
  appDataDir = mkdtempSync(join(tmpdir(), "panthea-sidecar-test-"));
});

afterEach(() => {
  rmSync(appDataDir, { recursive: true, force: true });
});

interface SpawnedSidecar {
  readonly proc: ReturnType<typeof Bun.spawn>;
  readonly port: number;
}

/** Spawns the sidecar, writes `token` to stdin, and resolves once the port line is seen. */
async function spawnSidecar(
  token: string,
  extraEnv: Record<string, string> = {},
): Promise<SpawnedSidecar> {
  const proc = Bun.spawn(["bun", "run", SIDECAR_ENTRY], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PANTHEA_APP_DATA_DIR: appDataDir,
      ...extraEnv,
    },
  });

  const writer = proc.stdin;
  if (typeof writer === "number" || !writer) {
    throw new Error("expected a FileSink stdin (spawned with stdin: 'pipe')");
  }
  writer.write(`${token}\n`);
  await writer.flush();

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const port = await Promise.race([
    (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          throw new Error("sidecar exited before printing PANTHEA_PORT");
        }
        buffer += decoder.decode(value, { stream: true });
        const match = /PANTHEA_PORT=(\d+)/.exec(buffer);
        if (match?.[1]) {
          return Number.parseInt(match[1], 10);
        }
      }
    })(),
    new Promise<number>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for PANTHEA_PORT")),
        STARTUP_TIMEOUT_MS,
      ),
    ),
  ]);
  reader.releaseLock();

  return { proc, port };
}

describe("sidecar (bun run src/sidecar.ts)", () => {
  test("error path: a request without the launch token is rejected", async () => {
    const { proc, port } = await spawnSidecar("test-token-1");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`);
      expect(response.status).toBe(401);

      const wrongToken = await fetch(`http://127.0.0.1:${port}/status`, {
        headers: { Authorization: "Bearer not-the-token" },
      });
      expect(wrongToken.status).toBe(401);

      const authorized = await fetch(`http://127.0.0.1:${port}/status`, {
        headers: { Authorization: "Bearer test-token-1" },
      });
      expect(authorized.status).toBe(200);
      const body = (await authorized.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    } finally {
      proc.kill();
    }
  });

  test("the database directory and files carry the asserted modes", async () => {
    const { proc, port } = await spawnSidecar("test-token-2");
    try {
      // Force at least one authorized request so the DB is definitely open.
      await fetch(`http://127.0.0.1:${port}/status`, {
        headers: { Authorization: "Bearer test-token-2" },
      });

      const dirMode = statSync(appDataDir).mode & 0o777;
      expect(dirMode).toBe(0o700);

      const dbMode = statSync(join(appDataDir, "probe.sqlite")).mode & 0o777;
      expect(dbMode).toBe(0o600);
    } finally {
      proc.kill();
    }
  });

  test("stdin EOF triggers a graceful exit", async () => {
    const { proc, port } = await spawnSidecar("test-token-3");
    // Confirm it's actually up before closing stdin.
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      headers: { Authorization: "Bearer test-token-3" },
    });
    expect(response.status).toBe(200);

    const stdin = proc.stdin;
    if (typeof stdin === "number" || !stdin) {
      throw new Error("expected a FileSink stdin (spawned with stdin: 'pipe')");
    }
    stdin.end();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });
});
