// The automated checks of the M2 experience gate, per god per episode, as pure
// functions over what an episode's run read back from its store. They say
// whether an episode is worth the owner's time; they never score it (the
// owner scores, docs/product/acceptance.md). Thresholds are the owner's
// decisions of 2026-09-30.

import { causalChain, parseEvent, type WorldEvent } from "@panthea/contracts";
import type { StoredEvent } from "./checks";
import {
  committedInOrder,
  type RealInput,
  type RealProposal,
} from "./real-analysis";

/** A repeated choice fails on the fourth identical one in a row. */
export const REPETITION_CAP = 3;
/** Fewest committed model actions a god must take in an episode. */
export const MIN_ACTIONS = 5;

/** Actions a god's context offers whatever its profile grants. */
export const CONTEXT_ACTIONS: readonly string[] = [
  "move",
  "realm-transition",
  "report",
];

/** What the checks and the transcript need of a god's profile. */
export interface GodIdentity {
  readonly id: string;
  readonly name: string;
  readonly domains: readonly string[];
  readonly drives: Readonly<Record<string, number>>;
  readonly abilities: readonly {
    readonly name: string;
    readonly action: string;
  }[];
}

export type CheckName =
  | "profile trace"
  | "repetition"
  | "minimum activity"
  | "influence";

export interface EpisodeCheck {
  readonly name: CheckName;
  readonly ok: boolean;
  readonly detail: string;
}

export interface GodEpisode {
  readonly god: string;
  /** Committed model actions. */
  readonly actions: number;
  readonly abilityBacked: number;
  readonly contextBacked: number;
  /** The longest run of the same (kind, primary target), or undefined with no ordered action. */
  readonly longestRun:
    | { readonly length: number; readonly key: string }
    | undefined;
  /** Caused told beliefs and relationship changes. */
  readonly influence: number;
  readonly checks: readonly EpisodeCheck[];
}

export interface EpisodeAnalysis {
  readonly gods: readonly GodEpisode[];
  /** Every check of every god held. */
  readonly ok: boolean;
}

/** The target that makes two choices the same choice. */
export function primaryTarget(proposal: Record<string, unknown>): string {
  switch (proposal.kind) {
    case "move":
    case "realm-transition":
      return String(proposal.to);
    case "strike":
      return String(proposal.target);
    case "report":
      return String(proposal.listener);
    case "legend":
      return typeof proposal.linkedEventId === "string"
        ? proposal.linkedEventId
        : "legend";
    default:
      return "";
  }
}

export const choiceKey = (proposal: RealProposal): string =>
  `${proposal.kind}:${primaryTarget(proposal.proposal)}`;

function profileTrace(
  god: string,
  committed: readonly RealProposal[],
  input: RealInput,
  identity: GodIdentity | undefined,
): { check: EpisodeCheck; ability: number; context: number } {
  const name = "profile trace" as const;
  const requests = new Map(
    input.requests.flatMap((r) =>
      r.proposalId ? [[r.proposalId, r] as const] : [],
    ),
  );
  const abilityActions = new Set(identity?.abilities.map((a) => a.action));
  const problems: string[] = [];
  let ability = 0;
  let context = 0;
  if (identity === undefined) problems.push(`${god} has no profile`);
  for (const proposal of committed) {
    const request = requests.get(proposal.proposalId);
    if (request === undefined) {
      problems.push(
        `${proposal.kind} ${proposal.proposalId} has no model request`,
      );
    } else if (request.role !== god) {
      problems.push(
        `${proposal.kind} ${proposal.proposalId} was requested for role ${request.role}`,
      );
    }
    if (abilityActions.has(proposal.kind)) ability += 1;
    else if (CONTEXT_ACTIONS.includes(proposal.kind)) context += 1;
    else {
      problems.push(
        `${proposal.kind} is neither one of ${god}'s abilities nor a context action`,
      );
    }
  }
  const split = `${ability} ability-backed, ${context} context-backed`;
  return {
    ability,
    context,
    check: {
      name,
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `${committed.length} actions: ${split}`
          : `${problems.join("; ")} (${split})`,
    },
  };
}

function longestRun(
  ordered: readonly { readonly proposal: RealProposal }[],
): { length: number; key: string } | undefined {
  let best: { length: number; key: string } | undefined;
  let run: { length: number; key: string } | undefined;
  for (const { proposal } of ordered) {
    const key = choiceKey(proposal);
    run =
      run?.key === key ? { key, length: run.length + 1 } : { key, length: 1 };
    if (best === undefined || run.length > best.length) best = run;
  }
  return best;
}

/** Caused told beliefs and relationship changes, by the event kind, walked back through each one's causal chain to an event a proposal of the god caused. */
function influenceOf(
  ordered: readonly { readonly caused: readonly StoredEvent[] }[],
  events: readonly StoredEvent[],
): { count: number; kinds: string[] } {
  const rootIds = new Set(ordered.flatMap((a) => a.caused.map((e) => e.id)));
  const parsed = new Map<string, WorldEvent>();
  for (const stored of events) {
    const result = parseEvent(stored);
    if (result.ok) parsed.set(stored.id, result.value);
  }
  const kinds: string[] = [];
  for (const event of parsed.values()) {
    const felt =
      event.kind === "relationship-changed" ||
      (event.kind === "memory-recorded" && event.memoryKind === "told");
    if (!felt) continue;
    const chain = causalChain((id) => parsed.get(id), event.id);
    if (chain.some((link) => link.id !== event.id && rootIds.has(link.id))) {
      kinds.push(
        event.kind === "memory-recorded"
          ? "told belief"
          : "relationship-changed",
      );
    }
  }
  return { count: kinds.length, kinds };
}

function analyzeGod(
  god: string,
  input: RealInput,
  identity: GodIdentity | undefined,
): GodEpisode {
  const committed = input.proposals.filter(
    (p) => p.actor === god && p.outcome === "committed",
  );
  const ordered = committedInOrder(god, input.proposals, input.events);
  const trace = profileTrace(god, committed, input, identity);
  const run = longestRun(ordered);
  const influence = influenceOf(ordered, input.events);
  const kindsSeen = [...new Set(influence.kinds)].join(", ");
  return {
    god,
    actions: committed.length,
    abilityBacked: trace.ability,
    contextBacked: trace.context,
    longestRun: run,
    influence: influence.count,
    checks: [
      trace.check,
      {
        name: "repetition",
        ok: run === undefined || run.length <= REPETITION_CAP,
        detail:
          run === undefined
            ? "no ordered action"
            : `longest run ${run.length} of ${run.key} (cap ${REPETITION_CAP})`,
      },
      {
        name: "minimum activity",
        ok: committed.length >= MIN_ACTIONS,
        detail: `${committed.length} committed model actions (at least ${MIN_ACTIONS})`,
      },
      {
        name: "influence",
        ok: influence.count > 0,
        detail:
          influence.count > 0
            ? `${influence.count} caused (${kindsSeen})`
            : "no told belief or relationship change traces to this god's proposals",
      },
    ],
  };
}

export function analyzeEpisode(
  input: RealInput,
  identities: ReadonlyMap<string, GodIdentity>,
  gods: readonly string[],
): EpisodeAnalysis {
  const analyzed = gods.map((god) =>
    analyzeGod(god, input, identities.get(god)),
  );
  return {
    gods: analyzed,
    ok: analyzed.every((g) => g.checks.every((c) => c.ok)),
  };
}
