import type { Realm } from "@panthea/contracts";
import { useEffect, useRef, useState } from "react";

import type { WorldViewModel } from "../store";
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
    let current: WorldRenderer | undefined;
    let active = true;
    let recovering = false;
    setStarted(false);
    setFailure(undefined);
    try {
      current = rendererFactory(canvas);
      rendererRef.current = current;
      void current
        .start(() => {
          if (!active || recovering) return;
          recovering = true;
          onDeviceLostRef.current?.();
        })
        .then(() => {
          if (active) setStarted(true);
        })
        .catch((error: unknown) => {
          if (active)
            setFailure(error instanceof Error ? error.message : String(error));
        });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }

    return () => {
      active = false;
      if (rendererRef.current === current) rendererRef.current = undefined;
      current?.dispose();
    };
  }, [rendererFactory]);

  useEffect(() => {
    if (!started || !view) return;
    try {
      onDrawnRef.current?.(rendererRef.current?.draw(view, realm) ?? []);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
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
