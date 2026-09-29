import { describe, expect, test } from "bun:test";
import { parseFrameBody } from "./client";

describe("parseFrameBody", () => {
  test("a body that is not a sync frame is a named failure, never a frame", () => {
    const result = parseFrameBody({
      sessionId: "s",
      sequence: 1,
      status: "running",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/frame/);
      expect(result.message.length).toBeGreaterThan(10);
    }
  });

  test("a non-object body is a failure", () => {
    expect(parseFrameBody("Unauthorized").ok).toBe(false);
    expect(parseFrameBody(null).ok).toBe(false);
  });
});
