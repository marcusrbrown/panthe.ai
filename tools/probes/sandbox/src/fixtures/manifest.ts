// Fixture matrix manifest: one entry per adversarial (or happy-path)
// scenario, grouped into the seven README categories plus a happy-path
// baseline. Each entry names the guest source file(s) relative to this
// directory; a language without a meaningful equivalent simply omits that
// field (documented per-fixture, not silently skipped).

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Runtime = "quickjs" | "lua";

export type FixtureCategory =
  | "happy-path"
  | "external-capability"
  | "loop-recursion"
  | "allocation"
  | "async-hang"
  | "malformed-input"
  | "partial-failure";

/** The four outcome buckets the README matrix reports per fixture. */
export type FixtureOutcome = "blocked" | "terminated" | "escaped" | "completed";

export interface FixtureDefinition {
  readonly id: string;
  readonly category: FixtureCategory;
  readonly description: string;
  readonly expectedOutcome: FixtureOutcome;
  readonly quickjsFile?: string;
  readonly luaFile?: string;
}

export const FIXTURES: readonly FixtureDefinition[] = [
  // --- happy path -----------------------------------------------------
  {
    id: "happy-path",
    category: "happy-path",
    description: "A valid behavior calls move then say and returns normally.",
    expectedOutcome: "completed",
    quickjsFile: "quickjs/happy-path/happy-path.js",
    luaFile: "lua/happy-path/happy-path.lua",
  },

  // --- external capability access -------------------------------------
  {
    id: "external-require",
    category: "external-capability",
    description: "require/import a host module (node:fs / io).",
    expectedOutcome: "blocked",
    quickjsFile: "quickjs/external-capability/require.js",
    luaFile: "lua/external-capability/require.lua",
  },
  {
    id: "external-io-os",
    category: "external-capability",
    description: "Reach io/os (file open, os.execute).",
    expectedOutcome: "blocked",
    quickjsFile: undefined,
    luaFile: "lua/external-capability/io.lua",
  },
  {
    id: "external-process",
    category: "external-capability",
    description: "Reach the host process object (process.exit) or os.execute.",
    expectedOutcome: "blocked",
    quickjsFile: "quickjs/external-capability/process.js",
    luaFile: "lua/external-capability/os-execute.lua",
  },
  {
    id: "external-fetch",
    category: "external-capability",
    description:
      "Reach network egress via fetch(). No Lua equivalent without injectObjects.",
    expectedOutcome: "blocked",
    quickjsFile: "quickjs/external-capability/fetch.js",
  },
  {
    id: "external-bun-global",
    category: "external-capability",
    description: "Reach the Bun global (Bun.spawn). No Lua equivalent.",
    expectedOutcome: "blocked",
    quickjsFile: "quickjs/external-capability/bun-global.js",
  },
  {
    id: "external-globalthis-leak",
    category: "external-capability",
    description:
      "Enumerate globalThis / _G for any host-provided identifier beyond the injected api and core language builtins.",
    expectedOutcome: "blocked",
    quickjsFile: "quickjs/external-capability/globalthis-leak.js",
    luaFile: "lua/external-capability/global-table.lua",
  },
  {
    id: "external-function-eval-ctor",
    category: "external-capability",
    description:
      "Function constructor / dynamic code loading (Function(...) / Lua load()).",
    expectedOutcome: "blocked",
    quickjsFile: "quickjs/external-capability/function-ctor.js",
    luaFile: "lua/external-capability/load-dynamic.lua",
  },
  {
    id: "external-symbol-for",
    category: "external-capability",
    description: "Symbol.for cross-realm registry probing. No Lua equivalent.",
    expectedOutcome: "blocked",
    quickjsFile: "quickjs/external-capability/symbol-for.js",
  },
  {
    id: "external-webassembly",
    category: "external-capability",
    description:
      "Instantiate WebAssembly from inside the guest. No Lua equivalent.",
    expectedOutcome: "blocked",
    quickjsFile: "quickjs/external-capability/webassembly.js",
  },
  {
    id: "external-atomics-wait",
    category: "external-capability",
    description: "Call Atomics.wait. No Lua equivalent.",
    expectedOutcome: "blocked",
    quickjsFile: "quickjs/external-capability/atomics-wait.js",
  },
  {
    id: "external-timers",
    category: "external-capability",
    description:
      "Reach a host timer (setTimeout). No Lua equivalent without injectObjects.",
    expectedOutcome: "blocked",
    quickjsFile: "quickjs/external-capability/timers.js",
  },

  // --- loop / recursion -------------------------------------------------
  {
    id: "loop-infinite",
    category: "loop-recursion",
    description: "Infinite loop with no exit condition.",
    expectedOutcome: "terminated",
    quickjsFile: "quickjs/loop-recursion/infinite-loop.js",
    luaFile: "lua/loop-recursion/infinite-loop.lua",
  },
  {
    id: "loop-deep-recursion",
    category: "loop-recursion",
    description: "Unbounded tail-position recursion.",
    expectedOutcome: "terminated",
    quickjsFile: "quickjs/loop-recursion/deep-recursion.js",
    luaFile: "lua/loop-recursion/deep-recursion.lua",
  },

  // --- allocation ---------------------------------------------------------
  {
    id: "allocation-array-growth",
    category: "allocation",
    description: "Unbounded array growth.",
    expectedOutcome: "terminated",
    quickjsFile: "quickjs/allocation/array-growth.js",
    luaFile: "lua/allocation/table-growth.lua",
  },
  {
    id: "allocation-string-doubling",
    category: "allocation",
    description: "Exponential string growth via repeated self-concatenation.",
    expectedOutcome: "terminated",
    quickjsFile: "quickjs/allocation/string-doubling.js",
    luaFile: "lua/allocation/string-concat-growth.lua",
  },
  {
    id: "allocation-json-stringify-bomb",
    category: "allocation",
    description:
      "Growing array repeatedly serialized via JSON.stringify. No Lua equivalent (no JSON without a library).",
    expectedOutcome: "terminated",
    quickjsFile: "quickjs/allocation/json-stringify-bomb.js",
  },

  // --- async hang -----------------------------------------------------
  {
    id: "async-unresolved-promise",
    category: "async-hang",
    description: "An unresolved promise with no attached reaction.",
    expectedOutcome: "completed",
    quickjsFile: "quickjs/async-hang/unresolved-promise.js",
  },
  {
    id: "async-microtask-recursion",
    category: "async-hang",
    description: "An infinitely self-requeuing microtask chain.",
    expectedOutcome: "terminated",
    quickjsFile: "quickjs/async-hang/microtask-recursion.js",
  },
  {
    id: "async-coroutine-attempt",
    category: "async-hang",
    description:
      "Create/yield a coroutine (standard library, expected absent).",
    expectedOutcome: "blocked",
    luaFile: "lua/async-hang/coroutine-attempt.lua",
  },

  // --- malformed API input ---------------------------------------------
  {
    id: "malformed-wrong-types",
    category: "malformed-input",
    description: "Call move() with a wrong-shaped argument.",
    expectedOutcome: "blocked",
    quickjsFile: "quickjs/malformed-input/wrong-types.js",
    luaFile: "lua/malformed-input/wrong-types.lua",
  },
  {
    id: "malformed-stale-entity-id",
    category: "malformed-input",
    description: "Call say() targeting an unknown entity id.",
    expectedOutcome: "blocked",
    quickjsFile: "quickjs/malformed-input/stale-entity-id.js",
    luaFile: "lua/malformed-input/stale-entity-id.lua",
  },
  {
    id: "malformed-over-budget",
    category: "malformed-input",
    description: "Call spend() 100 times against a 50-call budget.",
    expectedOutcome: "blocked",
    quickjsFile: "quickjs/malformed-input/over-budget.js",
    luaFile: "lua/malformed-input/over-budget.lua",
  },
  {
    id: "malformed-proxy-args",
    category: "malformed-input",
    description:
      "Pass a Proxy with a parity-flipping get trap as move()'s target (TOCTOU probe). A well-formed target legitimately succeeds; the check is whether the *committed* values are the true ones, not the trap's poisoned ones. No Lua equivalent (no Proxy without enableProxy).",
    expectedOutcome: "completed",
    quickjsFile: "quickjs/malformed-input/proxy-args.js",
  },
  {
    id: "malformed-getter-side-effect",
    category: "malformed-input",
    description:
      "Pass an object whose x/y are accessor properties (getters). The host's safe-field extractor rejects any get/set-carrying descriptor outright, so the getter never runs at all, benign or not.",
    expectedOutcome: "blocked",
    quickjsFile: "quickjs/malformed-input/getter-side-effect.js",
  },
  {
    id: "malformed-nested-getter-parity",
    category: "malformed-input",
    description:
      "Same parity-flip idea as malformed-proxy-args, reached through plain (non-Proxy) accessor properties one layer of nesting down, to confirm the descriptor-based defense generalizes beyond Proxy.",
    expectedOutcome: "blocked",
    quickjsFile: "quickjs/malformed-input/nested-getter-parity.js",
  },
  {
    id: "malformed-coercion",
    category: "malformed-input",
    description:
      "Pass an object with valueOf/toString to spend(), hoping for implicit coercion.",
    expectedOutcome: "blocked",
    quickjsFile: "quickjs/malformed-input/coercion-tostring-valueof.js",
  },
  {
    id: "malformed-string-metatable",
    category: "malformed-input",
    description:
      "Call a string method (:upper()) that only exists via the string library's metatable.",
    expectedOutcome: "blocked",
    luaFile: "lua/malformed-input/string-metatable-reach.lua",
  },

  // --- partial-failure rollback ------------------------------------------
  {
    id: "partial-failure",
    category: "partial-failure",
    description:
      "Two committed calls, then a thrown/runtime error ends the script.",
    expectedOutcome: "completed",
    quickjsFile: "quickjs/partial-failure/partial-failure.js",
    luaFile: "lua/partial-failure/partial-failure.lua",
  },
];

