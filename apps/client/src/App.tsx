import type { Realm } from "@panthea/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  type ConnectedFrame,
  type ConnectionError,
  createTauriTransport,
  presentEvent,
  subscribe,
  type Transport,
} from "./connection";
import { previewView } from "./fixtures";
import {
  createObserver,
  type ObserverTarget,
  type ObserverView,
} from "./observer";
import { createReceiptEmitter } from "./receipts";
import { createRecovery } from "./recovery";
import { drawableEvents, receiptDrawnEvents } from "./renderer/presentation";
import { rebuildAfterDeviceLoss } from "./renderer/recovery";
import { SceneHost } from "./renderer/SceneHost";
import type { RendererFactory } from "./renderer/scene";
import { createWorldStore, type WorldViewModel } from "./store";
import {
  browserDismissalStorage,
  createSummaryDismissal,
  type DismissalStorage,
  dismissSummary,
  isSummaryDismissed,
} from "./summary";
import { ClientSurface } from "./ui/surface";

export interface ClientDependencies {
  readonly transport?: Transport;
  readonly subscribe?: (
    onFrame: (connected: ConnectedFrame) => void,
    onError: (error: ConnectionError) => void,
  ) => Promise<void>;
  readonly presentEvent?: (eventId: string) => Promise<void>;
  readonly rendererFactory?: RendererFactory;
  readonly initialView?: WorldViewModel;
  readonly fixture?: boolean;
  /** Where a dismissed catch-up summary is remembered; defaults to the browser's localStorage. */
  readonly summaryStorage?: DismissalStorage;
}

export function App({
  dependencies = {},
}: {
  readonly dependencies?: ClientDependencies;
}) {
  const store = useMemo(() => createWorldStore(), []);
  const observer = useMemo(() => createObserver(), []);
  const recovery = useMemo(() => createRecovery(store), [store]);
  const [view, setView] = useState<WorldViewModel | undefined>(
    dependencies.initialView,
  );
  const [observation, setObservation] = useState<ObserverView>({
    kind: "idle",
  });
  const [receiptErrors, setReceiptErrors] = useState<string[]>([]);
  const summaryDismissal = useMemo(
    () =>
      createSummaryDismissal(
        dependencies.summaryStorage ?? browserDismissalStorage(),
      ),
    [dependencies.summaryStorage],
  );
  // Re-renders the surface after an explicit Dismiss; the dismissal itself
  // lives in `summaryDismissal` and its storage.
  const [, setDismissals] = useState(0);
  const [rendererEpoch, setRendererEpoch] = useState(0);
  const fixtureMode =
    dependencies.fixture ??
    (import.meta.env.DEV &&
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("fixture") === "1");
  const transport = useMemo(
    () => dependencies.transport ?? createTauriTransport(),
    [dependencies.transport],
  );
  const receiptEmitter = useMemo(
    () =>
      createReceiptEmitter({
        presentEvent:
          dependencies.presentEvent ??
          (fixtureMode
            ? async () => {}
            : (eventId) => presentEvent(eventId, transport)),
        onError: (error) =>
          setReceiptErrors((errors) => [...errors.slice(-3), error.message]),
      }),
    [dependencies.presentEvent, fixtureMode, transport],
  );

  const acceptFrame = useCallback(
    (connected: ConnectedFrame) => {
      store.apply(connected.frame, connected.state);
    },
    [store],
  );

  useEffect(() => {
    let mounted = true;
    const apply = (connected: ConnectedFrame) => {
      if (mounted) acceptFrame(connected);
    };
    const onError = (error: ConnectionError) => {
      if (mounted)
        setReceiptErrors((errors) => [...errors.slice(-3), error.message]);
    };
    let startSubscription: (() => void) | undefined;

    if (dependencies.initialView) {
      setView(dependencies.initialView);
    } else if (fixtureMode) {
      const initial = previewView();
      observer.pick({ kind: "actor", id: "wanderer" });
      setView(initial);
      setObservation(observer.update(initial));
    } else {
      const subscribeFrames =
        dependencies.subscribe ??
        ((onFrame, onError) => subscribe(onFrame, onError, transport));
      startSubscription = () => {
        void subscribeFrames(apply, onError);
      };
    }

    const stop = store.onChange((next) => {
      if (mounted) {
        setView(next);
        setObservation(observer.update(next));
      }
    });
    startSubscription?.();
    return () => {
      mounted = false;
      stop();
    };
  }, [
    acceptFrame,
    dependencies.initialView,
    dependencies.subscribe,
    fixtureMode,
    observer,
    store,
    transport,
  ]);

  const onPick = useCallback(
    (target: ObserverTarget) => {
      observer.pick(target);
      if (view) setObservation(observer.update(view));
    },
    [observer, view],
  );

  const dismissedSummary = isSummaryDismissed(view, summaryDismissal);
  const realm: Realm =
    observation.kind === "following"
      ? observation.realm
      : observation.kind === "held" && observation.lastKnown
        ? observation.lastKnown.realm
        : "mortal";

  const onDrawn = useCallback(
    (eventIds: readonly string[]) => {
      if (!view || !eventIds.length) return;
      const drawn = drawableEvents(view, realm).filter((event) =>
        eventIds.includes(event.id),
      );
      void receiptDrawnEvents(view.sessionId, drawn, receiptEmitter);
    },
    [realm, receiptEmitter, view],
  );

  const onDeviceLost = useCallback(() => {
    rebuildAfterDeviceLoss(
      () => recovery.rebuild(),
      (rebuilt) => {
        setView(rebuilt);
        setObservation(observer.update(rebuilt));
      },
    );
    setRendererEpoch((epoch) => epoch + 1);
  }, [observer, recovery]);

  return (
    <ClientSurface
      view={view}
      observation={observation}
      onPick={onPick}
      onDismissCatchUp={() => {
        dismissSummary(view, summaryDismissal);
        setDismissals((count) => count + 1);
      }}
      dismissedSummary={dismissedSummary}
      receiptErrors={receiptErrors}
      scene={
        <SceneHost
          key={rendererEpoch}
          view={view}
          realm={realm}
          rendererFactory={dependencies.rendererFactory}
          onDrawn={onDrawn}
          onDeviceLost={onDeviceLost}
        />
      }
    />
  );
}
