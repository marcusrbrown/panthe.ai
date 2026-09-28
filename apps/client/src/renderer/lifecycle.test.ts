import { expect, test } from "bun:test";
import type { Realm } from "@panthea/contracts";

import type { WorldViewModel } from "../store";
import { drawScene, startSceneRenderer } from "./lifecycle";
import type { WorldRenderer } from "./scene";

const canvas = {} as HTMLCanvasElement;

const view = { sessionId: "session-1" } as unknown as WorldViewModel;

interface FakeRenderer extends WorldRenderer {
  readonly disposed: () => number;
  readonly triggerDeviceLost: () => void;
  readonly resolveStart: () => void;
  readonly rejectStart: (error: unknown) => void;
}

function fakeRenderer(
  options: {
    readonly drawIds?: readonly string[];
    readonly drawError?: Error;
  } = {},
): FakeRenderer {
  let disposals = 0;
  let onLost: (() => void) | undefined;
  let resolve: () => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const started = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    start(onDeviceLost) {
      onLost = onDeviceLost;
      return started;
    },
    draw(_view: WorldViewModel, _realm: Realm) {
      if (options.drawError) throw options.drawError;
      return options.drawIds ?? [];
    },
    dispose() {
      disposals += 1;
    },
    disposed: () => disposals,
    triggerDeviceLost: () => onLost?.(),
    resolveStart: () => resolve(),
    rejectStart: (error) => reject(error),
  };
}

function handlers() {
  const log: string[] = [];
  return {
    log,
    handlers: {
      onStarted: () => log.push("started"),
      onFailure: (message: string) => log.push(`failure:${message}`),
      onDeviceLost: () => log.push("device-lost"),
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a renderer that starts reports started once", async () => {
  const renderer = fakeRenderer();
  const seen = handlers();

  const session = startSceneRenderer(canvas, () => renderer, seen.handlers);
  expect(session.renderer).toBe(renderer);
  expect(seen.log).toEqual([]);
  renderer.resolveStart();
  await settle();

  expect(seen.log).toEqual(["started"]);
});

test("a renderer factory that throws reports the failure and leaves no renderer to dispose", () => {
  const seen = handlers();

  const session = startSceneRenderer(
    canvas,
    () => {
      throw new Error("WebGPU unavailable");
    },
    seen.handlers,
  );

  expect(session.renderer).toBeUndefined();
  expect(seen.log).toEqual(["failure:WebGPU unavailable"]);
  expect(() => session.dispose()).not.toThrow();
});

test("a non-Error thrown by the factory is reported as text", () => {
  const seen = handlers();

  startSceneRenderer(
    canvas,
    () => {
      throw "no adapter";
    },
    seen.handlers,
  );

  expect(seen.log).toEqual(["failure:no adapter"]);
});

test("a start that rejects reports the failure and never reports started", async () => {
  const renderer = fakeRenderer();
  const seen = handlers();
  startSceneRenderer(canvas, () => renderer, seen.handlers);

  renderer.rejectStart(new Error("device init failed"));
  await settle();

  expect(seen.log).toEqual(["failure:device init failed"]);
});

test("a start that resolves or rejects after dispose reports nothing", async () => {
  const late = fakeRenderer();
  const lateSeen = handlers();
  const lateSession = startSceneRenderer(canvas, () => late, lateSeen.handlers);
  lateSession.dispose();
  late.resolveStart();
  await settle();

  const failing = fakeRenderer();
  const failingSeen = handlers();
  const failingSession = startSceneRenderer(
    canvas,
    () => failing,
    failingSeen.handlers,
  );
  failingSession.dispose();
  failing.rejectStart(new Error("too late"));
  await settle();

  expect(lateSeen.log).toEqual([]);
  expect(failingSeen.log).toEqual([]);
});

test("device loss is reported once however many times the renderer signals it", () => {
  const renderer = fakeRenderer();
  const seen = handlers();
  startSceneRenderer(canvas, () => renderer, seen.handlers);

  renderer.triggerDeviceLost();
  renderer.triggerDeviceLost();

  expect(seen.log).toEqual(["device-lost"]);
});

test("device loss after dispose is ignored", () => {
  const renderer = fakeRenderer();
  const seen = handlers();
  const session = startSceneRenderer(canvas, () => renderer, seen.handlers);

  session.dispose();
  renderer.triggerDeviceLost();

  expect(seen.log).toEqual([]);
});

test("dispose disposes the renderer it started", () => {
  const renderer = fakeRenderer();
  const session = startSceneRenderer(
    canvas,
    () => renderer,
    handlers().handlers,
  );

  session.dispose();

  expect(renderer.disposed()).toBe(1);
});

test("a start that throws synchronously is reported as a failure", () => {
  const renderer: WorldRenderer = {
    start() {
      throw new Error("start exploded");
    },
    draw: () => [],
    dispose: () => {},
  };
  const seen = handlers();

  startSceneRenderer(canvas, () => renderer, seen.handlers);

  expect(seen.log).toEqual(["failure:start exploded"]);
});

test("drawing hands the ids the renderer drew to onDrawn", () => {
  const renderer = fakeRenderer({ drawIds: ["fire-1", "trade-1"] });
  const drawn: (readonly string[])[] = [];
  const failures: string[] = [];

  drawScene(renderer, view, "mortal", {
    onDrawn: (ids) => drawn.push(ids),
    onFailure: (message) => failures.push(message),
  });

  expect(drawn).toEqual([["fire-1", "trade-1"]]);
  expect(failures).toEqual([]);
});

test("a draw error is reported as a failure and nothing is receipted", () => {
  const renderer = fakeRenderer({ drawError: new Error("render pass failed") });
  const drawn: (readonly string[])[] = [];
  const failures: string[] = [];

  drawScene(renderer, view, "mortal", {
    onDrawn: (ids) => drawn.push(ids),
    onFailure: (message) => failures.push(message),
  });

  expect(drawn).toEqual([]);
  expect(failures).toEqual(["render pass failed"]);
});

test("drawing with no renderer draws nothing and receipts nothing", () => {
  const drawn: (readonly string[])[] = [];

  drawScene(undefined, view, "mortal", {
    onDrawn: (ids) => drawn.push(ids),
    onFailure: () => {},
  });

  expect(drawn).toEqual([[]]);
});
