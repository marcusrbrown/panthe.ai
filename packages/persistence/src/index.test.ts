import { expect, test } from "bun:test";
import * as persistence from "./index";

test("barrel exports the public persistence API", () => {
  expect(typeof persistence.openStore).toBe("function");
  expect(typeof persistence.closeStore).toBe("function");
  expect(typeof persistence.commitTick).toBe("function");
  expect(typeof persistence.takeSnapshot).toBe("function");
  expect(typeof persistence.exportArchive).toBe("function");
  expect(typeof persistence.importArchive).toBe("function");
  expect(typeof persistence.applyElapsed).toBe("function");
  expect(typeof persistence.computeTick).toBe("function");
  expect(typeof persistence.migrate).toBe("function");
});
