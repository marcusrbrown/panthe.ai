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
export const MAX_JOBS_TOTAL = 50_000;
const JOBS_PER_BATCH = 500;

export interface QuickJsRunOptions {
  readonly source: string;
  readonly deadlineMs?: number;
  readonly memoryLimitBytes?: number;
  readonly maxStackSizeBytes?: number;
  readonly invocationBudget?: number;
}

export type QuickJsLimitKind =
  | "deadline"
  | "memory"
  | "stack"
  | "string-length"
  | "job-budget";

export interface QuickJsRunResult {
  readonly ok: boolean;
  readonly returnValue: string | undefined;
  readonly errorName: string | undefined;
  readonly errorMessage: string | undefined;
  /** Whether this runtime's own setInterruptHandler deadline actually fired
   * (either during the top-level script or during the pending-job pump). */
  readonly interruptFired: boolean;
  /** Best-effort classification of which limit ended the run, if any. */
  readonly limitKind: QuickJsLimitKind | undefined;
  /** Number of microtask/promise-reaction jobs drained after the top-level
   * script returned. 0 for any fixture that never queues one. */
  readonly jobsExecuted: number;
  readonly durationMs: number;
  readonly apiLog: ApiLog;
}

// ADR-0004 world-API boundary rule for QuickJS, and the two rounds of
// measured mechanism behind the malformed-proxy-args family of findings:
//
// Round 1 (naive fix, measured to fail): "dump the handle twice, reject on
// disagreement". `context.dump()` performs one `[[Get]]` per own key;
// `malformed-proxy-args`'s trap flips its answer by call-count parity, and
// with exactly two fields and one `get` per field per dump, every dump
// starts on the same parity phase as the last, so two independent dumps of
// the same object always agree with each other while both are equally
// wrong. Verified directly against the running fixture before discarding.
//
// Round 2 (property descriptors, still broken): read fields via
// `Object.getOwnPropertyDescriptor` instead of `[[Get]]`, via a small
// helper function *evaluated once inside the guest context* before the
// fixture ran. This closed the parity-flip Proxy (its only trap was
// `get`), but Fro Bot's review reproduced a stronger bypass: the helper's
// own body still referenced the *identifier* `Object.getOwnPropertyDescriptor`
// -- a live, dynamic lookup resolved at CALL TIME, not at the time the
// helper was defined. A fixture that reassigns
// `Object.getOwnPropertyDescriptor` to a function returning a fabricated
// descriptor, before ever calling `api.move()`, poisoned that lookup and
// the helper faithfully read the fabricated (poisoned) value back.
// Reproduced directly: `malformed-overwrite-descriptor-fn` committed
// `{x: 999999, ...}` before this fix.
//
// Round 3 (this fix): capture the *function value* of
// `Object.getOwnPropertyDescriptor` as a `QuickJSHandle` immediately after
// `newContext()`, before any guest source ever evaluates. Every later
// field read calls that captured handle directly via
// `context.callFunction`, never by looking up an identifier again -- so
// there is no global binding left for a guest to poison. All of the
// validation logic (checking for an accessor, checking
// writable/enumerable/configurable, extracting `.value`) is now done
// host-side by reading properties off the *descriptor object the captured
// function returns*, which is always a fresh, non-exotic, engine-created
// object (per spec, `Object.getOwnPropertyDescriptor` never returns
// anything but `undefined` or a freshly created ordinary object) -- so
// reading ITS properties is safe regardless of what the argument itself
// was.
//
// Residual, accepted limitation: capturing the function only stops a
// *global reassignment* attack. A `Proxy` that defines its OWN
// `getOwnPropertyDescriptor` trap is still legitimately invoked by the
// real, captured function (this is required, correct behavior per the
// object model -- the trap IS the proxy's `[[GetOwnProperty]]`). Such a
// trap can fabricate the VALUE inside an otherwise well-formed descriptor
// (see `malformed-proxy-descriptor-trap`), but it cannot escape the host,
// corrupt unrelated fields, or bypass the ordinary value-schema validation
// that still runs on whatever value comes back. That is a bounded,
// measured, and accepted gap -- not a host-boundary breach -- documented
// in the README.
interface CapturedIntrinsics {
  readonly getOwnPropertyDescriptor: QuickJSHandle;
}

function captureIntrinsics(context: QuickJSContext): CapturedIntrinsics {
  const objectCtor = context.getProp(context.global, "Object");
  try {
    return {
      getOwnPropertyDescriptor: context.getProp(
        objectCtor,
        "getOwnPropertyDescriptor",
      ),
    };
  } finally {
    objectCtor.dispose();
  }
}

function disposeIntrinsics(intrinsics: CapturedIntrinsics): void {
  intrinsics.getOwnPropertyDescriptor.dispose();
}

/**
 * Reads one own field of `objectHandle` via the *captured* (pre-guest)
 * `Object.getOwnPropertyDescriptor`, never via `[[Get]]` and never via a
 * guest-visible identifier lookup. Rejects accessor (getter/setter) and
 * non-standard descriptors outright.
 */