/** `next-run-health` is a host-level composite (not a single fixture): run
 * `NEXT_RUN_HEALTH_PROBE_FIXTURE` immediately after any terminated fixture in
 * a fresh runtime and confirm it still completes normally. */
export const NEXT_RUN_HEALTH_PROBE_FIXTURE = "happy-path";

export function getFixture(id: string): FixtureDefinition {
  const found = FIXTURES.find((fixture) => fixture.id === id);
  if (!found) {
    throw new Error(`unknown fixture id: ${id}`);
  }
  return found;
}

export function fixturesForRuntime(
  runtime: Runtime,
): readonly FixtureDefinition[] {
  return FIXTURES.filter((fixture) =>
    runtime === "quickjs"
      ? fixture.quickjsFile !== undefined
      : fixture.luaFile !== undefined,
  );
}

/** Reads a fixture's guest source for `runtime`. Throws if not applicable. */
export function readFixtureSource(
  fixture: FixtureDefinition,
  runtime: Runtime,
): string {
  const relative =
    runtime === "quickjs" ? fixture.quickjsFile : fixture.luaFile;
  if (!relative) {
    throw new Error(`fixture ${fixture.id} has no ${runtime} source`);
  }
  return readFileSync(join(import.meta.dir, relative), "utf8");
}
