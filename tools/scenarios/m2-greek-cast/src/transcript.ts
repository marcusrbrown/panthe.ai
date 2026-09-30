// The owner's reading material for the M2 experience gate: one markdown
// transcript per episode and a summary across them. They show what happened
// and what the automated checks found, and leave the rubric and the decision
// blank: the owner scores (docs/product/acceptance.md), the tool never does.

import type { WorldEvent } from "@panthea/contracts";
import type { StoredEvent } from "./checks";
import {
  CONTEXT_ACTIONS,
  choiceKey,
  type EpisodeAnalysis,
  type GodIdentity,
  influencedBy,
  parseEvents,
  primaryTarget,
  REPETITION_CAP,
} from "./episode-analysis";
import {
  committedInOrder,
  type RealAnalysis,
  type RealInput,
} from "./real-analysis";

export interface EpisodeSettings {
  readonly model: string;
  readonly seconds: number;
  readonly ranAt: string;
  readonly ticks: number;
  readonly hardware: string;
}

export interface EpisodeRecord {
  readonly index: number;
  readonly total: number;
  readonly settings: EpisodeSettings;
  /** The gods that took turns, with their profiles, in the order they are shown. */
  readonly identities: readonly GodIdentity[];
  readonly input: RealInput;
  readonly analysis: RealAnalysis;
  readonly episode: EpisodeAnalysis;
}

export interface ActionEntry {
  readonly tick: number;
  readonly sequence: number;
  readonly god: string;
  /** What was done and to what, e.g. `move → olympus-gate`. */
  readonly verb: string;
  readonly backing: "ability-backed" | "context-backed" | "unbacked";
  /** The model's own words: a report's content or a legend's assertion. */
  readonly text: string | undefined;
  readonly claim: string | undefined;
  /** The events the proposal itself caused. */
  readonly caused: readonly string[];
  /** The memories and feelings that followed from them. */
  readonly changes: readonly string[];
}

const tickOf = (eventId: string): number =>
  Number(/^evt-(\d+)-/.exec(eventId)?.[1] ?? 0);

const signed = (value: unknown): string =>
  `${Number(value) > 0 ? "+" : ""}${String(value)}`;

function describeChange(
  event: Extract<WorldEvent, { kind: "relationship-changed" }>,
): string {
  return `${event.entityId} → ${event.toward}: affinity ${signed(event.affinityDelta)}${event.grudgeDelta > 0 ? `, grudge +${event.grudgeDelta}` : ""}${event.allied === true ? ", allied" : event.allied === false ? ", no longer allied" : ""}`;
}

function describeCaused(event: StoredEvent): string {
  if (event.kind === "report-told") {
    return `report-told (${String(event.entityId)} → ${String(event.listenerId)})`;
  }
  return typeof event.entityId === "string"
    ? `${String(event.kind)} (${event.entityId})`
    : String(event.kind);
}

function describeClaim(claim: unknown): string | undefined {
  if (typeof claim !== "object" || claim === null) return undefined;
  const c = claim as Record<string, unknown>;
  return `${String(c.effect)} by ${String(c.agent)}${typeof c.target === "string" ? ` on ${c.target}` : ""}`;
}

/** Every committed model action of the gods, in the order the world applied them. */
/**
 * Every committed model action of the gods, in the order the world applied
 * them. What followed from an action is attributed by immediate cause, as the
 * influence check does (`influencedBy`): a belief goes under the action whose
 * report it rests on, and a feeling under the action behind the belief it
 * cites, never through a report's `linkedEventId`. A witnessed memory goes
 * under the action that caused the event witnessed, since the witness saw
 * that happen.
 */
