// S1: with model routing configured, both gods take turns through the
// production path, and a wait journals nothing.

import {
  readFrame,
  waitForTicks,
} from "../../../m1-living-world/src/steps/api";
import { activeStorePath } from "../../../m1-living-world/src/world-db";
import { readModelRequests } from "../db";
import type { Recorder, Story } from "./context";
import { check, modelProposals, waitFor } from "./support";

export async function stepIdle(
  recorder: Recorder,
  story: Story,
): Promise<void> {
  await recorder.run(
    "S1",
    "Gods take idle turns through the production path",
    "With PANTHEA_MODEL_CONFIG pointing at the scripted provider, the sidecar asks each god what to do; each prompt shows that god where it stands; a wait journals nothing; the trace records each request; the world is running, not model-degraded.",
    async (step) => {
      const { provider } = story;
      await waitFor(
        "each god has taken a turn",
        () =>
          provider.requests.some((r) => r.god === "zeus") &&
          provider.requests.some((r) => r.god === "hera")
            ? true
            : undefined,
        { timeoutMs: 20_000 },
      );
      await waitForTicks(story, 3, "the world ticks while gods take turns");
      const zeus = provider.requests.find((r) => r.god === "zeus");
      const hera = provider.requests.find((r) => r.god === "hera");
      check(
        zeus?.prompt.includes("You are at Hall of the Gods [great-hall]") ===
          true &&
          hera?.prompt.includes("You are at Hall of the Gods [great-hall]") ===
            true,
        "each prompt shows the god where it stands",
        `${zeus?.prompt.slice(0, 80)} / ${hera?.prompt.slice(0, 80)}`,
      );
      check(
        modelProposals(story).length === 0,
        "a wait journals nothing",
        `${modelProposals(story).length} model proposals`,
      );
      const requests = readModelRequests(activeStorePath(story.dataDir));
      check(
        requests.length > 0 &&
          requests.every(
            (r) => r.outcome === "intent" && r.proposalId === undefined,
          ),
        "the trace holds each request, answered, with no proposal",
        JSON.stringify(requests.slice(0, 2)),
      );
      const { frame } = await readFrame(story.sidecar);
      check(
        frame.status === "running" && frame.degradedReason === undefined,
        "the world is running and not model-degraded",
        `${frame.status} ${frame.degradedReason}`,
      );
      step.done(
        `${provider.requests.length} idle turns (zeus ${provider.requests.filter((r) => r.god === "zeus").length}, hera ${provider.requests.filter((r) => r.god === "hera").length}) answered wait; trace holds ${requests.length} requests, none with a proposal; status ${frame.status}`,
        [
          {
            name: "idle turns answered",
            unit: "requests",
            value: provider.requests.length,
          },
        ],
      );
    },
  );
}
