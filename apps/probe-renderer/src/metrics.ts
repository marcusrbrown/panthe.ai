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

export interface ClickLatencyResolution {
  spriteId: number;
  /** Frame index (from the renderer's per-frame counter) in which the
   * highlighted sprite's new tint was first submitted via `render()`. */
  appliedFrameIndex: number;
  /** Frame index of the rAF tick that resolved the latency — always
   * `appliedFrameIndex + 1` or later, i.e. one full frame after the
   * highlight was actually committed, not merely queued. */
  resolvedFrameIndex: number;
  latencyMs: number;
}

/**
 * Click-to-visible latency, measured only for raycast HITS (a miss doesn't
 * produce a visible change, so it can't have a click-to-visible latency —
 * misses are counted separately via `markMiss`/`missCount`).
 *
 * Timing model: `markHit` records the click timestamp when a hit is
 * detected and its highlight tint is applied synchronously in the same
 * event handler, and always increments `hitCount` — a CPU-side signal
 * (pure raycast-against-transform hit-testing) that's independent of
 * whether the GPU is actually able to render anything, see below. The
 * tint mutation is picked up by whichever `render()` call happens next
 * (guaranteed, since JS is single-threaded and the mutation completes
 * before that call) — the caller reports that with
 * `noteRenderSubmitted(frameIndex)` immediately after `render()` returns.
 * That marks "the frame in which the highlight rendered", but a submitted
 * frame is not the same as a *visible* one (the browser still has to
 * composite/present it), so the latency only resolves on `resolveIfPending`
 * for the *next* frame index after that — i.e. one full frame after
 * submission, not on the submission frame itself.
 *
 * Caller contract for `noteRenderSubmitted`: only call it when the caller
 * has independent evidence that `render()` actually produced a frame —
 * e.g. gate it on a `deviceLost`-style flag the caller owns. This
 * matters because `three@0.185.1`'s `WebGPURenderer` has no automatic
 * recovery from a WebGL2 device-lost event (see
 * `tools/probes/renderer-webgl2/README.md`): `render()` keeps being
 * *called* without throwing, but silently produces nothing. Without the
 * caller's gate, a post-loss hit would still "resolve" a latency number
 * for a frame that was never actually presented — this tracker has no
 * way to detect that on its own, since it only ever sees frame indices
 * the caller reports, not GPU output.
 */
export class ClickLatencyTracker {
  private pendingSince: number | null = null;
  private pendingSpriteId: number | null = null;
  private appliedFrameIndex: number | null = null;
  private awaitingRender = false;
  private lastResolution: ClickLatencyResolution | null = null;
  /** Every raycast hit, whether or not it went on to resolve a latency —
   * proof the CPU-side hit-test keeps working even when the caller's
   * `deviceLost` gate is preventing `noteRenderSubmitted` from ever
   * resolving a new latency (see class doc comment). */
  hitCount = 0;
  missCount = 0;

  /** Call from the raycast-hit branch, after synchronously applying the highlight. */
  markHit(timestampMs: number, spriteId: number): void {
    this.hitCount += 1;
    this.pendingSince = timestampMs;
    this.pendingSpriteId = spriteId;
    this.appliedFrameIndex = null;
    this.awaitingRender = true;
  }

  /** Call from the raycast-miss branch. */
  markMiss(): void {
    this.missCount += 1;
  }

  /** Call immediately after `renderer.render()` returns, once per rAF tick
   * — but only when the caller can vouch that call actually rendered a
   * frame (see class doc comment's caller contract). */
  noteRenderSubmitted(frameIndex: number): void {
    if (this.awaitingRender) {
      this.appliedFrameIndex = frameIndex;
      this.awaitingRender = false;
    }
  }

  /** Call once per rAF tick, after `noteRenderSubmitted` for that same tick. */
  resolveIfPending(nowMs: number, frameIndex: number): void {
    if (
      this.pendingSince !== null &&
      this.pendingSpriteId !== null &&
      this.appliedFrameIndex !== null &&
      frameIndex > this.appliedFrameIndex
    ) {
      this.lastResolution = {
        spriteId: this.pendingSpriteId,
        appliedFrameIndex: this.appliedFrameIndex,
        resolvedFrameIndex: frameIndex,
        latencyMs: nowMs - this.pendingSince,
      };
      this.pendingSince = null;
      this.pendingSpriteId = null;
      this.appliedFrameIndex = null;
    }
  }

