import { expect, test } from "bun:test";
import * as telemetry from "./index";

test("barrel exports the public telemetry API", () => {
  expect(typeof telemetry.ensureTraceSchema).toBe("function");
  expect(typeof telemetry.recordObservation).toBe("function");
  expect(typeof telemetry.recordProposalOutcome).toBe("function");
  expect(typeof telemetry.recordReceipt).toBe("function");
  expect(typeof telemetry.pruneRetention).toBe("function");
  expect(typeof telemetry.followEvent).toBe("function");
  expect(typeof telemetry.followProposal).toBe("function");
});
