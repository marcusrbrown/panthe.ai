// The repair pass every endpoint shares. A model that cannot honor a JSON
// schema natively still often answers with the right JSON wrapped in prose or
// a code fence; this pulls the JSON objects out of a reply and runs each
// through the schema's own parser until one is accepted. Promoted from the
// M0 provider-matrix probe, where every tested hosted model needed it.

import type { ParseResult } from "./config";

const FENCED_BLOCK = /```(?:json)?\s*([\s\S]*?)```/gi;

/** Every top-level `{...}` in `text`, in order. Braces inside JSON strings, and escaped quotes, do not count; an unclosed `{` is skipped so a later object is still found. */
function scanObjects(text: string): string[] {
  const found: string[] = [];
  let from = 0;
  while (from < text.length) {
    const start = text.indexOf("{", from);
    if (start === -1) {
      break;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
      } else if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end === -1) {
      from = start + 1;
    } else {
      found.push(text.slice(start, end + 1));
      from = end + 1;
    }
  }
  return found;
}

/**
 * Candidate JSON objects in a reply: those inside fenced code blocks first,
 * then any others found in the prose, each once, in the order they appear.
 */
export function extractJsonObjects(text: string): string[] {
  const candidates: string[] = [];
  const add = (object: string): void => {
    if (!candidates.includes(object)) {
      candidates.push(object);
    }
  };
  for (const fence of text.matchAll(FENCED_BLOCK)) {
    for (const object of scanObjects(fence[1] ?? "")) {
      add(object);
    }
  }
  for (const object of scanObjects(text)) {
    add(object);
  }
  return candidates;
}

/**
 * Repairs a free-text reply into a typed intent: parses each candidate
 * object as JSON and returns the first one `parse` accepts. Never throws. When
 * none is accepted, the failure is the last candidate's own reason, or
 * "no JSON object" when the reply held none.
 */
export function repairIntent<T>(
  text: string,
  parse: (candidate: unknown) => ParseResult<T>,
): ParseResult<T> {
  const candidates = extractJsonObjects(text);
  if (candidates.length === 0) {
    return { ok: false, path: "", message: "no JSON object found in reply" };
  }
  let failure: ParseResult<T> = {
    ok: false,
    path: "",
    message: "no JSON object in the reply is valid JSON",
  };
  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    const parsed = parse(value);
    if (parsed.ok) {
      return parsed;
    }
    failure = parsed;
  }
  return failure;
}