function safeGetOwnField(
  context: QuickJSContext,
  intrinsics: CapturedIntrinsics,
  objectHandle: QuickJSHandle,
  key: string,
  path: string,
): unknown {
  const keyHandle = context.newString(key);
  let descHandle: QuickJSHandle | undefined;
  try {
    descHandle = context.unwrapResult(
      context.callFunction(
        intrinsics.getOwnPropertyDescriptor,
        context.undefined,
        objectHandle,
        keyHandle,
      ),
    );
    if (context.typeof(descHandle) === "undefined") {
      return undefined;
    }
    const getHandle = context.getProp(descHandle, "get");
    const setHandle = context.getProp(descHandle, "set");
    const hasAccessor =
      context.typeof(getHandle) === "function" ||
      context.typeof(setHandle) === "function";
    getHandle.dispose();
    setHandle.dispose();
    if (hasAccessor) {
      throw new ValidationError(path, `accessor property not allowed: ${key}`);
    }

    const writableHandle = context.getProp(descHandle, "writable");
    const enumerableHandle = context.getProp(descHandle, "enumerable");
    const configurableHandle = context.getProp(descHandle, "configurable");
    const writable: unknown = context.dump(writableHandle);
    const enumerable: unknown = context.dump(enumerableHandle);
    const configurable: unknown = context.dump(configurableHandle);
    writableHandle.dispose();
    enumerableHandle.dispose();
    configurableHandle.dispose();
    if (writable === false || enumerable === false || configurable === false) {
      throw new ValidationError(
        path,
        `non-standard property descriptor not allowed: ${key}`,
      );
    }

    const valueHandle = context.getProp(descHandle, "value");
    const value: unknown = context.dump(valueHandle);
    valueHandle.dispose();
    return value;
  } finally {
    descHandle?.dispose();
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
 * object whose fields are read via captured property descriptors, never
 * `[[Get]]` and never a re-looked-up guest identifier. */
function snapshotMoveTarget(
  context: QuickJSContext,
  intrinsics: CapturedIntrinsics,
  handle: QuickJSHandle,
  path: string,
): unknown {
  if (context.typeof(handle) !== "object") {
    return snapshotScalar(context, handle, path);
  }
  const snapshot = {
    x: safeGetOwnField(context, intrinsics, handle, "x", `${path}.x`),
    y: safeGetOwnField(context, intrinsics, handle, "y", `${path}.y`),
  };
  assertPlainData(snapshot, path);
  return snapshot;
}

function classifyLimit(
  interruptFired: boolean,
  errorName: string | undefined,
  errorMessage: string | undefined,
  jobBudgetExceeded: boolean,
): QuickJsLimitKind | undefined {
  if (interruptFired) {
    return "deadline";
  }
  if (jobBudgetExceeded) {
    return "job-budget";
  }
  if (errorName === "RangeError" && /call stack/i.test(errorMessage ?? "")) {
    return "stack";
  }
  if (/string.*too long|too long.*string/i.test(errorMessage ?? "")) {
    return "string-length";
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
  // Captured before a single byte of guest source has evaluated: nothing
  // the guest does from this point on can affect what these handles refer
  // to, only what they read (Proxy exotic behavior, not name resolution).
  const intrinsics = captureIntrinsics(context);
  const worldApi = new WorldApi({ budget: options.invocationBudget });

  const apiHandle = context.newObject();
  const moveFn = context.newFunction("move", (targetHandle) => {
    worldApi.move(
      snapshotMoveTarget(context, intrinsics, targetHandle, "target"),
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
  let jobsExecuted = 0;
  let jobBudgetExceeded = false;

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

      // The top-level script returned normally, but may have queued
      // microtask/promise-reaction jobs (e.g. an infinitely self-requeuing
      // `.then()` chain). Drain them under the SAME interrupt deadline so
      // an adversarial job chain is measured, not silently ignored — a
      // driver that never calls this can never observe an async hang at
      // all, which is a different (weaker) claim than "async hangs are
      // bounded".
      while (runtime.hasPendingJob() && jobsExecuted < MAX_JOBS_TOTAL) {
        const jobResult = runtime.executePendingJobs(JOBS_PER_BATCH);
        if (jobResult.error) {
          const dumpedJobError: unknown = context.dump(jobResult.error);
          jobResult.error.dispose();
          ok = false;
          returnValue = undefined;
          if (dumpedJobError && typeof dumpedJobError === "object") {
            const record = dumpedJobError as Record<string, unknown>;
            errorName =
              typeof record.name === "string" ? record.name : undefined;
            errorMessage =
              typeof record.message === "string"
                ? record.message
                : JSON.stringify(dumpedJobError);
          } else {
            errorMessage = String(dumpedJobError);
          }
          break;
        }
        jobsExecuted += jobResult.value;
      }
      if (ok && jobsExecuted >= MAX_JOBS_TOTAL && runtime.hasPendingJob()) {
        jobBudgetExceeded = true;
        ok = false;
        returnValue = undefined;
        errorName = "JobBudgetExceededError";
        errorMessage = `pending-job pump exceeded ${MAX_JOBS_TOTAL} executed jobs with jobs still queued`;
      }
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
    disposeIntrinsics(intrinsics);
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
    limitKind: classifyLimit(
      interruptFired,
      errorName,
      errorMessage,
      jobBudgetExceeded,
    ),
    jobsExecuted,
    durationMs,
    apiLog: worldApi.getLog(),
  };
}
