/**
 * JSON text with object keys sorted at every depth and `undefined` values
 * dropped, so two values that mean the same thing compare equal as text
 * whatever order their keys arrived in. Used to decide whether a second
 * submission is an exact reuse of a first (an observation, a journaled
 * proposal) or a conflicting one.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
