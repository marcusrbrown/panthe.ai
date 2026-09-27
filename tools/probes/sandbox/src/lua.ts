// Runs exactly one fixture in a fresh wasmoon Lua engine. Every fixture is a
// single process invocation (see run.ts/host.ts), so "fresh engine per
// execution" is inherent to the process model.
//
// `LuaFactory.createEngine`'s top-level `engine.doString()` only applies
// `functionTimeout` to JS callbacks invoked *from* Lua — a pure Lua infinite
// loop with no host callback is never timed out that way. This module
// bypasses `doString` and drives `Thread.run(argCount, { timeout })`
// directly, which installs a `lua_sethook` instruction-count hook on the
// executing thread and is the mechanism that actually bounds a bare Lua
// loop.

import { LuaFactory } from "wasmoon";
import { type ApiLog, assertPlainData, ValidationError, WorldApi } from "./api";

// ADR-0004 world-API boundary rule for Lua: deep-clone every argument via
// `structuredClone` before validation, then reject anything the clone
// still carries that isn't plain data. wasmoon's function-call bridge
// already converts Lua tables to plain JS objects with already-realized
// values (no live getter/Proxy analog survives the boundary, since
// `enableProxy: false` and the base library that would expose
// `getmetatable`/`setmetatable` is never opened) — so the specific
// parity-flip TOCTOU measured on the QuickJS arm has no equivalent attack
// surface here. `structuredClone` + `assertPlainData` is applied anyway,
// as the same rule QuickJS follows, not because a live exploit was found.
function snapshotArgument(value: unknown, path: string): unknown {
  let cloned: unknown;
  try {
    cloned = structuredClone(value);
  } catch (thrown) {
    throw new ValidationError(
      path,
      `argument could not be cloned to plain data: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
    );
  }
  assertPlainData(cloned, path);
  return cloned;
}

// `Thread.assertOk()` always throws a fresh `new Error(...)` on a Lua
// runtime error — it never rethrows the original `LuaTimeoutError` object,
// even though the underlying `lua_sethook` count hook pushed one before
// calling `lua_error`. The only surviving signal is the message text
// `Thread.setTimeout`'s hook always uses, so that is what this module
// matches on rather than `instanceof LuaTimeoutError`.
const LUA_TIMEOUT_MESSAGE = "thread timeout exceeded";

export const DEFAULT_DEADLINE_MS = 250;

export interface LuaRunOptions {
  readonly source: string;
  readonly deadlineMs?: number;
  readonly invocationBudget?: number;
}

export interface LuaRunResult {
  readonly ok: boolean;
  readonly returnValue: string | undefined;
  readonly errorMessage: string | undefined;
  /** Whether the lua_sethook count-hook deadline (LuaTimeoutError) fired. */
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly apiLog: ApiLog;
}

export async function runLuaFixture(
  options: LuaRunOptions,
): Promise<LuaRunResult> {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const factory = new LuaFactory();
  const engine = await factory.createEngine({
    openStandardLibs: false,
    injectObjects: false,
    enableProxy: false,
    functionTimeout: deadlineMs,
  });

  const worldApi = new WorldApi({ budget: options.invocationBudget });
  engine.global.set("api", {
    move: (target: unknown) =>
      worldApi.move(snapshotArgument(target, "target")),
    say: (to: unknown, text: unknown) =>
      worldApi.say(snapshotArgument(to, "to"), snapshotArgument(text, "text")),
    spend: (amount: unknown) =>
      worldApi.spend(snapshotArgument(amount, "amount")),
  });

  let ok = false;
  let returnValue: string | undefined;
  let errorMessage: string | undefined;
  let timedOut = false;

  const startedAt = performance.now();
  try {
    const thread = engine.global.newThread();
    const threadIndex = engine.global.getTop();
    try {
      thread.loadString(options.source, "fixture");
      const result = await thread.run(0, { timeout: deadlineMs });
      ok = true;
      const first: unknown = result.length > 0 ? result[0] : undefined;
      if (typeof first === "string") {
        returnValue = first;
      } else if (first !== undefined) {
        returnValue = JSON.stringify(first);
      }
    } finally {
      engine.global.remove(threadIndex);
    }
  } catch (thrown) {
    errorMessage = thrown instanceof Error ? thrown.message : String(thrown);
    timedOut = errorMessage.includes(LUA_TIMEOUT_MESSAGE);
  }
  const durationMs = performance.now() - startedAt;

  worldApi.finalize(ok);

  // This process exits right after returning; cleanup here is best effort
  // and never allowed to mask the fixture's own result.
  try {
    engine.global.close();
  } catch {
    // ignore
  }

  return {
    ok,
    returnValue,
    errorMessage,
    timedOut,
    durationMs,
    apiLog: worldApi.getLog(),
  };
}
