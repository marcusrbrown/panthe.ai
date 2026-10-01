// Constructed episode data for the analysis and transcript tests: gods,
// committed proposals with the events they caused, and derived memory events.

import type { GodIdentity } from "./episode-analysis";
import type { RealInput, RealProposal, RealRequest } from "./real-analysis";

export const identities = new Map<string, GodIdentity>([
  [
    "zeus",
    {
      id: "zeus",
      name: "Zeus",
      domains: ["sky"],
      drives: { sovereignty: 0.9 },
      abilities: [
        { name: "Thunderbolt", action: "strike" },
        { name: "Pronouncement", action: "legend" },
      ],
    },
  ],
  [
    "hera",
    {
      id: "hera",
      name: "Hera",
      domains: ["marriage"],
      drives: { order: 0.8 },
      abilities: [{ name: "Tale of a Grievance", action: "legend" }],
    },
  ],
]);

let n = 0;
/** One committed god proposal and the event it caused, at `sequence`. */
export function act(
  actor: string,
  fields: Record<string, unknown>,
  sequence: number,
  over: { role?: string | null; outcome?: "committed" | "rejected" } = {},
) {
  n += 1;
  const proposalId = `p${n}`;
  const observationId = `obs-${n}`;
  const proposal: RealProposal = {
    proposalId,
    actor,
    kind: String(fields.kind),
    observationId,
    proposal: { actor, ...fields },
    outcome: over.outcome ?? "committed",
  };
  const request: RealRequest | undefined =
    over.role === null
      ? undefined
      : {
          proposalId,
          role: over.role ?? actor,
          outcome: "intent",
          elapsedMs: 1000,
          promptPayload: "prompt",
          steps: [{ mode: "native" }],
        };
  const eventKind =
    fields.kind === "report"
      ? "report-told"
      : fields.kind === "legend"
        ? "legend-recorded"
        : fields.kind === "goal"
          ? "goal-set"
          : "entity-moved";
  const event = {
    schemaVersion: 1,
    id: `evt-${sequence}-${sequence}`,
    sequence,
    simTime: 0,
    correlationId: observationId,
    causationId: observationId,
    approximate: false,
    kind: eventKind,
    entityId: actor,
    ...(fields.kind === "report"
      ? {
          listenerId: fields.listener,
          content: fields.content,
          ...(fields.linkedEventId === undefined
            ? {}
            : { linkedEventId: fields.linkedEventId }),
        }
      : fields.kind === "legend"
        ? {
            assertion: fields.assertion,
            hearers: fields.hearers ?? [],
            ...(fields.claim === undefined ? {} : { claim: fields.claim }),
          }
        : fields.kind === "goal"
          ? {
              text:
                (fields.goal as { set?: { text: string } })?.set?.text ??
                "A goal.",
              target:
                (fields.goal as { set?: { target: string } })?.set?.target ??
                "zeus",
            }
          : { from: "here", to: "there" }),
  };
  return { proposal, request, event };
}

export function input(
  acts: ReturnType<typeof act>[],
  extraEvents: Record<string, unknown>[] = [],
): RealInput {
  return {
    requests: acts.flatMap((a) => (a.request ? [a.request] : [])),
    proposals: acts.map((a) => a.proposal),
    events: [...acts.map((a) => a.event), ...extraEvents].sort(
      (a, b) => Number(a.sequence) - Number(b.sequence),
    ) as RealInput["events"],
    polls: { total: 10, degraded: 0 },
  };
}

export const move = (actor: string, to: string, sequence: number) =>
  act(actor, { kind: "move", to }, sequence);

export const memoryEvent = (
  id: string,
  sequence: number,
  fields: Record<string, unknown>,
) => ({
  schemaVersion: 1,
  id,
  sequence,
  simTime: 0,
  correlationId: "tick-1",
  causationId: "x",
  approximate: false,
  kind: "memory-recorded",
  subjects: [],
  salience: 4,
  ...fields,
});

/** A goal-set event by `actor`, as the log holds it. */
export const goalSetEvent = (
  id: string,
  sequence: number,
  actor: string,
  text = "A goal.",
  target = "zeus",
) => ({
  schemaVersion: 1,
  id,
  sequence,
  simTime: 0,
  correlationId: `obs-${id}`,
  causationId: `obs-${id}`,
  approximate: false,
  kind: "goal-set",
  entityId: actor,
  text,
  target,
});

/** A goal-ended event by `actor`, ending the goal set by `goalEventId`. */
export const goalEndedEvent = (
  id: string,
  sequence: number,
  actor: string,
  goalEventId: string,
  outcome = "achieved",
) => ({
  schemaVersion: 1,
  id,
  sequence,
  simTime: 0,
  correlationId: `obs-${id}`,
  causationId: `obs-${id}`,
  approximate: false,
  kind: "goal-ended",
  entityId: actor,
  outcome,
  goalEventId,
});
