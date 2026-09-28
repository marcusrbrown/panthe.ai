import { expect, test } from "bun:test";
import * as contracts from "./index";

test("barrel exports every top-level parser", () => {
  expect(typeof contracts.parseProposal).toBe("function");
  expect(typeof contracts.parseObservationRecord).toBe("function");
  expect(typeof contracts.parseEvent).toBe("function");
  expect(typeof contracts.parseSyncFrame).toBe("function");
  expect(typeof contracts.parseArchiveManifest).toBe("function");
  expect(typeof contracts.parseContentPack).toBe("function");
  expect(typeof contracts.parseWorldId).toBe("function");
  expect(typeof contracts.createEntityId).toBe("function");
});
