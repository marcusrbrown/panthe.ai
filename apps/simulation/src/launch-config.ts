// What the shell hands the service at spawn, as one JSON line after the launch
// token: `{ models, offline, keys }`. `models` is the operator's routing config
// (the shape `parseRoutingConfig` accepts) or null when no settings were saved;
// `offline` is the operator's offline switch; `keys` maps a `keyRef` to the key
// the shell read from platform credential storage, for the endpoints the config
// references. Keys live only in this process's memory.
//
// A line the service cannot use never stops startup, so a hand-edited settings
// file cannot crash-loop the sidecar: god turns stay off and `problem` says
// why, for the log and the existing `model-degraded` status. A problem message
// never carries a key, and never echoes the line.

import { parseRoutingConfig, type RoutingConfig } from "@panthea/agents";

export interface LaunchConfig {
  /** The routing config, or `undefined` when none was given or it could not be used: no god takes a turn. */
  readonly routing: RoutingConfig | undefined;
  /** The operator's offline switch; false unless the line says true. */
  readonly offline: boolean;
  /** Keys by `keyRef`, held in memory for the router. */
  readonly keys: ReadonlyMap<string, string>;
  /** Why the line was not usable, safe to log; absent when the line was fine. */
  readonly problem?: string;
}

function unusable(problem: string): LaunchConfig {
  return { routing: undefined, offline: false, keys: new Map(), problem };
}

/** Parses the launch config line. Never throws, and never echoes `line`. */
export function parseLaunchConfig(line: string): LaunchConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return unusable("launch config is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return unusable("launch config is not a JSON object");
  }
  const fields = raw as Record<string, unknown>;

  const offline = fields.offline ?? false;
  if (typeof offline !== "boolean") {
    return unusable("launch config offline must be true or false");
  }

  const keys = new Map<string, string>();
  const rawKeys = fields.keys ?? {};
  if (
    typeof rawKeys !== "object" ||
    rawKeys === null ||
    Array.isArray(rawKeys)
  ) {
    return unusable("launch config keys must be an object of strings");
  }
  for (const [keyRef, key] of Object.entries(rawKeys)) {
    if (typeof key !== "string") {
      return unusable("launch config keys must be an object of strings");
    }
    keys.set(keyRef, key);
  }

  const models = fields.models ?? null;
  if (models === null) {
    return { routing: undefined, offline, keys };
  }
  const parsed = parseRoutingConfig(models);
  if (!parsed.ok) {
    return {
      routing: undefined,
      offline,
      keys,
      problem: `model settings are not valid: ${parsed.path}: ${parsed.message}`,
    };
  }
  return { routing: parsed.value, offline, keys };
}
