import { expect, test } from "bun:test";
import {
  type ConnectedFrame,
  type ConnectionError,
  presentEvent,
  subscribe,
  type Transport,
} from "./connection";
import { baseState, framePayload } from "./fixtures";

function fakeTransport() {
  let push: ((payload: unknown) => void) | undefined;
  const subscriptions: number[] = [];
  const presented: string[] = [];
  const transport: Transport = {
    async subscribeWorld(onPayload) {
      subscriptions.push(subscriptions.length + 1);
      push = onPayload;
    },
    async presentEvent(eventId) {
      presented.push(eventId);
    },
  };
  return {
    transport,
    subscriptions,
    presented,
    push(payload: unknown) {
      if (!push) throw new Error("not subscribed");
      push(payload);
    },
  };
}

function collect() {
  const frames: ConnectedFrame[] = [];
  const errors: ConnectionError[] = [];
  return {
    frames,
    errors,
    onFrame: (frame: ConnectedFrame) => frames.push(frame),
    onError: (error: ConnectionError) => errors.push(error),
  };
}

test("a valid payload is parsed and its state decoded before it reaches onFrame", async () => {
  const fake = fakeTransport();
  const seen = collect();
  await subscribe(seen.onFrame, seen.onError, fake.transport);

  fake.push(framePayload(baseState(), { sequence: 12 }));

  expect(seen.errors).toEqual([]);
  expect(seen.frames).toHaveLength(1);
  const [delivered] = seen.frames;
  expect(delivered?.frame.sequence).toBe(12);
  expect(delivered?.frame.sessionId as string | undefined).toBe("session-1");
  expect(delivered?.state.actors.size).toBe(3);
  expect(delivered?.state.buildings.size).toBe(2);
});

test("a payload that is not a frame is dropped and reported, never thrown into the channel handler", async () => {
  const fake = fakeTransport();
  const seen = collect();
  await subscribe(seen.onFrame, seen.onError, fake.transport);

  expect(() => fake.push({ not: "a frame" })).not.toThrow();
  expect(() => fake.push("garbage")).not.toThrow();
  expect(() => fake.push(null)).not.toThrow();

  expect(seen.frames).toEqual([]);
  expect(seen.errors.map((error) => error.kind)).toEqual([
    "invalid-frame",
    "invalid-frame",
    "invalid-frame",
  ]);
});

test("a frame missing recentEvents is dropped", async () => {
  const fake = fakeTransport();
  const seen = collect();
  await subscribe(seen.onFrame, seen.onError, fake.transport);
  const payload = framePayload(baseState()) as Record<string, unknown>;
  delete payload.recentEvents;

  fake.push(payload);

  expect(seen.frames).toEqual([]);
  expect(seen.errors[0]).toMatchObject({
    kind: "invalid-frame",
    path: "recentEvents",
  });
});

test("a frame whose state does not decode is dropped and reported as an invalid state", async () => {
  const fake = fakeTransport();
  const seen = collect();
  await subscribe(seen.onFrame, seen.onError, fake.transport);
  const payload = framePayload(baseState()) as Record<string, unknown>;
  payload.state = { tick: "three" };

  expect(() => fake.push(payload)).not.toThrow();

  expect(seen.frames).toEqual([]);
  expect(seen.errors.map((error) => error.kind)).toEqual(["invalid-state"]);
});

test("a consumer that throws while handling a frame is reported, not thrown into the channel", async () => {
  const fake = fakeTransport();
  const errors: ConnectionError[] = [];
  await subscribe(
    () => {
      throw new Error("renderer bug");
    },
    (error) => errors.push(error),
    fake.transport,
  );

  expect(() => fake.push(framePayload(baseState()))).not.toThrow();
  expect(errors.map((error) => error.kind)).toEqual(["handler-failed"]);
});

test("a failed subscription is reported through the error callback", async () => {
  const seen = collect();
  const transport: Transport = {
    async subscribeWorld() {
      throw new Error("channel unavailable");
    },
    async presentEvent() {},
  };

  await subscribe(seen.onFrame, seen.onError, transport);

  expect(seen.errors.map((error) => error.kind)).toEqual(["subscribe-failed"]);
});

test("subscribing again asks the transport again, so a reload receives a fresh frame", async () => {
  const fake = fakeTransport();
  const seen = collect();
  await subscribe(seen.onFrame, seen.onError, fake.transport);
  await subscribe(seen.onFrame, seen.onError, fake.transport);

  expect(fake.subscriptions).toHaveLength(2);
});

test("presentEvent relays the event id through the transport", async () => {
  const fake = fakeTransport();
  await presentEvent("evt-3-9", fake.transport);
  expect(fake.presented).toEqual(["evt-3-9"]);
});

test("presentEvent rejects when the relay fails, so the caller can report it", async () => {
  const transport: Transport = {
    async subscribeWorld() {},
    async presentEvent() {
      throw new Error("no active sidecar session");
    },
  };
  await expect(presentEvent("evt-3-9", transport)).rejects.toThrow(
    "no active sidecar session",
  );
});