export function buildActions(record: EpisodeRecord): ActionEntry[] {
  const { events, proposals } = record.input;
  const parsed = parseEvents(events);

  const entries: ActionEntry[] = [];
  for (const identity of record.identities) {
    const abilities = new Set(identity.abilities.map((a) => a.action));
    for (const action of committedInOrder(identity.id, proposals, events)) {
      const { proposal, caused, sequence } = action;
      const changes: string[] = [];
      for (const event of influencedBy(caused, parsed)) {
        if (event.kind === "relationship-changed") {
          changes.push(describeChange(event));
        } else if (
          event.kind === "memory-recorded" &&
          event.memoryKind === "told"
        ) {
          changes.push(
            `${event.entityId} now believes ${event.teller}: "${event.content}"`,
          );
        }
      }
      const causedIds = new Set(caused.map((e) => e.id));
      const witnessed = new Map<string, string[]>();
      for (const event of parsed.values()) {
        if (
          event.kind === "memory-recorded" &&
          event.memoryKind === "witnessed" &&
          causedIds.has(event.sourceEventId)
        ) {
          const owners = witnessed.get(event.eventKind) ?? [];
          owners.push(event.entityId);
          witnessed.set(event.eventKind, owners);
        }
      }
      for (const [kind, owners] of witnessed) {
        changes.push(
          `${owners.join(", ")} ${owners.length === 1 ? "remembers" : "remember"} ${kind}`,
        );
      }
      // A feeling that comes of a witnessed memory goes under the same action
      // as that memory: the witness felt it because of what it saw.
      for (const event of parsed.values()) {
        if (event.kind !== "relationship-changed") continue;
        const memory = parsed.get(event.memoryEventId);
        if (
          memory?.kind === "memory-recorded" &&
          memory.memoryKind === "witnessed" &&
          causedIds.has(memory.sourceEventId)
        ) {
          changes.push(describeChange(event));
        }
      }

      const fields = proposal.proposal;
      const target = primaryTarget(fields);
      entries.push({
        tick: tickOf(caused[0]?.id ?? ""),
        sequence,
        god: identity.id,
        verb:
          proposal.kind === "legend" && target === "legend"
            ? "legend"
            : `${proposal.kind} → ${target}`,
        backing: abilities.has(proposal.kind)
          ? "ability-backed"
          : CONTEXT_ACTIONS.includes(proposal.kind)
            ? "context-backed"
            : "unbacked",
        text:
          typeof fields.content === "string"
            ? fields.content
            : typeof fields.assertion === "string"
              ? fields.assertion
              : undefined,
        claim: describeClaim(fields.claim),
        caused: caused.map(describeCaused),
        changes,
      });
    }
  }
  return entries.sort((a, b) => a.sequence - b.sequence);
}

const nameOf = (record: EpisodeRecord, god: string): string =>
  record.identities.find((i) => i.id === god)?.name ?? god;

function renderGod(identity: GodIdentity): string {
  const drives = Object.entries(identity.drives)
    .map(([drive, weight]) => `${drive} ${weight}`)
    .join(", ");
  const powers = identity.abilities
    .map((a) => `${a.name} (${a.action})`)
    .join(", ");
  return [
    `### ${identity.name}`,
    "",
    `- Domains: ${identity.domains.join(", ")}`,
    `- Drives: ${drives}`,
    `- Powers: ${powers}; and, for any god, ${CONTEXT_ACTIONS.join(", ")}`,
  ].join("\n");
}

function renderAction(
  entry: ActionEntry,
  index: number,
  record: EpisodeRecord,
) {
  const lines = [
    `${index + 1}. **tick ${entry.tick}, ${nameOf(record, entry.god)}:** ${entry.verb} (${entry.backing})`,
  ];
  if (entry.text !== undefined) lines.push(`   - says: "${entry.text}"`);
  if (entry.claim !== undefined) lines.push(`   - claim: ${entry.claim}`);
  if (entry.caused.length > 0)
    lines.push(`   - caused: ${entry.caused.join("; ")}`);
  for (const change of entry.changes) lines.push(`   - then: ${change}`);
  return lines.join("\n");
}

function renderRepetition(record: EpisodeRecord): string {
  return record.episode.gods
    .map((g) => {
      const counts = new Map<string, number>();
      for (const { proposal } of committedInOrder(
        g.god,
        record.input.proposals,
        record.input.events,
      )) {
        const key = choiceKey(proposal);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const top = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([key, n]) => `${key} ×${n}`)
        .join(", ");
      return `- ${nameOf(record, g.god)}: longest run ${g.longestRun ? `${g.longestRun.length} of ${g.longestRun.key}` : "none"} (cap ${REPETITION_CAP}). Choices: ${top || "none"}`;
    })
    .join("\n");
}

