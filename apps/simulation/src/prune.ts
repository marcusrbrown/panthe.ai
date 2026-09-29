// Keeps model-request payload text for seven days. Prunes once when it
// starts, so a service that was down for a week cleans up straight away, and
// then once an hour. Digests and metadata are never pruned.

import type { Database } from "bun:sqlite";
import {
  MODEL_PAYLOAD_RETENTION_MS,
  pruneModelPayloads,
} from "@panthea/telemetry";

const ONE_HOUR_MS = 60 * 60 * 1000;

export interface ModelPayloadPruner {
  stop(): void;
}

export function startModelPayloadPruner(
  db: Database,
  options: {
    readonly intervalMs?: number;
    /** Where a failed prune is reported; it is never thrown, and the schedule keeps going. */
    readonly onError?: (error: unknown) => void;
    /** Replaces the wall clock; tests only. */
    readonly now?: () => number;
  } = {},
): ModelPayloadPruner {
  const prune = (): void => {
    try {
      pruneModelPayloads(
        db,
        MODEL_PAYLOAD_RETENTION_MS,
        options.now?.() ?? Date.now(),
      );
    } catch (error) {
      options.onError?.(error);
    }
  };
  prune();
  const timer = setInterval(prune, options.intervalMs ?? ONE_HOUR_MS);
  // A pruner must never keep the process alive on its own.
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
