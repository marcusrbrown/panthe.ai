// Regression test for the renderer frame-stats offset bug (non-blocking nit
// from PR #19): `sampleRendererFrameStats` must only parse dumps appended
// AFTER a keystroke attempt, never a stale `frameTime` block left over in
// the log from an earlier dump. `parseFrameStatsSince` is the extracted,
// exported pure function that does the offset-bounded parse — this test
// exercises it directly against a pre-seeded log file so it never has to
// invoke the real OS-level keystroke path (osascript/cliclick), which would
// be flaky in a headless CI environment.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrameStatsSince } from "./run";

function frameDump(p50: number, p95: number, sampleCount: number): string {
  return `[metrics] {"frameTime":{"p50":${p50},"p95":${p95},"sampleCount":${sampleCount}}}\n`;
}

describe("parseFrameStatsSince: offset-bounded frame-stats parsing", () => {
  test("a stale dump present before the offset is not reported when nothing new was appended", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "inference-baseline-frame-"));
    try {
      const logPath = join(tempDir, "renderer.stdout.log");
      // Pre-seed the log with an old dump from an earlier sample call.
      writeFileSync(logPath, frameDump(11, 15, 120));

      // Capture the offset the way sampleRendererFrameStats does: log
      // length *before* attempting the keystroke.
      const before = readFileSync(logPath, "utf8");
      const offset = before.length;

      // Simulate both keystroke paths silently no-op'ing: nothing new is
      // appended to the log (the exact failure mode the bug report
      // describes — a real app not present/frontmost to receive the key).
      const after = readFileSync(logPath, "utf8");

      // Pre-fix behavior called parseFrameStatsFromLog(after) unconditionally,
      // which would find and return the stale {p50:11,p95:15,sampleCount:120}
      // block via lastIndexOf even though it predates this call's attempt.
      expect(parseFrameStatsSince(after, offset)).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("a fresh dump appended after the offset is parsed correctly, not the earlier stale one", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "inference-baseline-frame-"));
    try {
      const logPath = join(tempDir, "renderer.stdout.log");
      writeFileSync(logPath, frameDump(11, 15, 120));

      const offset = readFileSync(logPath, "utf8").length;

      // Simulate the app producing a fresh dump in response to the keystroke.
      const existing = readFileSync(logPath, "utf8");
      writeFileSync(logPath, existing + frameDump(20, 30, 240));

      const after = readFileSync(logPath, "utf8");
      const stats = parseFrameStatsSince(after, offset);

      expect(stats).toEqual({ p50: 20, p95: 30, sampleCount: 240 });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("no dump anywhere after the offset returns undefined even with content growth", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "inference-baseline-frame-"));
    try {
      const logPath = join(tempDir, "renderer.stdout.log");
      writeFileSync(logPath, frameDump(11, 15, 120));
      const offset = readFileSync(logPath, "utf8").length;

      // Log grows (e.g. unrelated app output) but no new frameTime dump.
      const existing = readFileSync(logPath, "utf8");
      writeFileSync(logPath, `${existing}[log] some unrelated line\n`);

      const after = readFileSync(logPath, "utf8");
      expect(parseFrameStatsSince(after, offset)).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