function renderChecks(record: EpisodeRecord): string {
  const rows = record.episode.gods.flatMap((g) =>
    g.checks.map(
      (c) =>
        `| ${nameOf(record, g.god)} | ${c.name} | ${c.ok ? "pass" : "FAIL"} | ${c.detail.replaceAll("|", "/")} |`,
    ),
  );
  return [
    "| God | Check | Result | Detail |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function renderModelRun(record: EpisodeRecord): string {
  const a = record.analysis;
  return [
    `- ${a.requests.total} requests: ${a.requests.intent} answered (${a.requests.native} native, ${a.requests.repaired} repaired), ${a.requests.exhausted} exhausted; latency p50 ${a.latencyMs.p50} ms, p95 ${a.latencyMs.p95} ms; frames showed model-degraded in ${(a.degradedShare * 100).toFixed(0)}% of polls`,
    ...(a.exhaustion.length > 0
      ? [
          `- exhaustion: ${a.exhaustion.map((e) => `${e.count} × ${e.detail}`).join("; ")}`,
        ]
      : []),
    ...a.properties.map(
      (p) => `- ${p.name}: ${p.ok ? "held" : "FAILED"} (${p.detail})`,
    ),
  ].join("\n");
}

const RUBRIC = [
  "Novelty",
  "Causality",
  "Recognizable identity",
  "Pacing",
  "Inspectability",
];

export function renderTranscript(record: EpisodeRecord): string {
  const { settings } = record;
  const actions = buildActions(record);
  return [
    `# Episode ${record.index} of ${record.total}`,
    "",
    "## Settings",
    "",
    `- Recorded: ${settings.ranAt}`,
    `- Model: ${settings.model} through local Ollama, 4K context`,
    `- Length: ${settings.seconds} s (${settings.ticks} ticks)`,
    "- World: a fresh world from the initial authored Greek state; no fixtures, no seeds",
    `- Machine: ${settings.hardware}`,
    "",
    "## Gods",
    "",
    record.identities.map(renderGod).join("\n\n"),
    "",
    "## What happened",
    "",
    actions.length === 0
      ? "No god took a committed action."
      : actions.map((entry, i) => renderAction(entry, i, record)).join("\n"),
    "",
    "## Repetition",
    "",
    renderRepetition(record),
    "",
    "## Automated checks",
    "",
    renderChecks(record),
    "",
    "## Model run",
    "",
    renderModelRun(record),
    "",
    "## Owner rubric",
    "",
    "Score each 0, 1, or 2: 0 = replan pressure, 1 = needs tuning, 2 = good enough to continue. The owner scores; nothing above is a score.",
    "",
    "| Dimension | Score (0/1/2) | Notes |",
    "| --- | --- | --- |",
    ...RUBRIC.map((dimension) => `| ${dimension} |  |  |`),
    "",
    "Decision: continue / tune / replan: ",
    "",
  ].join("\n");
}

export interface SummarySettings {
  readonly seconds: number;
  readonly model: string;
  /** Transcript file names, in episode order. */
  readonly files: readonly string[];
}

export function renderSummary(
  records: readonly EpisodeRecord[],
  settings: SummarySettings,
): string {
  const checkRows = records.flatMap((record) =>
    record.episode.gods.map((g) => {
      const failed = g.checks.filter((c) => !c.ok).map((c) => c.name);
      return `| ${record.index} | ${nameOf(record, g.god)} | ${g.actions} (${g.abilityBacked} ability, ${g.contextBacked} context) | ${g.longestRun?.length ?? 0} | ${g.influence} | ${failed.length === 0 ? "pass" : `FAIL: ${failed.join(", ")}`} |`;
    }),
  );
  const failures = records.flatMap((record) => [
    ...record.episode.gods.flatMap((g) =>
      g.checks
        .filter((c) => !c.ok)
        .map(
          (c) =>
            `episode ${record.index}, ${nameOf(record, g.god)}: ${c.name} (${c.detail})`,
        ),
    ),
    ...record.analysis.properties
      .filter((p) => !p.ok)
      .map((p) => `episode ${record.index}, property ${p.name} (${p.detail})`),
  ]);
  const runRows = records.map((record) => {
    const a = record.analysis;
    const held = a.properties.filter((p) => p.ok).length;
    return `| ${record.index} | ${a.requests.total} | ${a.requests.exhausted} | ${(a.degradedShare * 100).toFixed(0)}% | ${a.latencyMs.p50} / ${a.latencyMs.p95} ms | ${held} of ${a.properties.length} held |`;
  });
  return [
    "# M2 experience gate",
    "",
    `- Model: ${settings.model} through local Ollama, 4K context`,
    `- ${records.length} episodes of ${settings.seconds} s, each a fresh world from the initial authored Greek state; no fixtures, no seeds`,
    "",
    "## Automated checks",
    "",
    "| Episode | God | Committed actions | Longest run | Told beliefs and feelings caused | Checks |",
    "| --- | --- | --- | --- | --- | --- |",
    ...checkRows,
    "",
    failures.length === 0
      ? "All automated checks and real-run properties held."
      : `Automated checks failed:\n\n${failures.map((f) => `- ${f}`).join("\n")}`,
    "",
    "## Model runs",
    "",
    "| Episode | Requests | Exhausted | Degraded polls | Latency p50 / p95 | Properties |",
    "| --- | --- | --- | --- | --- | --- |",
    ...runRows,
    "",
    "## Transcripts",
    "",
    ...settings.files.map((file) => `- [${file}](${file})`),
    "",
    "## Owner",
    "",
    "Scores are in each transcript's rubric. The owner scores; the tool never does.",
    "",
    "Decision: continue / tune / replan: ",
    "",
  ].join("\n");
}
