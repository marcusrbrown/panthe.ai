// S16: supplication through the compiled sidecar. Two mortals have prayed; a
// god answers each by offering terms (its boon for one offering by the mortal),
// the mortal's routine takes them by drive and means, the god gives the boon,
// and the world judges both halves. One mortal keeps its terms and the thread
// is fulfilled. The other takes the boon and does not offer: the thread is
// breached, and the stake the god chose turns it into a wolf, with its memory,
// feelings, and identity kept.
//
// The scripted part is the gods' choices; the mortals decide for themselves.

import { type Petition, type PracticeThread, toEntityId } from "@panthea/world";
import type { Recorder, Story } from "./context";
import {
  eventsOfKind,
  godMoves,
  threadAfter,
  threadEnded,
  threadNow,
  threadsOf,
  walkTo,
} from "./practice";
import { check, postFixture, stateOf, waitFor } from "./support";

const id = toEntityId;

/** What S16 hands on: the two supplication threads. */
export interface Supplications {
  readonly keptId: string;
  readonly brokenId: string;
}

const currencyOf = async (story: Story, mortal: string) =>
  (await stateOf(story)).actors.get(id(mortal))?.inventory.get("currency") ?? 0;

/** Open help petitions, newest last. */
async function openHelp(story: Story): Promise<Petition[]> {
  const state = await stateOf(story);
  return [...state.petitions.values()].filter(
    (petition) =>
      petition.status === "open" &&
      petition.request.kind === "help" &&
      state.actors.get(petition.god)?.alive === true &&
      state.actors.get(petition.petitioner)?.alive === true,
  );
}

const otherGod = (god: string) => (god === "hera" ? "zeus" : "hera");

/** The offer a god makes on a prayer: one offering by the one who prayed, to the god. */
const offerOn = (
  petition: Petition,
  amount: number,
  ticks: number,
  stake?: string,
) =>
  JSON.stringify({
    action: "practice",
    move: "offer",
    prayer: petition.id,
    term: {
      kind: "make-offering",
      party: petition.petitioner,
      to: petition.god,
      resource: "currency",
      amount,
      deadlineTicks: ticks,
    },
    ...(stake === undefined ? {} : { stake }),
  });

/** The god stands with the mortal and blesses it; returns the blessing's event id. */
async function giveBoon(
  story: Story,
  petition: Petition,
  why: string,
): Promise<string> {
  const mortal = (await stateOf(story)).actors.get(petition.petitioner);
  check(mortal !== undefined, `${petition.petitioner} is somewhere`, "gone");
  await walkTo(story, petition.god as "zeus" | "hera", mortal.locationId);
  const row = await godMoves(
    story,
    petition.god as "zeus" | "hera",
    JSON.stringify({ action: "bless", petition: petition.id }),
    why,
  );
  const blessing = eventsOfKind(
    story,
    "blessing-granted",
    (e) => e.correlationId === String(row.proposal.observationId),
  )[0];
  check(blessing !== undefined, `${why}: a blessing is recorded`, "none");
  return blessing.id;
}

/** The god offers terms and the mortal's own routine takes them. */
async function offerTerms(
  story: Story,
  petition: Petition,
  amount: number,
  ticks: number,
  stake?: string,
): Promise<PracticeThread> {
  const earlier = threadsOf(await stateOf(story)).map((t) => t.id as string);
  await godMoves(
    story,
    petition.god as "zeus" | "hera",
    offerOn(petition, amount, ticks, stake),
    `${petition.god} offers ${petition.petitioner} terms`,
  );
  const thread = await threadAfter(story, earlier, "the offer opens a thread");
  check(
    thread.practice === "supplication" &&
      thread.petition === petition.id &&
      thread.demander === petition.god &&
      thread.obligated === petition.petitioner &&
      thread.status === "open" &&
      thread.counterBudgetLeft === 0 &&
      thread.term.kind === "make-offering" &&
      thread.term.party === petition.petitioner &&
      thread.term.to === petition.god,
    "the offer opens a supplication thread on the prayer: the god's boon for one offering by the one who prayed, no counteroffers",
    JSON.stringify(thread),
  );
  const accepted = await waitFor(
    `${petition.petitioner}'s routine answers the terms`,
    async () => {
      const now = await threadNow(story, thread.id);
      return now.status === "open" ? undefined : now;
    },
    { timeoutMs: 30_000, intervalMs: 200 },
  );
  check(
    accepted.status === "accepted",
    `${petition.petitioner} accepts, by its drive and its means`,
    accepted.status,
  );
  const answer = eventsOfKind(
    story,
    "practice-moved",
    (e) => e.threadId === thread.id && e.move === "accept",
  )[0];
  check(
    answer?.entityId === petition.petitioner,
    "the acceptance is the mortal's own move, from its routine",
    JSON.stringify(answer),
  );
  return accepted;
}

