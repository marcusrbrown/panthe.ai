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
}

function fixtureView(): WorldViewModel {
  const realm = (
    id: string,
    name: string,
    actors: WorldViewModel["realms"][Realm][number]["actors"] = [],
    buildings: WorldViewModel["realms"][Realm][number]["buildings"] = [],
  ) => ({
    id,
    name,
    realm: "mortal" as Realm,
    edges: [],
    actors,
    buildings,
  });
  const recentEvents = [
    {
      id: "evt-strike-14",
      sequence: 14,
      tick: 14,
      kind: "strike" as never,
      subjects: [] as never[],
    },
    {
      id: "evt-fire-15",
      sequence: 15,
      tick: 15,
      kind: "building-ignited" as never,
      subjects: [] as never[],
    },
    {
      id: "evt-trade-16",
      sequence: 16,
      tick: 16,
      kind: "trade" as never,
      subjects: [] as never[],
    },
    {
      id: "evt-worship-17",
      sequence: 17,
      tick: 17,
      kind: "worship" as never,
      subjects: [] as never[],
    },
  ] as unknown as WorldViewModel["recentEvents"];
  const woodcutter = {
    id: "wanderer",
    locationId: "town-square",
    alive: true,
    isDeity: false,
    inventory: [
      { resource: "wood", amount: 2 },
      { resource: "currency", amount: 5 },
    ],
  };
  const deadActor = {
    id: "fallen-guard",
    locationId: "town-square",
    alive: false,
    isDeity: false,
    inventory: [],
  };
  const tavern = {
    id: "the-tavern",
    name: "The Tavern",
    locationId: "town-square",
    status: "burning" as const,
    inventory: [],
    fire: { intensity: 2, ticksBurning: 2, destroyAt: 3 },
  };
  const shop = {
    id: "agora-shop",
    name: "Agora Shop",
    locationId: "agora",
    status: "operational" as const,
    inventory: [{ resource: "planks", amount: 1 }],
  };
  const mortalSquare = {
    ...realm("town-square", "Town Square", [woodcutter, deadActor], [tavern]),
    edges: [{ to: "agora", transport: "path", bidirectional: true }],
  };
  const agora = {
    ...realm("agora", "Agora", [], [shop]),
    edges: [{ to: "town-square", transport: "path", bidirectional: true }],
  };
  const olympusHall = {
    ...realm("olympus-hall", "Hall of Olympus", [
      {
        id: "zeus",
        locationId: "olympus-hall",
        alive: true,
        isDeity: true,
        inventory: [{ resource: "divinity", amount: 10 }],
      },
    ]),
    realm: "olympus" as Realm,
  };
  const underworldGate = {
    ...realm("underworld-gate", "Underworld Gate"),
    realm: "underworld" as Realm,
  };
  return {
    sessionId: "preview-session",
    sequence: 17,
    tick: 17,
    status: "running",
    catchUpSummary: {
      appliedMs: 7_200_000,
      skippedMs: 10_800_000,
      majorOutcomes: [
        "The tavern fire spread",
        "A route through the agora reopened",
      ],
    },
    realms: {
      mortal: [agora, mortalSquare],
      olympus: [olympusHall],
      underworld: [underworldGate],
    },
    recentEvents,
  } as WorldViewModel;
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
  const [dismissedSummaryKey, setDismissedSummaryKey] = useState<string>();
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
      const initial = fixtureView();
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

  const summaryKey = view?.catchUpSummary
    ? `${view.sessionId}:${view.sequence}`
    : undefined;
  const dismissedSummary =
    summaryKey !== undefined && summaryKey === dismissedSummaryKey;
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
        if (summaryKey) setDismissedSummaryKey(summaryKey);
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
