// Runs exactly one fixture in a fresh QuickJS runtime + context. Every
// fixture is a single process invocation (see run.ts/host.ts), so "fresh
// runtime per execution" is inherent to the process model, not something
// this module needs to pool or reset.

import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSHandle,
  shouldInterruptAfterDeadline,
} from "quickjs-emscripten";
import { type ApiLog, assertPlainData, ValidationError, WorldApi } from "./api";

export const DEFAULT_DEADLINE_MS = 250;
export const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_STACK_SIZE_BYTES = 1 * 1024 * 1024;

export interface QuickJsRunOptions {
  readonly source: string;
  readonly deadlineMs?: number;
  readonly memoryLimitBytes?: number;
  readonly maxStackSizeBytes?: number;
  readonly invocationBudget?: number;
}

export type QuickJsLimitKind = "deadline" | "memory" | "stack";

export interface QuickJsRunResult {
  readonly ok: boolean;
  readonly returnValue: string | undefined;
  readonly errorName: string | undefined;
  readonly errorMessage: string | undefined;
  /** Whether this runtime's own setInterruptHandler deadline actually fired. */
  readonly interruptFired: boolean;
  /** Best-effort classification of which limit ended the run, if any. */
  readonly limitKind: QuickJsLimitKind | undefined;
  readonly durationMs: number;
  readonly apiLog: ApiLog;
}

// ADR-0004 world-API boundary rule for QuickJS, and the actual measured
// mechanism behind the malformed-proxy-args finding:
//
// A naive fix ("dump twice, compare") does NOT close this. `context.dump()`
// performs one `[[Get]]` per own key. `malformed-proxy-args`'s trap flips
// its answer by a global call counter's parity; with exactly two fields and
// one `get` per field per dump, each dump always starts on the same parity
// phase relative to the last, so two independent dumps of the same object
// always agree with each other -- while both being equally wrong. This was
// verified directly against the actual fixture before landing this fix.
//
// The real fix reads object fields via property *descriptors*
// (`[[GetOwnProperty]]`, `Object.getOwnPropertyDescriptor`) instead of
// ordinary property access (`[[Get]]`). A Proxy whose only trap is `get`
// (exactly what the fixture uses) has no `getOwnPropertyDescriptor` trap,
// so the default behavior reads the *target*'s real descriptor directly —
// the adversarial `get` trap is never invoked at all. `safeGetField` below
// runs entirely inside a small, host-authored (not guest-influenced) guest
// function created once per context, never exposed on `globalThis`. Any
// value read this way that is itself an accessor (getter/setter) or a
// non-standard (non-writable/enumerable/configurable) descriptor is
// rejected outright, since neither can be a value the guest "just wrote".
//
// Residual limitation: a Proxy that goes further and defines its own
// `getOwnPropertyDescriptor` trap could still fabricate a descriptor. That
// is a materially harder attack to construct (it must fake an entire
// descriptor object, not just a return value) and is not what any measured
// fixture here does; it is not closed by this fix and is out of scope for
// this probe.
function createSafeFieldExtractor(context: QuickJSContext): QuickJSHandle {
  const setup = context.evalCode(
    `(function (obj, key) {
      var desc = Object.getOwnPropertyDescriptor(obj, key);
      if (desc === undefined) {
        return undefined;
      }
      if (typeof desc.get === "function" || typeof desc.set === "function") {
        throw new TypeError("accessor property not allowed: " + key);
      }
      if (desc.writable === false || desc.enumerable === false || desc.configurable === false) {
        throw new TypeError("non-standard property descriptor not allowed: " + key);
      }
      return desc.value;
    })`,
    "safe-field-extractor.js",
  );
  return context.unwrapResult(setup);
}

function safeGetField(
  context: QuickJSContext,
  extractor: QuickJSHandle,
  objectHandle: QuickJSHandle,
  key: string,
  path: string,
): unknown {
  const keyHandle = context.newString(key);
  try {
    const result = context.callFunction(
      extractor,
      context.undefined,
      objectHandle,
      keyHandle,
    );
    if (result.error) {
      const dumped: unknown = context.dump(result.error);
      result.error.dispose();
      const message =
        dumped &&
        typeof dumped === "object" &&
        "message" in (dumped as Record<string, unknown>)
          ? String((dumped as Record<string, unknown>).message)
          : String(dumped);
      throw new ValidationError(path, message);
    }
    const value: unknown = context.dump(result.value);
    result.value.dispose();
    return value;
  } finally {
    keyHandle.dispose();
  }
}

/** Snapshots a scalar (string/number) argument: dump once, then reject
 * anything that isn't plain data (e.g. an object smuggled in place of a
 * string/number, or one carrying functions). No multi-field parity attack
 * surface exists for a single scalar read. */
function snapshotScalar(
  context: QuickJSContext,
  handle: QuickJSHandle,
  path: string,
): unknown {
  const value: unknown = context.dump(handle);
  assertPlainData(value, path);
  return value;
}

