import type { Realm } from "@panthea/contracts";
import { useEffect, useRef, useState } from "react";

import type { WorldViewModel } from "../store";
import { drawScene, startSceneRenderer } from "./lifecycle";
import {
  createWorldRenderer,
  type RendererFactory,
  type WorldRenderer,
} from "./scene";

export interface SceneHostProps {
  readonly view?: WorldViewModel;
  readonly realm: Realm;
  readonly rendererFactory?: RendererFactory;
  readonly onDrawn?: (eventIds: readonly string[]) => void;
  readonly onDeviceLost?: () => void;
}

export function SceneHost({
  view,
  realm,
  rendererFactory = createWorldRenderer,
  onDrawn,
  onDeviceLost,
}: SceneHostProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [started, setStarted] = useState(false);
  const [failure, setFailure] = useState<string>();
  const rendererRef = useRef<WorldRenderer | undefined>(undefined);
  const onDrawnRef = useRef(onDrawn);
  const onDeviceLostRef = useRef(onDeviceLost);
  onDrawnRef.current = onDrawn;
  onDeviceLostRef.current = onDeviceLost;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setStarted(false);
    setFailure(undefined);
    const session = startSceneRenderer(canvas, rendererFactory, {
      onStarted: () => setStarted(true),
      onFailure: setFailure,
      onDeviceLost: () => onDeviceLostRef.current?.(),
    });
    rendererRef.current = session.renderer;

    return () => {
      if (rendererRef.current === session.renderer) {
        rendererRef.current = undefined;
      }
      session.dispose();
    };
  }, [rendererFactory]);

  useEffect(() => {
    if (!started || !view) return;
    drawScene(rendererRef.current, view, realm, {
      onDrawn: (eventIds) => onDrawnRef.current?.(eventIds),
      onFailure: setFailure,
    });
  }, [realm, started, view]);

  return (
    <>
      <canvas ref={canvasRef} aria-label="Rendered world scene" />
      {failure && (
        <div className="scene-failure" role="status">
          Scene unavailable: {failure}
        </div>
      )}
    </>
  );
}