  /** Clears any in-flight (unresolved) click state — call on context loss,
   * since the highlighted sprite it refers to is about to be destroyed. */
  reset(): void {
    this.pendingSince = null;
    this.pendingSpriteId = null;
    this.appliedFrameIndex = null;
    this.awaitingRender = false;
  }

  get latestMs(): number | null {
    return this.lastResolution?.latencyMs ?? null;
  }

  get lastResolutionSnapshot(): ClickLatencyResolution | null {
    return this.lastResolution;
  }
}

/** Counts `webglcontextlost`/`webglcontextrestored` events on a canvas. */
export class ContextLossTracker {
  lostCount = 0;
  restoredCount = 0;

  attach(
    canvas: HTMLCanvasElement,
    onLost: () => void,
    onRestore: () => void,
  ): () => void {
    const handleLost = (event: Event) => {
      event.preventDefault();
      this.lostCount += 1;
      onLost();
    };
    const handleRestored = () => {
      this.restoredCount += 1;
      onRestore();
    };
    canvas.addEventListener("webglcontextlost", handleLost);
    canvas.addEventListener("webglcontextrestored", handleRestored);
    return () => {
      canvas.removeEventListener("webglcontextlost", handleLost);
      canvas.removeEventListener("webglcontextrestored", handleRestored);
    };
  }
}

export interface EffectFailure {
  effectName: string;
  error: string;
}

export interface SpriteScreenPosition {
  id: number;
  /** Canvas-relative CSS pixels of the sprite's world-space *bounding-box
   * center* (not its anchor/pivot — `anchor` can offset the pivot well
   * outside the visually opaque pixels, e.g. the static actor texture's
   * `anchor: [0.5, 0.2]`), matching the coordinate space
   * `getBoundingClientRect` uses for pointer events — use directly to
   * target a click. */
  x: number;
  y: number;
  /** `"animated"` sprites in this scene render a stroked ring (transparent
   * center) — prefer `"static"` targets (filled diamonds) when picking a
   * point to click for alpha/bounding hit-testing to land reliably. */
  kind: "static" | "animated";
}

export interface MetricsSnapshot {
  timestamp: string;
  backend: string;
  backendDetectionProperty: string;
  navigatorGpuType: string;
  userAgent: string;
  webglDebugRenderer: { vendor: string | null; renderer: string | null } | null;
  frameTime: { p50: number; p95: number; sampleCount: number };
  /** Click-to-visible latency for the most recently *resolved* hit (see
   * `ClickLatencyTracker`'s doc comment for what "resolved" means). `null`
   * until at least one hit has resolved, and — by design — stays frozen
   * at its last value across a device-lost event: `three@0.185.1`'s
   * `WebGPURenderer` never resumes rendering after a WebGL2 context loss
   * in this build, so there is no post-loss frame to time a *visible*
   * change against (see `tools/probes/renderer-webgl2/README.md`).
   * `clickHitCount` below is the metric that keeps moving after a loss. */
  clickToVisibleLatencyMs: number | null;
  /** Detail behind `clickToVisibleLatencyMs` — which sprite, and which
   * frame indices the apply/resolve happened on. Also frozen across a
   * device-lost event, for the same reason. */
  lastClickResolution: ClickLatencyResolution | null;
  /** Every raycast hit (CPU-side hit-testing against sprite transforms) —
   * keeps incrementing after a device-lost event even though
   * `clickToVisibleLatencyMs` freezes, proving hit-testing itself
   * recovers independent of whether the GPU is rendering anything. */
  clickHitCount: number;
  /** Raycast misses (clicks that hit no sprite) — these can't produce a
   * click-to-visible latency, so they're counted here instead. */
  clickMissCount: number;
  contextLoss: { lostCount: number; restoredCount: number };
  spriteCount: number;
  effectFailures: EffectFailure[];
  /** Deterministic (seeded-RNG) sprite layout means these screen positions
   * are stable across runs at a given canvas size — a debug aid for driving
   * real clicks at known sprite coordinates from outside the WebView. */
  spriteScreenPositions: SpriteScreenPosition[];
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

/**
 * Deterministic PRNG (mulberry32) — used instead of `Math.random()` for
 * sprite layout so screen positions are reproducible across runs at a
 * given canvas size (needed to drive real clicks at known sprite
 * coordinates for click-to-visible latency measurement). Not
 * cryptographic; a probe-only concern.
 */
export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return function random(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