export async function stepSupplication(
  recorder: Recorder,
  story: Story,
): Promise<Supplications> {
  return recorder.run(
    "S16",
    "Supplication: terms kept are fulfilled; terms broken cost the stake, and the mortal keeps its memory and identity",
    "Two mortals have prayed. A god answers one prayer by offering terms (its boon for one offering of currency by the mortal, no counteroffers); the mortal's routine accepts, the god blesses it, and the mortal makes its offering: the thread is fulfilled, its ending cites the offering that completed it, and the blessing and the offering are each recorded as seen. A god answers the other with the same terms and a stake, the wolf; the mortal accepts and is blessed, then cannot make its offering by the deadline: the thread is breached, the stake changes the mortal's form and capabilities, citing the breach, and its memories, feelings, and identity are kept.",
    async (step) => {
      const prayers = await openHelp(story);
      const state = await stateOf(story);
      const purse = (mortal: string) =>
        state.actors.get(id(mortal))?.inventory.get("currency") ?? 0;
      const mortals = [...state.actors.values()].filter(
        (actor) => actor.isDeity !== true && actor.alive,
      );
      const circulating = mortals.reduce(
        (sum, actor) => sum + (actor.inventory.get("currency") ?? 0),
        0,
      );
      // The mortal who will break its terms holds more than half the currency the mortals have, so once it has spent it
      // there is not enough left in the world to earn it back; the other keeps its terms.
      const richest = [...prayers]
        .map((p) => p.petitioner)
        .sort((a, b) => purse(b) - purse(a))[0];
      const second = prayers.find((p) => p.petitioner === richest);
      const first = prayers.find(
        (p) => p !== second && (p.petitioner !== richest || prayers.length > 1),
      );
      check(
        first !== undefined &&
          second !== undefined &&
          purse(second.petitioner) * 2 > circulating,
        "two prayers wait for an answer, one from a mortal holding more than half of the mortals' currency",
        JSON.stringify({
          circulating,
          purses: mortals.map((m) => [m.id, m.inventory.get("currency") ?? 0]),
          prayers: [...state.petitions.values()].map((p) => ({
            id: p.id,
            god: p.god,
            who: p.petitioner,
            status: p.status,
            kind: p.request.kind,
            tick: p.tick,
          })),
        }),
      );

      // Terms kept.
      const keptThread = await offerTerms(story, first, 1, 40);
      const keptBoon = await giveBoon(
        story,
        first,
        `${first.god} blesses ${first.petitioner}`,
      );
      const kept = await threadEnded(
        story,
        keptThread.id,
        "the thread ends",
        60_000,
      );
      const keptEnd = eventsOfKind(
        story,
        "practice-ended",
        (e) => e.threadId === keptThread.id,
      )[0];
      const offering = eventsOfKind(
        story,
        "worship-performed",
        (e) => e.id === keptEnd?.performedBy,
      )[0];
      check(
        kept.status === "fulfilled" &&
          keptEnd?.reason === "performed" &&
          offering?.entityId === first.petitioner &&
          offering.deity === first.god,
        "the thread is fulfilled, and its ending cites the offering the mortal made to the god",
        JSON.stringify({ status: kept.status, keptEnd, offering }),
      );
      const steps = eventsOfKind(
        story,
        "practice-progressed",
        (e) => e.threadId === keptThread.id,
      );
      check(
        steps.some((e) => e.step === "boon" && e.by === keptBoon) ||
          kept.progress?.boon === keptBoon,
        "the blessing was recorded as the boon seen given",
        JSON.stringify({ steps, progress: kept.progress }),
      );

      // Terms broken.
      const before = await stateOf(story);
      const mortal = second.petitioner;
      const holds =
        before.actors.get(id(mortal))?.inventory.get("currency") ?? 0;
      check(holds >= 1, `${mortal} holds currency to promise`, String(holds));
      const brokenThread = await offerTerms(story, second, holds, 30, "wolf");
      check(
        brokenThread.stake?.form === "wolf",
        "the stake the god chose is on the thread, as the world authored it",
        JSON.stringify(brokenThread.stake),
      );
      // The mortal's currency goes to the other god before the boon. The mortals
      // trade only among themselves, so with all of its currency gone the most
      // it can have again is what the other mortal holds, which is less than it
      // promised.
      let spentOn: string | undefined;
      for (let tries = 0; tries < 20 && spentOn === undefined; tries += 1) {
        const left = await currencyOf(story, mortal);
        const row = await postFixture(
          story,
          mortal,
          {
            kind: "worship",
            deity: otherGod(second.god),
            offering: { resource: "currency", amount: left },
          },
          `${mortal} spends its currency on ${otherGod(second.god)}`,
        );
        if (row.outcome === "committed") spentOn = otherGod(second.god);
      }
      check(
        spentOn !== undefined,
        `${mortal} spent its currency`,
        "never committed",
      );
      const afterSpend = await stateOf(story);
      const stillHere = [...afterSpend.actors.values()]
        .filter((actor) => actor.isDeity !== true && actor.alive)
        .reduce(
          (sum, actor) => sum + (actor.inventory.get("currency") ?? 0),
          0,
        );
      check(
        stillHere < holds,
        `all the currency the mortals can ever have again (${stillHere}) is less than the ${holds} ${mortal} promised`,
        String(stillHere),
      );
      const memoriesBefore =
        (await stateOf(story)).memories.get(id(mortal)) ?? [];
      const feelingsBefore = [...(await stateOf(story)).relationships.entries()]
        .filter(([key]) => key.startsWith(`${mortal}>`))
        .map(([key, value]) => [key, JSON.stringify(value)]);
      await giveBoon(story, second, `${second.god} blesses ${mortal}`);
      const broken = await threadEnded(
        story,
        brokenThread.id,
        "the deadline passes",
        90_000,
      );
      const brokenEnd = eventsOfKind(
        story,
        "practice-ended",
        (e) => e.threadId === brokenThread.id,
      )[0];
      check(
        broken.status === "breached" &&
          brokenEnd?.reason === "obligation-deadline",
        "the thread is breached at its obligation deadline: the boon was had and the offering was not made",
        JSON.stringify({ status: broken.status, brokenEnd }),
      );
      const change = eventsOfKind(
        story,
        "motif-applied",
        (e) => e.threadId === brokenThread.id && e.effect === "transformation",
      )[0];
      check(
        change?.entityId === mortal &&
          change.form === "wolf" &&
          change.intent === "punishment" &&
          change.cause === brokenEnd.id,
        "the stake applies: the mortal becomes a wolf as punishment, citing the breach",
        JSON.stringify(change),
      );
      const after = await stateOf(story);
      const changed = after.actors.get(id(mortal));
      const kept_ = (after.memories.get(id(mortal)) ?? []).map((m) => m.id);
      check(
        changed?.form === "wolf" &&
          changed.alive === true &&
          changed.capabilities.includes("beast"),
        "the committed state holds the new form and capability",
        JSON.stringify({
          form: changed?.form,
          capabilities: changed?.capabilities,
        }),
      );
      check(
        memoriesBefore.every((m) => kept_.includes(m.id)),
        "every memory it held before is still held",
        `${memoriesBefore.length} before, ${kept_.length} after`,
      );
      // The boon and the breach may move how it feels about the gods (it remembers a kindness, and a broken term); the form
      // change itself moves nothing, and every feeling it held is still held, toward everyone but the gods unchanged.
      const feelingsAfter = new Map(
        [...after.relationships.entries()]
          .filter(([key]) => key.startsWith(`${mortal}>`))
          .map(([key, value]) => [key, JSON.stringify(value)]),
      );
      const gods = new Set(["zeus", "hera"]);
      check(
        feelingsBefore.every(
          ([key, value]) =>
            feelingsAfter.has(key as string) &&
            (gods.has(String(key).split(">")[1] as string) ||
              feelingsAfter.get(key as string) === value),
        ),
        "every feeling it held is still held, and none toward a mortal changed",
        JSON.stringify({ before: feelingsBefore, after: [...feelingsAfter] }),
      );
      step.done(
        `${first.god} offered ${first.petitioner} terms on ${first.id}: ${first.petitioner}'s routine accepted, the blessing ${keptBoon} and its offering ${offering?.id} fulfilled ${keptThread.id}; ${second.god} offered ${mortal} the same with the wolf as stake: it took the boon and had nothing to offer, ${brokenThread.id} breached (${brokenEnd?.id}) and ${change?.id} made it a wolf with its ${memoriesBefore.length} memories kept`,
      );
      return { keptId: keptThread.id, brokenId: brokenThread.id };
    },
  );
}
