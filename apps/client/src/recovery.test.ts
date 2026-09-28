import { expect, test } from "bun:test";
import { parseSyncFrame } from "@panthea/contracts";
import { decode } from "@panthea/world";
import { baseState, framePayload, movedActor } from "./fixtures";
import { createRecovery } from "./recovery";
import { createWorldStore } from "./store";

function applied(store: ReturnType<typeof createWorldStore>, payload: unknown) {
  const parsed = parseSyncFrame(payload);
  if (!parsed.ok) throw new Error(parsed.message);
  store.apply(parsed.value, decode(parsed.value.state));
}

test("the view model after a device-loss rebuild equals the pre-loss view model", () => {
  const store = createWorldStore();
  applied(
    store,
    framePayload(movedActor(baseState(), "woodcutter", "underworld-gate"), {
      status: "degraded",
      degradedReason: "disk-full",
      catchUpSummary: {
        appliedMs: 5000,
        skippedMs: 1000,
        majorOutcomes: ["tavern fire spread"],
      },
    }),
  );
  const before = store.viewModel();
  expect(before).toBeDefined();

  const rebuilt = createRecovery(store).rebuild();

  expect(rebuilt).toEqual(before);
});

test("rebuild recomputes from the store rather than returning the cached view model", () => {
  const store = createWorldStore();
  applied(store, framePayload(baseState()));
  const cached = store.viewModel();

  const rebuilt = createRecovery(store).rebuild();

  expect(rebuilt).not.toBe(cached);
  expect(rebuilt).toEqual(cached);
});

test("rebuild reflects the latest frame, not an earlier one", () => {
  const store = createWorldStore();
  applied(store, framePayload(baseState(), { sequence: 1 }));
  applied(
    store,
    framePayload(movedActor(baseState(), "woodcutter", "agora"), {
      sequence: 2,
    }),
  );

  expect(createRecovery(store).rebuild()?.sequence).toBe(2);
});

test("rebuild on an empty store has nothing to rebuild", () => {
  expect(createRecovery(createWorldStore()).rebuild()).toBeUndefined();
});
