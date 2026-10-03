// Turns a set of repetitions into the tables the README records.

import type { PhaseRun, RunResult } from "./measure";
import { max, median, round } from "./stats";

export interface ConfigResult {
  readonly mortals: number;
  readonly world: "fresh" | "aged";
  readonly agedHours: number;
  readonly endToEnd: readonly RunResult[];
  readonly phases: readonly PhaseRun[];
}

/** Phases that partition the wall time of the mirror loop, and the ones nested inside the commit. */
export const OUTER = [
  "sim:routine-planning",
  "sim:step-world-tick",
  "sim:event-list-copy",
  "sim:screen-observations",
  "sim:read-pending",
  "commit:total",
  "commit:ending-total",
  "yield",
] as const;

/** In-commit pieces, measured separately from each other. */
export const INSIDE_COMMIT = [
  "sql:events",
  "sql:projection",
  "codec:decode",
  "reduce:applyEvent",
  "codec:encode",
  "json:parse-large",
  "json:stringify-large",
  "commit:on-committed",
  "sql:trace",
  "sql:other",
  "sql:transaction-control",
] as const;

function phaseMedian(runs: readonly PhaseRun[], name: string): number {
  return median(runs.map((run) => run.phases[name]?.ms ?? 0));
}

function phaseCount(runs: readonly PhaseRun[], name: string): number {
  return median(runs.map((run) => run.phases[name]?.n ?? 0));
}

/** The commit's own cost beyond its body: BEGIN, COMMIT, and the WAL write, as the median over runs. */
export function commitOverheadMs(runs: readonly PhaseRun[]): number {
  return median(
    runs.map(
      (run) =>
        (run.phases["tx:total"]?.ms ?? 0) - (run.phases["tx:body"]?.ms ?? 0),
    ),
  );
}

export function headline(result: ConfigResult): string[] {
  const e2e = result.endToEnd;
  const total = e2e.map((run) => run.totalMs);
  const gaps = e2e.flatMap((run) => run.chunkGapsMs);
  const held = result.phases.flatMap((run) => run.chunkHeldMs);
  const first = e2e[0];
  return [
    `| ${result.mortals} | ${result.world}${result.world === "aged" ? ` (${result.agedHours} h)` : ""} | ${e2e.length} | ${round(median(total) / 1000, 2)} s | ${round(Math.min(...total) / 1000, 2)}–${round(max(total) / 1000, 2)} s | ${round(median(gaps))} ms | ${round(max(gaps))} ms | ${round(median(held))} ms | ${round(max(held))} ms | ${first ? first.added.events : 0} |`,
  ];
}

export const HEADLINE_HEAD = [
  "| Mortals | World | Runs | Median hour | Range | Median chunk gap | Worst chunk gap | Median chunk held | Worst chunk held | Events |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];

/** The per-phase table for one configuration: median ms per hour, share of the instrumented hour, entries. */
export function phaseTable(result: ConfigResult): string[] {
  const runs = result.phases;
  const total = median(runs.map((run) => run.totalMs));
  const row = (label: string, ms: number, n: number, note = "") =>
    `| ${label} | ${round(ms)} | ${round((ms / total) * 100)}% | ${Math.round(n)} | ${note} |`;
  const lines = [
    "| Phase | Median ms / hour | Share | Entries | |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const name of OUTER) {
    lines.push(row(name, phaseMedian(runs, name), phaseCount(runs, name)));
  }
  lines.push(row("**instrumented hour**", total, 1));
  lines.push("| *inside the commit* | | | | |");
  for (const name of INSIDE_COMMIT) {
    lines.push(row(name, phaseMedian(runs, name), phaseCount(runs, name)));
  }
  lines.push(
    row(
      "commit overhead (BEGIN, COMMIT, WAL write)",
      commitOverheadMs(runs),
      1,
    ),
  );
  return lines;
}

export function countsTable(result: ConfigResult): string[] {
  const run = result.endToEnd[0];
  if (!run) return [];
  const a = run.added;
  const kb = (n: number) => `${round(n / 1024, 0)} KiB`;
  return [
    "| Rows added in the hour | Count | Bytes |",
    "| --- | --- | --- |",
    `| events | ${a.events} | ${kb(a.eventBytes)} |`,
    `| trace observations | ${a.observations} | ${kb(a.observationBytes)} |`,
    `| trace proposal outcomes | ${a.outcomes} | ${kb(a.outcomeBytes)} |`,
    `| trace outcome-event links | ${a.outcomeEvents} | |`,
    `| projection row (end of hour) | 1 | ${kb(a.projectionBytes)} |`,
    `| WAL peak | | ${kb(median(result.endToEnd.map((r) => r.walPeakBytes)))} |`,
    `| database file growth | | ${kb(median(result.endToEnd.map((r) => r.dbBytesAfter - r.dbBytesBefore)))} |`,
  ];
}
