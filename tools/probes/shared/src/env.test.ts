import { afterEach, describe, expect, test } from "bun:test";
import { captureEnvironment } from "./env";

const SEEDED_KEY = "OPENCODE_API_KEY";
const SEEDED_VALUE = "seeded-secret-value-12345";

describe("captureEnvironment", () => {
  afterEach(() => {
    delete process.env[SEEDED_KEY];
  });

  test("never surfaces a value from an OPENCODE_*/*_KEY/*_TOKEN/*_SECRET env var", () => {
    process.env[SEEDED_KEY] = SEEDED_VALUE;
    const environment = captureEnvironment({
      extra: { modelId: SEEDED_VALUE, [SEEDED_KEY]: SEEDED_VALUE },
    });
    const serialized = JSON.stringify(environment);
    expect(serialized).not.toContain(SEEDED_VALUE);
    expect(Object.keys(environment.extra)).not.toContain(SEEDED_KEY);
  });

  test("partial/failing environment probes render 'unknown', never throw", () => {
    expect(() => {
      const environment = captureEnvironment({
        runCommand: () => undefined,
        workspaceRoot: "/nonexistent-workspace-root",
      });
      expect(environment.hardware.brand).toBe("unknown");
      expect(environment.hardware.memoryBytes).toBe("unknown");
      expect(environment.os.productName).toBe("unknown");
      expect(environment.os.productVersion).toBe("unknown");
      expect(environment.os.buildVersion).toBe("unknown");
      expect(environment.pinned.tauri).toBe("unknown");
      expect(environment.pinned.three).toBe("unknown");
      expect(environment.pinned.threeFlatland).toBe("unknown");
      expect(environment.bun.version.length).toBeGreaterThan(0);
    }).not.toThrow();
  });

  test("caller-supplied extra fields pass through untouched when not sensitive", () => {
    const environment = captureEnvironment({
      extra: { modelId: "qwen3.5-4b-q4" },
    });
    expect(environment.extra.modelId).toBe("qwen3.5-4b-q4");
  });

  test("redacts a secret embedded within a larger string in an extra field", () => {
    process.env[SEEDED_KEY] = SEEDED_VALUE;
    const environment = captureEnvironment({
      extra: { provider: `Bearer token failure: ${SEEDED_VALUE} was rejected` },
    });
    expect(environment.extra.provider).not.toContain(SEEDED_VALUE);
    expect(environment.extra.provider).toContain("[redacted]");
  });
});
