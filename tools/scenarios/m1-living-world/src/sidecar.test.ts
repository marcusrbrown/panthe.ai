import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killAllSidecars, liveSidecarCount, startSidecar } from "./sidecar";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("startSidecar's launch lines", () => {
  /** A stand-in sidecar: records the first two stdin lines to files, then prints a port. */
  function recordingScript(dir: string): { script: string; lines: string } {
    const lines = join(dir, "lines");
    const script = join(dir, "records-stdin.sh");
    writeFileSync(
      script,
      `#!/bin/sh\nread -r token\nread -r config\nprintf '%s\\n%s\\n' "$token" "$config" > "${lines}"\necho PANTHEA_PORT=1\nsleep 5\n`,
    );
    chmodSync(script, 0o755);
    return { script, lines };
  }

  test("with no launch config the second line says no settings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "panthea-sidecar-test-"));
    try {
      const { script, lines } = recordingScript(dir);
      const sidecar = await startSidecar(script, "/tmp/unused");
      try {
        const [token, config] = readFileSync(lines, "utf8").split("\n");
        expect(token).toMatch(/^[0-9a-f-]{36}$/);
        expect(JSON.parse(config ?? "")).toEqual({
          models: null,
          offline: false,
          keys: {},
        });
      } finally {
        await sidecar.stop("SIGKILL").catch(() => undefined);
      }
    } finally {
      killAllSidecars();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a given launch config is sent as the second line, on one line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "panthea-sidecar-test-"));
    try {
      const { script, lines } = recordingScript(dir);
      const launch = {
        models: { endpoints: [], roles: {} },
        offline: true,
        keys: { k: "line\nbreak" },
      };
      const sidecar = await startSidecar(script, "/tmp/unused", {
        launchConfig: launch,
      });
      try {
        const [, config] = readFileSync(lines, "utf8").split("\n");
        expect(JSON.parse(config ?? "")).toEqual(launch);
      } finally {
        await sidecar.stop("SIGKILL").catch(() => undefined);
      }
    } finally {
      killAllSidecars();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("startSidecar when startup fails", () => {
  test("a child that never prints its port is killed, not left running, when the start times out", async () => {
    // `cat` reads the token from stdin and then waits for more: it never prints a port.
    const before = liveSidecarCount();
    let pid = 0;
    const started = startSidecar("/bin/cat", "/tmp/unused", {
      startTimeoutMs: 200,
      onSpawn: (spawned) => {
        pid = spawned;
      },
    });

    await expect(started).rejects.toThrow(/did not print its port/);

    expect(pid).toBeGreaterThan(0);
    expect(liveSidecarCount()).toBe(before);
    await Bun.sleep(100);
    expect(alive(pid)).toBe(false);
  });

  test("a child that exits before printing its port is reported and not tracked as live", async () => {
    const before = liveSidecarCount();

    await expect(
      startSidecar("/usr/bin/true", "/tmp/unused", { startTimeoutMs: 2000 }),
    ).rejects.toThrow(/exited \(0\) before printing its port/);

    expect(liveSidecarCount()).toBe(before);
  });

  test("a child that closes its stdin before the token is written and then exits is reported as an early exit, not as a broken pipe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "panthea-sidecar-test-"));
    try {
      // The child closes fd 0, signals it with a marker file, and exits shortly after.
      // Holding the launch until the marker exists makes the token write fail with EPIPE every time.
      const marker = join(dir, "stdin-closed");
      const script = join(dir, "closes-stdin.sh");
      writeFileSync(
        script,
        `#!/bin/sh\nexec 0<&-\n: > "${marker}"\nsleep 0.2\nexit 0\n`,
      );
      chmodSync(script, 0o755);
      const before = liveSidecarCount();

      await expect(
        startSidecar(script, "/tmp/unused", {
          startTimeoutMs: 5000,
          onSpawn: async () => {
            const deadline = Date.now() + 5000;
            while (!existsSync(marker) && Date.now() < deadline) {
              await Bun.sleep(5);
            }
            expect(existsSync(marker)).toBe(true);
          },
        }),
      ).rejects.toThrow(/exited \(0\) before printing its port/);

      expect(liveSidecarCount()).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("killAllSidecars leaves nothing tracked", () => {
    killAllSidecars();
    expect(liveSidecarCount()).toBe(0);
  });
});
