// Where the service finds its model routing: a JSON file the operator points
// `PANTHEA_MODEL_CONFIG` at, parsed by the agent layer's own parser. Without
// it no god takes a turn and the world runs on routines alone. The settings
// view and Keychain (plan Unit 3) will replace this source, not the parser.

import { readFileSync } from "node:fs";
import { parseRoutingConfig, type RoutingConfig } from "@panthea/agents";

/**
 * The routing config named by `env.PANTHEA_MODEL_CONFIG`, or `undefined` when
 * none is set. A file that cannot be read or does not parse throws with the
 * reason: a config the operator wrote and the service cannot use is a startup
 * error, not a silent world with idle gods.
 */
export function loadRoutingConfig(
  env: NodeJS.ProcessEnv = process.env,
): RoutingConfig | undefined {
  const path = env.PANTHEA_MODEL_CONFIG;
  if (!path) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `model config ${path} could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = parseRoutingConfig(raw);
  if (!parsed.ok) {
    throw new Error(
      `model config ${path} is not valid: ${parsed.path}: ${parsed.message}`,
    );
  }
  return parsed.value;
}
