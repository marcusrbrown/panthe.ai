import { expect, test } from "bun:test";
import { createReceiptEmitter, type ReceiptError } from "./receipts";

function harness(options: { readonly failFor?: ReadonlySet<string> } = {}) {
  const sent: string[] = [];
  const errors: ReceiptError[] = [];
  const emitter = createReceiptEmitter({
    presentEvent: async (eventId) => {
      sent.push(eventId);
      if (options.failFor?.has(eventId)) {
        throw new Error("relay failed");
      }
    },
    onError: (error) => errors.push(error),
  });
  return { emitter, sent, errors };
}

test("an event drawn for the first time is receipted once", async () => {
  const { emitter, sent } = harness();

  expect(await emitter.present("session-1", "evt-1-1")).toBe("sent");

  expect(sent).toEqual(["evt-1-1"]);
});

test("the same event in the same session is receipted only once", async () => {
  const { emitter, sent } = harness();

  await emitter.present("session-1", "evt-1-1");
  expect(await emitter.present("session-1", "evt-1-1")).toBe("duplicate");
  expect(await emitter.present("session-1", "evt-1-1")).toBe("duplicate");

  expect(sent).toEqual(["evt-1-1"]);
});

test("different events in one session are each receipted", async () => {
  const { emitter, sent } = harness();

  await emitter.present("session-1", "evt-1-1");
  await emitter.present("session-1", "evt-1-2");

  expect(sent).toEqual(["evt-1-1", "evt-1-2"]);
});

test("a session change resets the dedup set, so the same event id is receipted again", async () => {
  const { emitter, sent } = harness();

  await emitter.present("session-1", "evt-1-1");
  await emitter.present("session-2", "evt-1-1");
  expect(await emitter.present("session-2", "evt-1-1")).toBe("duplicate");

  expect(sent).toEqual(["evt-1-1", "evt-1-1"]);
});

test("two draws of the same event racing in one session send one receipt", async () => {
  const { emitter, sent } = harness();

  const results = await Promise.all([
    emitter.present("session-1", "evt-1-1"),
    emitter.present("session-1", "evt-1-1"),
  ]);

  expect([...results].sort()).toEqual(["duplicate", "sent"]);
  expect(sent).toEqual(["evt-1-1"]);
});

test("a failed receipt is reported once and not retried automatically", async () => {
  const { emitter, sent, errors } = harness({
    failFor: new Set(["evt-1-1"]),
  });

  expect(await emitter.present("session-1", "evt-1-1")).toBe("failed");
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(sent).toEqual(["evt-1-1"]);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({
    eventId: "evt-1-1",
    sessionId: "session-1",
  });
});

test("after a failure the caller can present the same event again", async () => {
  const failing = new Set(["evt-1-1"]);
  const { emitter, sent } = harness({ failFor: failing });

  await emitter.present("session-1", "evt-1-1");
  failing.delete("evt-1-1");
  expect(await emitter.present("session-1", "evt-1-1")).toBe("sent");

  expect(sent).toEqual(["evt-1-1", "evt-1-1"]);
});

test("a failure from an earlier session does not unmark the current session's receipt", async () => {
  let release: (() => void) | undefined;
  const sent: string[] = [];
  const emitter = createReceiptEmitter({
    presentEvent: (eventId) => {
      sent.push(eventId);
      if (sent.length === 1) {
        return new Promise<void>((_resolve, reject) => {
          release = () => reject(new Error("late failure"));
        });
      }
      return Promise.resolve();
    },
    onError: () => {},
  });

  const first = emitter.present("session-1", "evt-1-1");
  await emitter.present("session-2", "evt-1-1");
  release?.();
  await first;

  expect(await emitter.present("session-2", "evt-1-1")).toBe("duplicate");
  expect(sent).toEqual(["evt-1-1", "evt-1-1"]);
});
