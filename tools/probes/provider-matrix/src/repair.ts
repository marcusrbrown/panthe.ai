// The single repair path used by every adapter (Zen /responses, Zen
// /chat/completions, Go, Ollama, and the OpenAI/Anthropic contract fixtures)
// when a model's reply isn't already a clean JSON object: extract the first
// JSON object from a fenced code block or prose, then run it through the
// shared `parseAction`. Using one function for every adapter is what makes
// "native vs repaired" parity measurable rather than assumed (Unit 6
// approach).

import {
  type Action,
  type ParseResult,
  parseAction,
} from "@panthea/tools-probes-shared";

const FENCED_BLOCK = /```(?:json)?\s*([\s\S]*?)```/i;

/**
 * Extracts the first balanced `{...}` JSON object from a reply. Prefers the
 * contents of a fenced code block when one is present; falls back to
 * scanning the raw text (prose-wrapped replies). Returns `undefined` when no
 * balanced object is found.
 */
export function extractFirstJsonObject(text: string): string | undefined {
  const fenced = FENCED_BLOCK.exec(text);
  const candidate = fenced?.[1] ?? text;

  const start = candidate.indexOf("{");
  if (start === -1) {
    return undefined;
  }

  let depth = 0;
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return candidate.slice(start, index + 1);
      }
    }
  }
  return undefined;
}

/**
 * Repairs a free-text model reply into a validated {@link Action}: extract
 * the first JSON object (fenced or prose), parse it, then run it through
 * `parseAction`. Never throws — a reply with no valid action fails the same
 * way (a `ParseFailure`) regardless of which adapter produced the text.
 */
export function repairAction(text: string): ParseResult<Action> {
  const jsonText = extractFirstJsonObject(text);
  if (!jsonText) {
    return { ok: false, path: "", message: "no JSON object found in reply" };
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(jsonText);
  } catch {
    return {
      ok: false,
      path: "",
      message: "extracted text is not valid JSON",
    };
  }

  return parseAction(candidate);
}
