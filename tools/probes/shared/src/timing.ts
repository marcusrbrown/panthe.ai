// Timing helpers shared by every probe: nearest-rank percentiles for latency
// tables, and a lightweight wall-clock/CPU/RSS sampler for background
// resource tracking during a benchmark run.

/** A single point-in-time resource sample taken by a {@link Sampler}. */
export interface Sample {
  /** Milliseconds since the sampler was started. */
  readonly atMs: number;
  /** CPU time consumed since the sampler was started. */
  readonly cpu: NodeJS.CpuUsage;
  /** Resident set size in bytes at sample time. */
  readonly rss: number;
}

export interface Sampler {
  /** Begins sampling at the given interval, resetting any prior samples. */
  start(): void;
  /** Stops sampling and returns every sample recorded since `start()`. */
  stop(): readonly Sample[];
}

export interface PercentileSummary {
  readonly p50: number | undefined;
  readonly p95: number | undefined;
}

/**
 * Nearest-rank percentile over a copy of `samples` (input is never mutated).
 * Returns `undefined` for an empty sample set rather than `NaN`.
 */
export function percentile(
  samples: readonly number[],
  p: number,
): number | undefined {
  if (samples.length === 0) {
    return undefined;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index];
}

export function p50(samples: readonly number[]): number | undefined {
  return percentile(samples, 50);
}

export function p95(samples: readonly number[]): number | undefined {
  return percentile(samples, 95);
}

export function summarize(samples: readonly number[]): PercentileSummary {
  return { p50: p50(samples), p95: p95(samples) };
}

/**
 * Creates a sampler that records wall-clock time, `process.cpuUsage`, and
 * `process.memoryUsage().rss` at `intervalMs` while running.
 */
export function createSampler(intervalMs: number): Sampler {
  const samples: Sample[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let startedAtMs = 0;
  let cpuBaseline: NodeJS.CpuUsage | undefined;

  function record(): void {
    samples.push({
      atMs: performance.now() - startedAtMs,
      cpu: process.cpuUsage(cpuBaseline),
      rss: process.memoryUsage().rss,
    });
  }

  return {
    start(): void {
      samples.length = 0;
      startedAtMs = performance.now();
      cpuBaseline = process.cpuUsage();
      timer = setInterval(record, intervalMs);
    },
    stop(): readonly Sample[] {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      return samples;
    },
  };
}