/** Snapshots `move`'s target: a known entity id string, or an `{x, y}`
 * object whose fields are read via property descriptors, never `[[Get]]`. */
function snapshotMoveTarget(
  context: QuickJSContext,
  extractor: QuickJSHandle,
  handle: QuickJSHandle,
  path: string,
): unknown {
  if (context.typeof(handle) !== "object") {
    return snapshotScalar(context, handle, path);
  }
  const snapshot = {
    x: safeGetField(context, extractor, handle, "x", `${path}.x`),
    y: safeGetField(context, extractor, handle, "y", `${path}.y`),
  };
  assertPlainData(snapshot, path);
  return snapshot;
}

function classifyLimit(
  interruptFired: boolean,
  errorName: string | undefined,
  errorMessage: string | undefined,
): QuickJsLimitKind | undefined {
  if (interruptFired) {
    return "deadline";
  }
  if (errorName === "RangeError" && /call stack/i.test(errorMessage ?? "")) {
    return "stack";
  }
  if (/memory/i.test(errorMessage ?? "") || /memory/i.test(errorName ?? "")) {
    return "memory";
  }
  return undefined;
}

export async function runQuickJsFixture(
  options: QuickJsRunOptions,
): Promise<QuickJsRunResult> {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;

  let interruptFired = false;
  const deadlineCheck = shouldInterruptAfterDeadline(Date.now() + deadlineMs);
  runtime.setInterruptHandler((rt) => {
    const shouldStop = deadlineCheck(rt);
    if (shouldStop) {
      interruptFired = true;
    }
    return shouldStop;
  });
  runtime.setMemoryLimit(
    options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES,
  );
  runtime.setMaxStackSize(
    options.maxStackSizeBytes ?? DEFAULT_MAX_STACK_SIZE_BYTES,
  );
  // No module loader is ever configured; this call is defense in depth in
  // case a future variant enables one by default.
  runtime.removeModuleLoader();

  const context = runtime.newContext();
  const worldApi = new WorldApi({ budget: options.invocationBudget });
  const fieldExtractor = createSafeFieldExtractor(context);

  const apiHandle = context.newObject();
  const moveFn = context.newFunction("move", (targetHandle) => {
    worldApi.move(
      snapshotMoveTarget(context, fieldExtractor, targetHandle, "target"),
    );
  });
  const sayFn = context.newFunction("say", (toHandle, textHandle) => {
    worldApi.say(
      snapshotScalar(context, toHandle, "to"),
      snapshotScalar(context, textHandle, "text"),
    );
  });
  const spendFn = context.newFunction("spend", (amountHandle) => {
    worldApi.spend(snapshotScalar(context, amountHandle, "amount"));
  });
  context.setProp(apiHandle, "move", moveFn);
  context.setProp(apiHandle, "say", sayFn);
  context.setProp(apiHandle, "spend", spendFn);
  context.setProp(context.global, "api", apiHandle);
  moveFn.dispose();
  sayFn.dispose();
  spendFn.dispose();
  apiHandle.dispose();

  let ok = false;
  let returnValue: string | undefined;
  let errorName: string | undefined;
  let errorMessage: string | undefined;

  const startedAt = performance.now();
  try {
    const result = context.evalCode(options.source, "fixture.js");
    if (result.error) {
      const dumped: unknown = context.dump(result.error);
      result.error.dispose();
      if (dumped && typeof dumped === "object") {
        const record = dumped as Record<string, unknown>;
        errorName = typeof record.name === "string" ? record.name : undefined;
        errorMessage =
          typeof record.message === "string"
            ? record.message
            : JSON.stringify(dumped);
      } else {
        errorMessage = String(dumped);
      }
    } else {
      ok = true;
      const dumped: unknown = context.dump(result.value);
      result.value.dispose();
      returnValue =
        typeof dumped === "string" ? dumped : JSON.stringify(dumped);
    }
  } catch (thrown) {
    errorName = thrown instanceof Error ? thrown.name : "Error";
    errorMessage = thrown instanceof Error ? thrown.message : String(thrown);
  }
  const durationMs = performance.now() - startedAt;

  worldApi.finalize(ok);

  // Undisposed handles from an interrupted/OOM run can make dispose() throw;
  // this process exits right after returning, so cleanup here is best
  // effort and never allowed to mask the fixture's own result.
  try {
    fieldExtractor.dispose();
  } catch {
    // ignore
  }
  try {
    context.dispose();
  } catch {
    // ignore
  }
  try {
    runtime.dispose();
  } catch {
    // ignore
  }

  return {
    ok,
    returnValue,
    errorName,
    errorMessage,
    interruptFired,
    limitKind: classifyLimit(interruptFired, errorName, errorMessage),
    durationMs,
    apiLog: worldApi.getLog(),
  };
}
