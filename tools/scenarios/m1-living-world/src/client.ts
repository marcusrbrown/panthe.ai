// A headless client built from the real apps/client modules: the frame
// parser and subscription (connection.ts), the store and view model
// (store.ts), the observer (observer.ts), event placement for the viewed
// realm (renderer/presentation.ts), and the receipt emitter (receipts.ts).
// Only the transport is replaced: it polls `GET /frame` and posts
// `POST /receipts` to the sidecar the way the desktop shell's proxy does,
// stamping each receipt with the latest frame's session id.

import { subscribe, type Transport } from "@panthea/client/src/connection";
import {
  createObserver,
  type ObserverTarget,
} from "@panthea/client/src/observer";
import { createReceiptEmitter } from "@panthea/client/src/receipts";
import {
  drawableEvents,
  receiptDrawnEvents,
} from "@panthea/client/src/renderer/presentation";
import {
  createWorldStore,
  type WorldViewModel,
} from "@panthea/client/src/store";
import type { Realm, SyncFrame } from "@panthea/contracts";
import type { Sidecar } from "./sidecar";

const POLL_INTERVAL_MS = 250;

export interface PresentedEvent {
  readonly eventId: string;
  readonly kind: string;
  readonly sessionId: string;
  readonly realm: Realm;
}

export interface HeadlessClient {
  /** Points the client at a (re)started sidecar; the next poll delivers a fresh frame. */
  attach(sidecar: Sidecar): void;
  /** Stops polling. */
  stop(): void;
  view(): WorldViewModel | undefined;
  /** Every receipt this client relayed successfully, in order. */
  presented(): readonly PresentedEvent[];
  /** Frame, receipt, and relay errors the client reported. */
  errors(): readonly string[];
  /** Placed events this client's viewed realm has shown, by event id, across every frame it received. */
  drawnIds(): ReadonlySet<string>;
}

export function createHeadlessClient(
  follow: ObserverTarget,
  initial: Sidecar,
): HeadlessClient {
  let target = initial;
  let latestSessionId: string | undefined;
  let lastForwarded: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  const presented: PresentedEvent[] = [];
  const errors: string[] = [];
  const drawn = new Set<string>();
  const kindsById = new Map<string, string>();

  const store = createWorldStore();
  const observer = createObserver();
  observer.pick(follow);

  let onPayload: ((payload: unknown) => void) | undefined;

  const transport: Transport = {
    async subscribeWorld(handler) {
      onPayload = handler;
      timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
      void poll();
    },
    async presentEvent(eventId) {
      const sessionId = latestSessionId;
      if (sessionId === undefined) {
        throw new Error("no frame received yet");
      }
      const response = await target.request("POST", "/receipts", {
        eventId,
        sessionId,
      });
      if (response.status !== 200) {
        throw new Error(`receipt relay returned ${response.status}`);
      }
    },
  };

  // The desktop shell forwards a frame only when its sequence, status, or
  // session id changes; the poller does the same.
  async function poll(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      const response = await target.request("GET", "/frame");
      if (response.status !== 200) return;
      const frame = response.body as SyncFrame;
      latestSessionId = frame.sessionId;
      const key = `${frame.sessionId}:${frame.sequence}:${frame.status}`;
      if (key !== lastForwarded) {
        lastForwarded = key;
        onPayload?.(frame);
      }
    } catch {
      // The sidecar is stopped or restarting; the next poll retries.
    } finally {
      polling = false;
    }
  }

  const emitter = createReceiptEmitter({
    presentEvent: (eventId) => transport.presentEvent(eventId),
    onError: (error) =>
      errors.push(`receipt ${error.eventId}: ${error.message}`),
  });

  // Same rule as App.tsx: draw what the viewed realm places, receipt only that.
  store.onChange((view) => {
    const observation = observer.update(view);
    const realm: Realm =
      observation.kind === "following"
        ? observation.realm
        : observation.kind === "held" && observation.lastKnown
          ? observation.lastKnown.realm
          : "mortal";
    const events = drawableEvents(view, realm);
    for (const event of events) {
      drawn.add(event.id);
      kindsById.set(event.id, event.kind);
    }
    void receiptDrawnEvents(view.sessionId, events, {
      async present(sessionId, eventId) {
        const result = await emitter.present(sessionId, eventId);
        if (result === "sent") {
          presented.push({
            eventId,
            kind: kindsById.get(eventId) ?? "unknown",
            sessionId,
            realm,
          });
        }
        return result;
      },
    });
  });

  void subscribe(
    ({ frame, state }) => store.apply(frame, state),
    (error) => errors.push(`${error.kind}: ${error.message}`),
    transport,
  );

  return {
    attach(next) {
      target = next;
      lastForwarded = undefined;
      void poll();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
    view: () => store.viewModel(),
    presented: () => presented,
    errors: () => errors,
    drawnIds: () => drawn,
  };
}
