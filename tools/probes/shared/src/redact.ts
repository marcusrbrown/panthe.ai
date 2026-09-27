// Redacts secrets from arbitrary text before it lands in a captured
// environment block or a rendered README. Three passes, in order:
//
// 1. Every live env var value whose name matches OPENCODE_*/*_KEY/*_TOKEN/
//    *_SECRET (length >= 8, to skip trivial/placeholder values) is replaced
//    wherever it appears as a substring — not just on exact-value match, so
//    a secret embedded inside a larger string (an error body, a header
//    dump) is still caught.
// 2. Every value registered via `registerSecret` (e.g. a credential read
//    from a file rather than an env var — see auth.json below) is replaced
//    the same way. Any probe that reads a credential file (the
//    provider-matrix probe's auth.ts reading
//    ~/.local/share/opencode/auth.json) must call `registerSecret` with the
//    key before use, so it is redacted even without a Bearer/sk-/key=
//    prefix.
// 3. Common bearer/api-key shapes are redacted heuristically, so a secret
//    surfaces even when it was never registered and its source env var
//    isn't visible to this process (e.g. a token forwarded into a provider
//    error message).

const SENSITIVE_ENV_NAME = /^(OPENCODE_|.*_KEY$|.*_TOKEN$|.*_SECRET$)/i;
const MIN_SECRET_LENGTH = 8;
const REDACTED = "[redacted]";

export function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE_ENV_NAME.test(name);
}

/**
 * Module-level registry of secret values that don't come from an env var
 * (e.g. credentials read from ~/.local/share/opencode/auth.json). Values
 * shorter than `MIN_SECRET_LENGTH` are ignored to skip trivial values.
 */
const registeredSecrets = new Set<string>();

/** Registers a secret value for redaction by every subsequent `redactSecrets` call. */
export function registerSecret(value: string): void {
  if (value.length >= MIN_SECRET_LENGTH) {
    registeredSecrets.add(value);
  }
}

/** Clears the secret registry. For tests only — production probes never need this. */
export function clearRegisteredSecrets(): void {
  registeredSecrets.clear();
}

/** Live env var values (length >= `MIN_SECRET_LENGTH`) whose name looks like a secret. */
function liveSensitiveEnvValues(): readonly string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      value.length >= MIN_SECRET_LENGTH &&
      isSensitiveEnvName(key)
    ) {
      values.push(value);
    }
  }
  return values;
}

/** Env-derived and explicitly-registered secret values, longest first. */
function allKnownSecretValues(): readonly string[] {
  const values = new Set<string>([
    ...liveSensitiveEnvValues(),
    ...registeredSecrets,
  ]);
  // Longest first: if one secret value is a substring of another, redact
  // the longer one first so no fragment of it survives in the output.
  return [...values].sort((a, b) => b.length - a.length);
}

// Heuristic shapes for secrets whose source env var may not be visible to
// this process (e.g. a token embedded in a provider error body or a
// forwarded Authorization header).
const HEURISTIC_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(?:api[_-]?key|token|secret)=[^&\s"']{8,}/gi,
];

/**
 * Replaces every substring occurrence of a live secret-shaped env var value,
 * plus common bearer/api-key/query-string shapes, with `[redacted]`.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const value of allKnownSecretValues()) {
    result = result.split(value).join(REDACTED);
  }
  for (const pattern of HEURISTIC_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}
