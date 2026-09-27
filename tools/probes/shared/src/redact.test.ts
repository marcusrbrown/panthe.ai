import { afterEach, describe, expect, test } from "bun:test";
import { redactSecrets } from "./redact";

const ENV_KEY = "OPENCODE_TEST_TOKEN";

describe("redactSecrets", () => {
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  test("redacts an exact-match live env secret value", () => {
    process.env[ENV_KEY] = "abcdef1234567890";
    expect(redactSecrets("value: abcdef1234567890")).toBe("value: [redacted]");
  });

  test("redacts a secret embedded within a larger string", () => {
    process.env[ENV_KEY] = "super-secret-12345";
    const text =
      "provider error: Authorization failed for token super-secret-12345 on retry";
    const result = redactSecrets(text);
    expect(result).not.toContain("super-secret-12345");
    expect(result).toContain("[redacted]");
  });

  test("ignores env values shorter than the trivial-value floor", () => {
    process.env[ENV_KEY] = "short"; // below the 8-char floor
    expect(redactSecrets("value: short")).toBe("value: short");
  });

  test("redacts a Bearer token heuristically with no matching env var", () => {
    const text = "Authorization: Bearer abcd1234efgh5678";
    const result = redactSecrets(text);
    expect(result).not.toContain("abcd1234efgh5678");
    expect(result).toContain("[redacted]");
  });

  test("redacts an sk-prefixed key heuristically", () => {
    const text = "using key sk-proj-abcdefghijklmnop for the request";
    const result = redactSecrets(text);
    expect(result).not.toContain("sk-proj-abcdefghijklmnop");
    expect(result).toContain("[redacted]");
  });

  test("redacts a key= query-string parameter heuristically", () => {
    const text = "GET /v1/models?api_key=abcdefgh12345678 HTTP/1.1";
    const result = redactSecrets(text);
    expect(result).not.toContain("abcdefgh12345678");
    expect(result).toContain("[redacted]");
  });
});
