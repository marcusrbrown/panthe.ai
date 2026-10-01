// S12: a prayer is heard by the god it names and by no one else. Every prompt
// either god was shown so far is checked, with the real-run property, against
// every petition the world opened: none may list a petition addressed to the
// other god, and each god's own prompts do list the ones addressed to it (so the
// check can see one). The positive control injects a petition addressed to Hera
// into a prompt Zeus was shown.

import { eventsOf } from "../../../m1-living-world/src/steps/direct";
import type { StoredEvent } from "../checks";
import { analyzeReal, type RealRequest } from "../real-analysis";
import type { Recorder, Story } from "./context";
import { check, waitFor } from "./support";

const storedEvents = (story: Story): StoredEvent[] =>
  eventsOf(story).map((event) => event.payload as StoredEvent);

export async function stepPetitionPrivacy(
  recorder: Recorder,
  story: Story,
): Promise<void> {
  await recorder.run(
    "S12",
    "Prayers stay private to the god they name",
    "Over every prompt Hera and Zeus were shown, no prompt lists a petition addressed to the other god (R7, W04's divine sense), while each god's own prompts do list the petitions addressed to it; with a petition addressed to Hera injected into a prompt Zeus was shown, the check fails.",
    async (step) => {
      // Both gods have heard at least one prayer by now: mortals pray about what
      // they lack, and the farmer saw its tavern burn.
      const petitions = await waitFor(
        "the world has opened petitions to both gods",
        () => {
          const opened = storedEvents(story).filter(
            (e) => e.kind === "petition-opened",
          );
          const gods = new Set(opened.map((e) => String(e.god)));
          return gods.has("hera") && gods.has("zeus") ? opened : undefined;
        },
        { timeoutMs: 60_000, intervalMs: 200 },
      );
      const asked: RealRequest[] = story.provider.requests
        .filter((r) => r.god === "zeus" || r.god === "hera")
        .map((r) => ({
          proposalId: undefined,
          role: r.god,
          outcome: "intent",
          elapsedMs: 0,
          promptPayload: r.prompt,
          steps: [],
        }));
      // A petition addressed to Hera, injected into the last prompt Zeus was shown.
      const toHera = petitions.find((e) => String(e.god) === "hera");
      if (story.options.control === "petition-privacy" && toHera) {
        const last = asked.map((r) => r.role).lastIndexOf("zeus");
        const injected = asked[last];
        if (injected) {
          asked[last] = {
            ...injected,
            promptPayload: `${injected.promptPayload}\nPrayers to you:\n- [${toHera.id}] farmer asks for help.`,
          };
        }
      }
      const privacy = analyzeReal({
        requests: asked,
        proposals: [],
        events: storedEvents(story),
        polls: { total: 1, degraded: 0 },
      }).properties.find((p) => p.name === "petition privacy");
      check(
        privacy?.ok === true,
        "no prompt lists a petition addressed to the other god",
        privacy?.detail ?? "no such property",
      );
      // The check can see a listed petition: each god's own prompts list its own.
      const listed = (god: string) =>
        petitions
          .filter((e) => String(e.god) === god)
          .filter((e) =>
            story.provider.requests.some(
              (r) => r.god === god && r.prompt.includes(`[${e.id}]`),
            ),
          ).length;
      check(
        listed("hera") > 0 && listed("zeus") > 0,
        "each god's own prompts list a petition addressed to it",
        `hera ${listed("hera")}, zeus ${listed("zeus")}`,
      );
      step.done(
        `${petitions.length} petitions opened (${petitions.filter((e) => String(e.god) === "hera").length} to hera, ${petitions.filter((e) => String(e.god) === "zeus").length} to zeus); ${privacy?.detail}; hera's prompts list ${listed("hera")} of hers and zeus's ${listed("zeus")} of his`,
      );
    },
  );
}
