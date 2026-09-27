// M0 renderer probe metrics — rolling frame time, click-to-visible latency,
// and WebGL context loss tracking, plus a JSON dump path (console + Tauri
// `dump_metrics` command). This module has no rendering dependencies so it
// can be unit-reasoned about (and reused) independent of Scene.tsx.

const FRAME_SAMPLE_CAP = 600;

/** Rolling p50/p95 frame time tracker over the last `FRAME_SAMPLE_CAP` samples. */
export class FrameTimeTracker {
  private samples: number[] = [];

  record(deltaMs: number): void {
    this.samples.push(deltaMs);
    if (this.samples.length > FRAME_SAMPLE_CAP) {
      this.samples.shift();
    }
  }

  percentiles(): { p50: number; p95: number; sampleCount: number } {
    if (this.samples.length === 0) {
      return { p50: 0, p95: 0, sampleCount: 0 };
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    const at = (p: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
    return { p50: at(0.5), p95: at(0.95), sampleCount: sorted.length };
  }
}

/**
 * Click-to-visible latency: pointerdown timestamp -> first rAF after the
 * selection highlight has been drawn. The caller marks a pending click in
 * its pointerdown handler (after synchronously applying the highlight
 * change) and calls `resolveIfPending` once per animation frame, after the
 * frame has been rendered.
 */
export class ClickLatencyTracker {
  private pendingSince: number | null = null;
  private lastLatencyMs: number | null = null;

  markPointerDown(timestampMs: number): void {
    this.pendingSince = timestampMs;
  }

  resolveIfPending(nowMs: number): void {
    if (this.pendingSince !== null) {
      this.lastLatencyMs = nowMs - this.pendingSince;
      this.pendingSince = null;
    }
  }

  get latestMs(): number | null {
    return this.lastLatencyMs;
  }
}

/** Counts `webglcontextlost`/`webglcontextrestored` events on a canvas. */
export class ContextLossTracker {
  lostCount = 0;
  restoredCount = 0;

  attach(canvas: HTMLCanvasElement, onRestore: () => void): () => void {
    const onLost = (event: Event) => {
      event.preventDefault();
      this.lostCount += 1;
    };
    const onRestored = () => {
      this.restoredCount += 1;
      onRestore();
    };
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    return () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
    };
  }
}

export interface EffectFailure {
  effectName: string;
  error: string;
}

export interface MetricsSnapshot {
  timestamp: string;
  backend: string;
  backendDetectionProperty: string;
  navigatorGpuType: string;
  userAgent: string;
  webglDebugRenderer: { vendor: string | null; renderer: string | null } | null;
  frameTime: { p50: number; p95: number; sampleCount: number };
  clickToVisibleLatencyMs: number | null;
  contextLoss: { lostCount: number; restoredCount: number };
  spriteCount: number;
  effectFailures: EffectFailure[];
}

/** Writes the snapshot to the console and (best-effort) the Tauri `dump_metrics` command. */
export async function dumpMetrics(snapshot: MetricsSnapshot): Promise<void> {
  const json = JSON.stringify(snapshot, null, 2);
  console.log(`[probe-renderer] metrics dump:\n${json}`);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("dump_metrics", { json });
  } catch (error) {
    // Expected when running as a plain browser page (no Tauri IPC bridge).
    console.warn("[probe-renderer] dump_metrics invoke unavailable:", error);
  }
}
