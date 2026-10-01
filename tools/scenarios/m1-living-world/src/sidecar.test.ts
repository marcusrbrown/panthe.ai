import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
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
