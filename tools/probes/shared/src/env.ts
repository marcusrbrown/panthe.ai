// Captures the environment block every probe README records: hardware, OS,
// Bun version, and the pinned Tauri/three/three-flatland versions read from
// the workspace manifests, plus caller-supplied fields (model IDs etc.).
//
// Never throws: every probe (sysctl, sw_vers, manifest read) degrades to
// "unknown" independently. Never surfaces a secret: any env var whose name
// matches OPENCODE_*, *_KEY, *_TOKEN, or *_SECRET is excluded by name, and
// its value is scrubbed out of caller-supplied fields even under a
// different key name.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const UNKNOWN = "unknown";

export interface EnvironmentInfo {
  readonly hardware: {
    readonly brand: string;
    readonly memoryBytes: string;
  };
  readonly os: {
    readonly productName: string;
    readonly productVersion: string;
    readonly buildVersion: string;
  };
  readonly bun: {
    readonly version: string;
  };
  readonly pinned: {
    readonly tauri: string;
    readonly three: string;
    readonly threeFlatland: string;
  };
  /** Caller-supplied fields (e.g. model IDs), scrubbed of secret values. */
  readonly extra: Readonly<Record<string, string>>;
}

export interface EnvironmentOverrides {
  /** Fields to attach beyond the fixed hardware/OS/Bun/pinned block. */
  readonly extra?: Readonly<Record<string, string>>;
  /** Overrides the shell command runner (for tests); returns undefined on failure. */
  readonly runCommand?: (command: readonly string[]) => string | undefined;
  /** Overrides workspace root discovery (for tests). */
  readonly workspaceRoot?: string;
}

const SENSITIVE_ENV_NAME = /^(OPENCODE_|.*_KEY$|.*_TOKEN$|.*_SECRET$)/i;

function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE_ENV_NAME.test(name);
}

function sensitiveEnvValues(): ReadonlySet<string> {
  const values = new Set<string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && isSensitiveEnvName(key)) {
      values.add(value);
    }
  }
  return values;
}

/** Drops sensitively-named keys and redacts values that match a live secret env var. */
function scrubExtra(
  extra: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  if (!extra) {
    return {};
  }
  const sensitive = sensitiveEnvValues();
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (isSensitiveEnvName(key)) {
      continue;
    }
    result[key] = sensitive.has(value) ? "[redacted]" : value;
  }
  return result;
}

function defaultRunCommand(command: readonly string[]): string | undefined {
  try {
    const [executable, ...args] = command;
    if (!executable) {
      return undefined;
    }
    const result = Bun.spawnSync([executable, ...args]);
    if (result.exitCode !== 0) {
      return undefined;
    }
    const output = result.stdout.toString().trim();
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}

/** Walks up from `startDir` looking for the package.json that declares `workspaces`. */
function findWorkspaceRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
          workspaces?: unknown;
        };
        if (Array.isArray(parsed.workspaces)) {
          return dir;
        }
      } catch {
        // Malformed package.json on the way up; keep walking.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return undefined;
}

function readPinnedVersion(
  root: string | undefined,
  manifestRelativePath: string,
  dependencyName: string,
): string {
  if (!root) {
    return UNKNOWN;
  }
  try {
    const manifestPath = join(root, manifestRelativePath);
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const version =
      parsed.dependencies?.[dependencyName] ??
      parsed.devDependencies?.[dependencyName];
    return typeof version === "string" ? version : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

/** Captures the environment block for a probe README. Never throws. */
export function captureEnvironment(
  overrides: EnvironmentOverrides = {},
): EnvironmentInfo {
  const runCommand = overrides.runCommand ?? defaultRunCommand;
  const root = overrides.workspaceRoot ?? findWorkspaceRoot(import.meta.dir);

  return {
    hardware: {
      brand:
        runCommand(["sysctl", "-n", "machdep.cpu.brand_string"]) ?? UNKNOWN,
      memoryBytes: runCommand(["sysctl", "-n", "hw.memsize"]) ?? UNKNOWN,
    },
    os: {
      productName: runCommand(["sw_vers", "-productName"]) ?? UNKNOWN,
      productVersion: runCommand(["sw_vers", "-productVersion"]) ?? UNKNOWN,
      buildVersion: runCommand(["sw_vers", "-buildVersion"]) ?? UNKNOWN,
    },
    bun: {
      version:
        typeof Bun !== "undefined" && Bun.version ? Bun.version : UNKNOWN,
    },
    pinned: {
      tauri: readPinnedVersion(
        root,
        "apps/desktop/package.json",
        "@tauri-apps/cli",
      ),
      three: readPinnedVersion(root, "apps/client/package.json", "three"),
      threeFlatland: readPinnedVersion(
        root,
        "apps/client/package.json",
        "three-flatland",
      ),
    },
    extra: scrubExtra(overrides.extra),
  };
}
