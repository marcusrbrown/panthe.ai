import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  acquireLock,
  hashToken,
  openStdinSession,
  readLock,
  shouldSelfTerminate,
  startParentGuard,
  writeLock,
} from "./lifecycle";

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "panthea-sim-lifecycle-test-"));
  lockPath = join(dir, "lifecycle.lock");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeInfo(overrides: Partial<Parameters<typeof writeLock>[1]> = {}) {
  return {
    pid: 12345,
    parentPid: 999,
    tokenHash: hashToken("test-token"),
    startedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("acquireLock", () => {
  test("no existing lock acquires cleanly", () => {
    const info = makeInfo();
    const decision = acquireLock(lockPath, info, {
      readLock,
      writeLock,
      isProcessAlive: () => false,
    });
    expect(decision).toEqual({ kind: "acquired", info });
    expect(readLock(lockPath)).toEqual(info);
  });

  test("a lock whose recorded PID is dead is reclaimed", () => {
    const staleInfo = makeInfo({ pid: 111 });
    writeLock(lockPath, staleInfo);

    const info = makeInfo({ pid: 222 });
    const decision = acquireLock(lockPath, info, {
      readLock,
      writeLock,
      isProcessAlive: (pid) => pid !== 111,
    });

    expect(decision).toEqual({ kind: "reclaimed", info, staleInfo });
    expect(readLock(lockPath)).toEqual(info);
  });

  test("a lock whose recorded PID is alive refuses to start (duplicate-start refusal)", () => {
    const holder = makeInfo({ pid: 111 });
    writeLock(lockPath, holder);

    const info = makeInfo({ pid: 222 });
    const decision = acquireLock(lockPath, info, {
      readLock,
      writeLock,
      isProcessAlive: (pid) => pid === 111,
    });

    expect(decision).toEqual({ kind: "refused", holder });
    // The refused attempt must not overwrite the live holder's lock.
    expect(readLock(lockPath)).toEqual(holder);
  });

  test("a malformed lock file is treated as absent, not thrown", () => {
    writeLock(lockPath, makeInfo());
    Bun.write(lockPath, "not json");

    const info = makeInfo({ pid: 333 });
    const decision = acquireLock(lockPath, info, {
      readLock,
      writeLock,
      isProcessAlive: () => true,
    });
    expect(decision).toEqual({ kind: "acquired", info });
  });

  test("the lock file is written with 0600 permissions", () => {
    const info = makeInfo();
    writeLock(lockPath, info);
    const mode = statSync(lockPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("shouldSelfTerminate", () => {
  test("a sidecar whose recorded parent has died should self-terminate", () => {
    const info = makeInfo({ parentPid: 555 });
    expect(shouldSelfTerminate(info, () => false)).toBe(true);
  });

  test("a sidecar whose recorded parent is alive should not self-terminate", () => {
    const info = makeInfo({ parentPid: 555 });
    expect(shouldSelfTerminate(info, () => true)).toBe(false);
  });
});

describe("hashToken", () => {
  test("hashes deterministically and never returns the raw token", () => {
    const hash = hashToken("super-secret-token");
    expect(hash).not.toContain("super-secret-token");
    expect(hash).toBe(hashToken("super-secret-token"));
    expect(hash).toHaveLength(64);
  });
});

describe("openStdinSession", () => {
  test("resolves the token from stdin's first line and never leaks it through onClose alone", async () => {
    const input = new PassThrough();
    const session = openStdinSession(input);
    input.write("the-launch-token\n");
    const token = await session.token;
    expect(token).toBe("the-launch-token");

    let closed = false;
    session.onClose(() => {
      closed = true;
    });
    input.end();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(true);
  });

  test("stdin EOF before any token line resolves the token as undefined and still fires onClose", async () => {
    const input = new PassThrough();
    const session = openStdinSession(input);
    let closed = false;
    session.onClose(() => {
      closed = true;
    });
    input.end();

    const token = await session.token;
    expect(token).toBeUndefined();
    expect(closed).toBe(true);
  });

  test("only the first line is ever used as the token", async () => {
    const input = new PassThrough();
    const session = openStdinSession(input);
    input.write("first-token\n");
    input.write("second-token\n");
    input.end();
    const token = await session.token;
    expect(token).toBe("first-token");
  });
});

describe("startParentGuard", () => {
  test("calls onOrphan exactly once, the first time the parent is found dead", async () => {
    const info = makeInfo({ parentPid: 42 });
    let calls = 0;
    let alive = true;
    const guard = startParentGuard(
      info,
      () => {
        calls += 1;
      },
      5,
      () => alive,
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toBe(0);
      alive = false;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(calls).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(calls).toBe(1);
    } finally {
      guard.stop();
    }
  });

  test("stop() prevents any further poll from firing", async () => {
    const info = makeInfo({ parentPid: 42 });
    let calls = 0;
    const guard = startParentGuard(
      info,
      () => {
        calls += 1;
      },
      5,
      () => false,
    );
    guard.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(0);
  });
});
