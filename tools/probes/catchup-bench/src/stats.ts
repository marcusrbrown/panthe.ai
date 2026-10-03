import { percentile } from "@panthea/tools-probes-shared";

/** Median of `values`; 0 for none. */
export function median(values: readonly number[]): number {
  return percentile(values, 50) ?? 0;
}

export function max(values: readonly number[]): number {
  return values.reduce((a, b) => (b > a ? b : a), 0);
}

export const round = (n: number, digits = 1) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};
