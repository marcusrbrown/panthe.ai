import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLock,
  hashToken,
  readLock,
  shouldSelfTerminate,
  writeLock,
} from "./lock";

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "panthea-lock-test-"));
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
      isProcessAlive: (pid) => pid !== 111, // 111 is the stale, dead PID
    });

    expect(decision).toEqual({ kind: "reclaimed", info, staleInfo });
    expect(readLock(lockPath)).toEqual(info);
  });

  test("a lock whose recorded PID is alive refuses to start", () => {
    const holder = makeInfo({ pid: 111 });
    writeLock(lockPath, holder);

    const info = makeInfo({ pid: 222 });
    const decision = acquireLock(lockPath, info, {
      readLock,
      writeLock,
      isProcessAlive: (pid) => pid === 111, // the holder is alive
    });

    expect(decision).toEqual({ kind: "refused", holder });
    // The refused attempt must not overwrite the live holder's lock.
    expect(readLock(lockPath)).toEqual(holder);
  });

  test("a malformed lock file is treated as absent, not thrown", () => {
    writeLock(lockPath, makeInfo());
    // Corrupt the file after writing a valid one.
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
  test("a running sidecar whose recorded parent has died should self-terminate", () => {
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
    expect(hash).toHaveLength(64); // sha256 hex digest
  });
});
