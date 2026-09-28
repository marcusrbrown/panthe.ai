// The scene host's lifecycle decisions, kept free of React so they can be
// exercised with a fake renderer: starting a renderer on a canvas, reacting
// to its failure and device loss, and drawing a view into it. Anything a
// renderer reports after the session was disposed is ignored.

import type { Realm } from "@panthea/contracts";
import type { WorldViewModel } from "../store";
import type { RendererFactory, WorldRenderer } from "./scene";

export interface SceneLifecycleHandlers {
  onStarted(): void;
  onFailure(message: string): void;
  /** Called once per session, however many times the renderer signals device loss. */
  onDeviceLost(): void;
}

export interface SceneSession {
  /** The renderer this session started, or `undefined` when construction failed. */
  readonly renderer: WorldRenderer | undefined;
  dispose(): void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Creates a renderer for `canvas` and starts it. A factory or synchronous
 * start failure and a rejected start are reported through `onFailure`; a
 * resolved start through `onStarted`. `dispose` disposes the renderer and
 * silences every later report.
 */
export function startSceneRenderer(
  canvas: HTMLCanvasElement,
  factory: RendererFactory,
  handlers: SceneLifecycleHandlers,
): SceneSession {
  let renderer: WorldRenderer | undefined;
  let active = true;
  let recovering = false;

  try {
    renderer = factory(canvas);
    void renderer
      .start(() => {
        if (!active || recovering) return;
        recovering = true;
        handlers.onDeviceLost();
      })
      .then(() => {
        if (active) handlers.onStarted();
      })
      .catch((error: unknown) => {
        if (active) handlers.onFailure(messageOf(error));
      });
  } catch (error) {
    handlers.onFailure(messageOf(error));
  }

  const started = renderer;
  return {
    renderer: started,
    dispose() {
      active = false;
      started?.dispose();
    },
  };
}

/**
 * Draws `view` into `renderer` and hands the ids of the events it drew to
 * `onDrawn`. A draw error is reported through `onFailure` and nothing is
 * handed on. With no renderer, nothing is drawn and `onDrawn` receives an
 * empty list.
 */
export function drawScene(
  renderer: WorldRenderer | undefined,
  view: WorldViewModel,
  realm: Realm,
  handlers: {
    onDrawn?: (eventIds: readonly string[]) => void;
    onFailure(message: string): void;
  },
): void {
  try {
    handlers.onDrawn?.(renderer?.draw(view, realm) ?? []);
  } catch (error) {
    handlers.onFailure(messageOf(error));
  }
}
