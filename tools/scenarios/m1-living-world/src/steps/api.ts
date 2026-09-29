// Helpers over the running sidecar's HTTP API: the committed frame, proposal
// intake, and the trace queries. Everything a step can learn from an
// endpoint goes through here; facts no endpoint exposes are read from the
// store in `direct.ts`.

import { createObservationId, parseSyncFrame } from "@panthea/contracts";
import { createProposalId, type FollowResult } from "@panthea/telemetry";
import { decode, type WorldState } from "@panthea/world";
import { check, type FixtureValues, instantiate, waitFor } from "../helpers";
import type { Sidecar } from "../sidecar";
import type { Story } from "./context";

export const FRAME_TIMEOUT_MS = 10_000;

export const fmt = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

/** The latest committed frame, parsed through contracts, with its decoded world state. */
export async function readFrame(sidecar: Sidecar) {
  const response = await sidecar.request("GET", "/frame");
  check(
    response.status === 200,
    "GET /frame answers",
    `status ${response.status}`,
  );
  const parsed = parseSyncFrame(response.body);
  check(
    parsed.ok,
    "the frame parses through contracts",
    parsed.ok ? "" : `${parsed.path}: ${parsed.message}`,
  );
  const state: WorldState = decode(parsed.value.state);
  return { frame: parsed.value, state };
}

/** Waits until the committed tick has advanced by `count`, and returns the tick reached. */
export async function waitForTicks(
  story: Story,
  count: number,
  why: string,
): Promise<number> {
  const start = (await readFrame(story.sidecar)).state.tick;
  return waitFor(
    why,
    async () => {
      const tick = (await readFrame(story.sidecar)).state.tick;
      return tick >= start + count ? tick : undefined;
    },
    { timeoutMs: 15_000 + count * 1000, intervalMs: 50 },
  );
}

export async function waitForLog(
  sidecar: Sidecar,
  text: string,
  why: string,
): Promise<void> {
  await waitFor(why, () => (sidecar.log().includes(text) ? true : undefined), {
    timeoutMs: 60_000,
    intervalMs: 20,
  });
}

export async function stopClean(story: Story, why: string): Promise<void> {
  const code = await story.sidecar.stop("SIGTERM");
  check(code === 0, why, `exit code ${code}`);
}

/** Instantiates a fixture against the latest committed frame and posts it under a fresh producer-generated proposal id. */
export async function postFixture(
  story: Story,
  template: unknown,
  extra: FixtureValues = {},
  proposalId: string = createProposalId(),
) {
  const { frame } = await readFrame(story.sidecar);
  const observationId = createObservationId();
  const body = instantiate(template, {
    $observationId: observationId,
    $sequence: frame.sequence,
    ...extra,
  });
  const envelope = { proposalId, ...(body as object) } as {
    proposalId: string;
    observation: unknown;
    proposal: unknown;
  };
  const response = await story.sidecar.request("POST", "/proposals", envelope);
  return {
    proposalId,
    observationId,
    envelope,
    status: response.status,
    body: response.body,
  };
}

export interface TracedOutcome {
  readonly proposalId: string;
  readonly outcome: "committed" | "rejected";
  readonly reason: string | undefined;
  /** Every event the proposal committed, in order. */
  readonly eventIds: readonly string[];
  readonly steps: FollowResult["steps"];
}

const encode = encodeURIComponent;

/** The proposal's recorded outcome as `/trace/proposal` reports it, once the tick that took it has committed. */
export async function outcomeOf(
  story: Story,
  proposalId: string,
  why: string,
): Promise<TracedOutcome> {
  return waitFor(
    why,
    async () => {
      const response = await story.sidecar.request(
        "GET",
        `/trace/proposal?id=${encode(proposalId)}`,
      );
      if (response.status !== 200) return undefined;
      const { result } = response.body as { result: FollowResult };
      if (!result.found) return undefined;
      const validation = result.steps.find(
        (entry) => entry.step === "validation",
      );
      if (validation?.step !== "validation") return undefined;
      return {
        proposalId,
        outcome: validation.outcome,
        reason: validation.reason,
        eventIds: result.steps.flatMap((entry) =>
          entry.step === "event" ? [entry.eventId] : [],
        ),
        steps: result.steps,
      };
    },
    { timeoutMs: FRAME_TIMEOUT_MS, intervalMs: 100 },
  );
}

async function getJson(sidecar: Sidecar, path: string) {
  const response = await sidecar.request("GET", path);
  check(
    response.status === 200,
    `GET ${path.split("?")[0]} answers`,
    `status ${response.status} ${fmt(response.body)}`,
  );
  return response.body as { ok: boolean; result: FollowResult };
}

/** `GET /trace/event`: the causal chain of one committed event, through its presentation receipts. */
export async function traceEvent(story: Story, eventId: string) {
  return (await getJson(story.sidecar, `/trace/event?id=${encode(eventId)}`))
    .result;
}

/** `GET /trace/proposal`: the causal chain of one proposal, through every event it committed. */
export async function traceProposal(story: Story, proposalId: string) {
  return (
    await getJson(story.sidecar, `/trace/proposal?id=${encode(proposalId)}`)
  ).result;
}

export interface ReceiptSeen {
  readonly sessionId: string;
  readonly presentedAtMs: number;
}

/** The earliest presentation receipt the trace holds for `eventId`, or undefined when none is stored. */
export async function receiptOf(
  story: Story,
  eventId: string | undefined,
): Promise<ReceiptSeen | undefined> {
  if (eventId === undefined) return undefined;
  const chain = await traceEvent(story, eventId);
  const receipt = chain.steps.find((entry) => entry.step === "receipt");
  return receipt?.step === "receipt"
    ? { sessionId: receipt.sessionId, presentedAtMs: receipt.presentedAtMs }
    : undefined;
}

/**
 * Whether the service holds any record of `proposalId`. A proposal is
 * journaled when a retry of its envelope is answered as a known proposal
 * (202 pending, or 200 with its terminal status); a proposal refused at
 * intake is refused again. It is traced when `/trace/proposal` finds a chain.
 */
export async function knowsProposal(
  story: Story,
  proposalId: string,
  envelope: unknown,
) {
  const retry = await story.sidecar.request("POST", "/proposals", envelope);
  const journaled = retry.status === 200 || retry.status === 202;
  const response = await story.sidecar.request(
    "GET",
    `/trace/proposal?id=${encode(proposalId)}`,
  );
  const traced =
    response.status === 200 &&
    (response.body as { result: FollowResult }).result.found;
  return { journaled, traced };
}
