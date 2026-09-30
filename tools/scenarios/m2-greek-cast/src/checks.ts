// Pure checks the M2 scenario runs on what it observed. Nothing here touches a
// process, a socket, or a database, so each one has a unit test with a
// positive control (`checks.test.ts`).

import { causalChain, parseEvent, type WorldEvent } from "@panthea/contracts";
import { canonicalJson } from "../../m1-living-world/src/helpers";

/** The traces, out of `traces`, that `prompt` carries: what a knowledge-isolation check is looking for. */
export function tracesIn(
  prompt: string,
  traces: readonly string[],
): readonly string[] {
  return traces.filter((trace) => prompt.includes(trace));
}

/** Whether a scripted reply is the god doing nothing. */
export function isWait(reply: string): boolean {
  try {
    return (JSON.parse(reply) as { action?: unknown }).action === "wait";
  } catch {
    return false;
  }
}

/** The part of a decoded world state that memory and feeling live in. */
export interface RememberedView {
  readonly memories: ReadonlyMap<string, readonly unknown[]>;
  readonly relationships: ReadonlyMap<string, unknown>;
}

/**
 * How `branch` differs from `live` in what anyone remembers or feels: one
 * line per actor whose memories differ and per relationship that differs or is
 * missing on either side. Empty when a restore kept both exactly.
 */
export function differences(
  live: RememberedView,
  branch: RememberedView,
): readonly string[] {
  const found: string[] = [];
  const owners = new Set([...live.memories.keys(), ...branch.memories.keys()]);
  for (const owner of [...owners].sort()) {
    if (
      canonicalJson(live.memories.get(owner) ?? []) !==
      canonicalJson(branch.memories.get(owner) ?? [])
    ) {
      found.push(`memories of ${owner} differ`);
    }
  }
  const keys = new Set([
    ...live.relationships.keys(),
    ...branch.relationships.keys(),
  ]);
  for (const key of [...keys].sort()) {
    if (
      canonicalJson(live.relationships.get(key)) !==
      canonicalJson(branch.relationships.get(key))
    ) {
      found.push(`relationship ${key} differs`);
    }
  }
  return found;
}

/** An event as the store holds it: its full payload, parsed from JSON. */
export type StoredEvent = Record<string, unknown> & { readonly id: string };

/**
 * The kinds of the events that led to `eventId`, root first, walked from the
 * event log alone (no trace): what a restored branch, which has no trace rows,
 * can still explain.
 */
export function explainChain(
  events: readonly StoredEvent[],
  eventId: string,
): readonly string[] {
  const parsed = new Map<string, WorldEvent>();
  for (const stored of events) {
    const result = parseEvent(stored);
    if (result.ok) parsed.set(stored.id, result.value);
  }
  return causalChain((id) => parsed.get(id), eventId as WorldEvent["id"]).map(
    (event) => event.kind,
  );
}
