import { expect, test } from "bun:test";
import { loadContentPack } from "./index";

test("the barrel export re-exports loadContentPack", () => {
  expect(typeof loadContentPack).toBe("function");
});
