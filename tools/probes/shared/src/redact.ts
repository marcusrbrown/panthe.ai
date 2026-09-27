// Redacts secrets from arbitrary text before it lands in a captured
// environment block or a rendered README. Two passes:
//
// 1. Every live env var value whose name matches OPENCODE_*/*_KEY/*_TOKEN/
//    *_SECRET (length >= 8, to skip trivial/placeholder values) is replaced
//    wherever it appears as a substring — not just on exact-value match, so
//    a secret embedded inside a larger string (an error body, a header
//    dump) is still caught.
// 2. Common bearer/api-key shapes are redacted heuristically, so a secret
//    surfaces even when its source env var isn't visible to this process
//    (e.g. a token forwarded into a provider error message).

const SENSITIVE_ENV_NAME = /^(OPENCODE_|.*_KEY$|.*_TOKEN$|.*_SECRET$)/i;
const MIN_SECRET_LENGTH = 8;
const REDACTED = "[redacted]";

export function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE_ENV_NAME.test(name);
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
  // Longest first: if one secret value is a substring of another, redact
  // the longer one first so no fragment of it survives in the output.
  return values.sort((a, b) => b.length - a.length);
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
  for (const value of liveSensitiveEnvValues()) {
    result = result.split(value).join(REDACTED);
  }
  for (const pattern of HEURISTIC_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}
