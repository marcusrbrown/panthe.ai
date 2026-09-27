import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "@panthea/tools-probes-shared";
import { loadOpenCodeAuth } from "./auth";

let tempDir: string | undefined;

function writeAuthFile(content: string, mode = 0o600): string {
  tempDir = mkdtempSync(join(tmpdir(), "provider-matrix-auth-"));
  const path = join(tempDir, "auth.json");
  writeFileSync(path, content, { mode });
  return path;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("loadOpenCodeAuth", () => {
  test("parses an api-shaped record for the first matching zen key", () => {
    const path = writeAuthFile(
      JSON.stringify({ opencode: { type: "api", key: "sk-test-zen-key-1" } }),
    );
    const result = loadOpenCodeAuth({ path });
    expect(result.zen.configured).toBe(true);
    if (result.zen.configured) {
      expect(result.zen.keyName).toBe("opencode");
      expect(result.zen.mode).toBe("api");
      expect(result.zen.credential).toBe("sk-test-zen-key-1");
    }
    expect(result.go.configured).toBe(false);
  });

  test("parses an oauth-shaped record and falls back through candidate keys", () => {
    const path = writeAuthFile(
      JSON.stringify({
        zen: {
          type: "oauth",
          access: "access-token-value",
          refresh: "refresh-token-value",
          expires: 1893456000,
        },
      }),
    );
    const result = loadOpenCodeAuth({ path });
    expect(result.zen.configured).toBe(true);
    if (result.zen.configured) {
      expect(result.zen.keyName).toBe("zen");
      expect(result.zen.mode).toBe("oauth");
      expect(result.zen.credential).toBe("access-token-value");
    }
  });

  test("resolves the Go entry independently of the Zen entry", () => {
    const path = writeAuthFile(
      JSON.stringify({
        opencode: { type: "api", key: "zen-key-value" },
        "opencode-go": { type: "api", key: "go-key-value" },
      }),
    );
    const result = loadOpenCodeAuth({ path });
    expect(result.zen.configured).toBe(true);
    expect(result.go.configured).toBe(true);
    if (result.zen.configured && result.go.configured) {
      expect(result.zen.keyName).toBe("opencode");
      expect(result.go.keyName).toBe("opencode-go");
      expect(result.zen.credential).not.toBe(result.go.credential);
    }
  });

  test("missing file yields not-configured for both providers, not a throw", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "provider-matrix-auth-missing-")),
      "does-not-exist.json",
    );
    expect(() => loadOpenCodeAuth({ path })).not.toThrow();
    const result = loadOpenCodeAuth({ path });
    expect(result.zen).toEqual({ configured: false });
    expect(result.go).toEqual({ configured: false });
  });

  test("malformed JSON is reported with the file path, never the file contents", () => {
    const path = writeAuthFile("{ not valid json ");
    const result = loadOpenCodeAuth({ path });
    expect(result.zen.configured).toBe(false);
    if (!result.zen.configured && "error" in result.zen) {
      expect(result.zen.error.path).toBe(path);
      expect(result.zen.error.message).not.toContain("not valid json");
    } else {
      throw new Error("expected a malformed-auth error result");
    }
  });

  test("a non-object JSON root is reported as malformed with the path", () => {
    const path = writeAuthFile("[1, 2, 3]");
    const result = loadOpenCodeAuth({ path });
    expect(result.zen.configured).toBe(false);
    if (!result.zen.configured && "error" in result.zen) {
      expect(result.zen.error.path).toBe(path);
    } else {
      throw new Error("expected a malformed-auth error result");
    }
  });

  test("an entry present under none of the candidate keys is not configured", () => {
    const path = writeAuthFile(
      JSON.stringify({ "some-other-provider": { type: "api", key: "x" } }),
    );
    const result = loadOpenCodeAuth({ path });
    expect(result.zen).toEqual({ configured: false });
    expect(result.go).toEqual({ configured: false });
  });

  test("warns when the auth file mode is not 0600", () => {
    const path = writeAuthFile(
      JSON.stringify({ opencode: { type: "api", key: "sk-test-mode-key" } }),
      0o644,
    );
    const result = loadOpenCodeAuth({ path });
    expect(result.modeWarning).toBeDefined();
    expect(result.modeWarning).toContain(path);
  });

  test("does not warn when the auth file mode is 0600", () => {
    const path = writeAuthFile(
      JSON.stringify({ opencode: { type: "api", key: "sk-test-mode-key-2" } }),
      0o600,
    );
    const result = loadOpenCodeAuth({ path });
    expect(result.modeWarning).toBeUndefined();
  });

  test("a resolved credential is redacted by the shared harness afterward", () => {
    const secret = "sk-test-redaction-check-value";
    const path = writeAuthFile(
      JSON.stringify({ opencode: { type: "api", key: secret } }),
    );
    const result = loadOpenCodeAuth({ path });
    expect(result.zen.configured).toBe(true);
    const simulatedProviderError = `request failed: invalid credential ${secret}`;
    expect(redactSecrets(simulatedProviderError)).not.toContain(secret);
  });
});
