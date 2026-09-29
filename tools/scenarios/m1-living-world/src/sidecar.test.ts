import { describe, expect, test } from "bun:test";
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

  test("killAllSidecars leaves nothing tracked", () => {
    killAllSidecars();
    expect(liveSidecarCount()).toBe(0);
  });
});
