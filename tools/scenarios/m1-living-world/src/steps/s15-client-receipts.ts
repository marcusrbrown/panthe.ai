// S15: the headless client receipts only events it placed in the viewed realm,
// and a client viewing another realm sends none.

import { createHeadlessClient } from "../client";
import { check, waitFor } from "../helpers";
import { fmt, readFrame, receiptOf } from "./api";
import type { Recorder, Story } from "./context";
import { eventsOf, storedReceipts } from "./direct";
import type { TreeStrike } from "./s03-tree-strike";
import type { StrikeFacts } from "./s04-strike";
import type { WorshipFacts } from "./s08-worship";

/** Event kinds the scene does not draw, so the client must never receipt them. */
const UNDRAWN_KINDS = [
  "resource-gathered",
  "resource-produced",
  "resource-consumed",
  "income-earned",
  "building-burn-ticked",
  "repair-progressed",
  "legend-recorded",
];

export async function stepClientReceipts(
  recorder: Recorder,
  story: Story,
  facts: {
    readonly oak: TreeStrike;
    readonly strike: StrikeFacts;
    readonly worship: WorshipFacts;
  },
): Promise<void> {
  const { oak, strike, worship } = facts;
  await recorder.run(
    "S15",
    "Headless client receipts",
    "The client receipts only events it placed in the viewed realm: every stored receipt was sent by the client, none is for an undrawn kind, the tree strike's damage, the tavern strike, the fire, the worship, and a routine trade were receipted in the session they happened in, and a client viewing another realm sends none.",
    async (step) => {
      const [mortal] = story.clients;
      check(mortal !== undefined, "the mortal-realm client exists", "missing");
      const view = mortal.view();
      check(
        view !== undefined &&
          view.realms.mortal.length > 0 &&
          view.realms.olympus.length > 0 &&
          view.realms.underworld.length > 0,
        "the client's view model spans all three realms",
        fmt(Object.keys(view?.realms ?? {})),
      );
      const { frame } = await readFrame(story.sidecar);
      check(
        view.sessionId === frame.sessionId,
        "the client is on the sidecar's current session",
        `${view.sessionId} vs ${frame.sessionId}`,
      );

      // A receipt can be stored a moment before the client's own send resolves, so wait for the two to agree.
      const stored = await waitFor(
        "every stored receipt was sent by the client",
        () => {
          const rows = storedReceipts(story);
          const sent = new Set(
            mortal.presented().map((entry) => entry.eventId),
          );
          return rows.length > 0 &&
            rows.every((receipt) => sent.has(receipt.eventId))
            ? rows
            : undefined;
        },
        { timeoutMs: 5000, intervalMs: 50 },
      );
      const storedKinds = new Set(stored.map((receipt) => receipt.kind));
      check(
        UNDRAWN_KINDS.every((kind) => !storedKinds.has(kind)),
        "no stored receipt is for an undrawn event kind",
        fmt([...storedKinds]),
      );
      const allKinds = new Set(eventsOf(story).map((event) => event.kind));
      check(
        UNDRAWN_KINDS.some((kind) => allKinds.has(kind)),
        "undrawn kinds do exist in the log, so the check is not vacuous",
        fmt([...allKinds]),
      );

      const ignited = await receiptOf(story, strike.ignitedEventId);
      check(
        ignited !== undefined && ignited.sessionId === strike.sessionId,
        "the strike's ignition was receipted in the session it happened in",
        fmt(ignited),
      );
      const destroyed = eventsOf(story).find(
        (event) =>
          event.kind === "building-destroyed" &&
          event.payload.entityId === "the-tavern",
      );
      check(
        (await receiptOf(story, destroyed?.id)) !== undefined,
        "the tavern's destruction was receipted",
        `${destroyed?.id}`,
      );
      check(
        stored.some((receipt) => receipt.kind === "resource-traded"),
        "a routine trade was receipted",
        fmt([...storedKinds]),
      );
      const oakReceipt = await receiptOf(story, oak.damagedEventId);
      check(
        oakReceipt?.sessionId === oak.sessionId,
        "the tree's damage was receipted in the session it happened in",
        fmt(oakReceipt),
      );
      const worshipReceipt = await receiptOf(story, worship.eventId);
      check(
        worshipReceipt?.sessionId === worship.sessionId,
        "the worship was receipted in the session it happened in",
        fmt(worshipReceipt),
      );

      const underworld = createHeadlessClient(
        story.options.control === "underworld"
          ? // Positive control: view the mortal realm instead of the underworld.
            { kind: "actor", id: "farmer" }
          : { kind: "location", id: "judgment-hall" },
        story.sidecar,
      );
      story.clients.push(underworld);
      const sentBefore = mortal.presented().length;
      await waitFor(
        "the mortal client keeps placing and receipting events",
        () => (mortal.presented().length > sentBefore ? true : undefined),
        { timeoutMs: 30_000, intervalMs: 100 },
      );
      await Bun.sleep(1000);
      check(
        underworld.view() !== undefined &&
          underworld.view()?.recentEvents.length !== 0,
        "the underworld client receives frames with events",
        "no frames",
      );
      check(
        underworld.presented().length === 0 && underworld.drawnIds().size === 0,
        "a client viewing the underworld places and receipts nothing while mortal events happen",
        `${underworld.presented().length} sent`,
      );
      const frameErrors = [...mortal.errors(), ...underworld.errors()].filter(
        (message) => !message.startsWith("receipt "),
      );
      check(
        frameErrors.length === 0,
        "no frame failed to parse or decode",
        fmt(frameErrors),
      );
      const relayErrors = [...mortal.errors()].filter((message) =>
        message.startsWith("receipt "),
      ).length;
      const kindCounts = Object.fromEntries(
        [...storedKinds].map((kind) => [
          kind,
          stored.filter((receipt) => receipt.kind === kind).length,
        ]),
      );
      step.done(
        `${stored.length} receipts stored by the mortal-realm client (${fmt(kindCounts)}); oak damage, ignition, destruction, worship, and trades receipted; underworld client received frames and sent 0; relay errors during restarts ${relayErrors}`,
        [
          { name: "receipts stored", unit: "count", value: stored.length },
          {
            name: "receipt relay errors (restarts)",
            unit: "count",
            value: relayErrors,
          },
        ],
      );
    },
  );
}
