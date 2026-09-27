// The malformed-proxy-args escape/fix narrative, split out of run.ts so it
// can be unit-tested against a synthetic `records` array without importing
// run.ts itself (run.ts is a CLI entry point that executes `main()` at
// import time).

import { getFixture } from "./fixtures/manifest";
import type { FixtureRunRecord } from "./host";

/** Every fixture whose whole purpose is proving the descriptor-capture fix
 * (and its documented residual limitation) holds. All five must actually
 * have run AND match their own manifest-declared expected outcome —
 * missing or `terminated` is never "closed", it's unverified. */
const INTEGRITY_FIXTURE_IDS = [
  "malformed-proxy-args",
  "malformed-getter-side-effect",
  "malformed-nested-getter-parity",
  "malformed-overwrite-descriptor-fn",
  "malformed-proxy-descriptor-trap",
] as const;

export interface IntegrityCheck {
  readonly fixtureId: string;
  readonly ok: boolean;
  readonly reason: string;
}

/** Checks every integrity fixture against its own manifest-declared
 * `expectedOutcome`. `host.ts`'s `applyExpectationOverride` already folds a
 * committed-calls/status mismatch into the recorded `outcome` (as
 * `escaped`), so comparing `outcome === expectedOutcome` here is sufficient
 * — it does not re-implement that comparison. A record that never ran at
 * all, or that ended `terminated` for an unrelated reason (crash, deadline,
 * supervisor kill), fails this check exactly like a value mismatch does:
 * there is no run whose outcome confirms the fix, so it cannot be called
 * closed. */
export function checkIntegrityFixtures(
  records: readonly FixtureRunRecord[],
): readonly IntegrityCheck[] {
  return INTEGRITY_FIXTURE_IDS.map((fixtureId) => {
    const record = records.find(
      (r) => r.fixtureId === fixtureId && r.runtime === "quickjs",
    );
    if (!record) {
      return { fixtureId, ok: false, reason: "did not run (no record)" };
    }
    const expected = getFixture(fixtureId).expectedOutcome;
    if (record.outcome !== expected) {
      return {
        fixtureId,
        ok: false,
        reason: `outcome \`${record.outcome}\` did not match expected \`${expected}\``,
      };
    }
    return { fixtureId, ok: true, reason: "" };
  });
}

function firstCommittedArgsText(record: FixtureRunRecord | undefined): string {
  const firstCall = record?.childOutput?.apiLog.calls[0] as
    | { readonly args?: unknown }
    | undefined;
  const committed = firstCall?.args;
  return committed && typeof committed === "object"
    ? `\`${JSON.stringify(committed)}\``
    : "no call committed";
}

export function buildProxyFixNarrative(
  records: readonly FixtureRunRecord[],
): string {
  const find = (id: string) =>
    records.find((r) => r.fixtureId === id && r.runtime === "quickjs");
  const proxyRecord = find("malformed-proxy-args");
  const nestedRecord = find("malformed-nested-getter-parity");
  const getterRecord = find("malformed-getter-side-effect");
  const overwriteRecord = find("malformed-overwrite-descriptor-fn");
  const descriptorTrapRecord = find("malformed-proxy-descriptor-trap");

  const integrityChecks = checkIntegrityFixtures(records);
  const failedIntegrityChecks = integrityChecks.filter((c) => !c.ok);
  const isClosed = failedIntegrityChecks.length === 0;
  const getterInvoked = (getterRecord?.childOutput?.returnValue ?? "").includes(
    "getterInvoked=true",
  );
  const nestedReadsMatch = (nestedRecord?.childOutput?.returnValue ?? "").match(
    /innerReads=(\d+)/,
  );
  const nestedReads = nestedReadsMatch ? nestedReadsMatch[1] : "?";

  const round1 =
    "**Round 1 (escape found)**: a `Proxy` `get` trap that alternates its " +
    "answer by call-count parity got `{x: 999999, y: 1}` committed as " +
    "`move()`'s target, because the host read each field via " +
    "`context.dump()`'s ordinary `[[Get]]`-based traversal. A naive fix " +
    "(dump the same handle twice, reject on disagreement) was tried and " +
    "**measured to not work**: with exactly two fields and one `get` call " +
    "per field per dump, every dump starts on the same parity phase as the " +
    "last, so two independent dumps always agree with each other while " +
    "both are equally wrong — verified directly against the fixture before " +
    "being discarded.";
  const round2 =
    "**Round 2 (descriptor fix, still bypassed)**: reading fields via " +
    "`Object.getOwnPropertyDescriptor` (`[[GetOwnProperty]]`) instead of " +
    "`[[Get]]` closed the parity-flip Proxy, but a code review " +
    "(Fro Bot) reproduced a stronger bypass: the descriptor-reading helper " +
    "was a small function evaluated *inside the guest context*, and its " +
    "body still referenced the identifier `Object.getOwnPropertyDescriptor` " +
    " — a dynamic lookup resolved at CALL time, not at the time the helper " +
    "was defined. `malformed-overwrite-descriptor-fn` reassigns that global " +
    "to a function returning a fabricated `{value: 999999, ...}` descriptor " +
    "before ever calling `api.move()`, and the helper faithfully read the " +
    "fabricated value back — reproduced directly before this fix.";
  const round3 =
    "**Round 3 (this fix)**: the *function value* of " +
    "`Object.getOwnPropertyDescriptor` is captured as a `QuickJSHandle` " +
    "immediately after `newContext()`, before a single byte of guest " +
    "source has evaluated. Every later field read calls that captured " +
    "handle directly via `context.callFunction` — never by looking up an " +
    "identifier again — so there is no global binding left for a guest to " +
    "poison. Any descriptor carrying a `get`/`set` function, or that isn't " +
    "writable/enumerable/configurable, is rejected outright, which is why " +
    "`malformed-getter-side-effect` and `malformed-nested-getter-parity` " +
    "(plain getters, no Proxy) are rejected before their getters ever run " +
    `(measured: getterInvoked=${String(getterInvoked)}, innerReads=${nestedReads}).`;
  const residual =
    "**Residual, accepted limitation**: capturing the function only stops " +
    "a *global reassignment* attack. A Proxy that defines its OWN " +
    "`getOwnPropertyDescriptor` trap (not just `get`) is still legitimately " +
    "invoked by the real, captured function — that trap IS the object's " +
    "`[[GetOwnProperty]]`, and refusing to call it isn't possible without " +
    "refusing to read the object at all. `malformed-proxy-descriptor-trap` " +
    "measures exactly this: the trap fabricates x's value, and the " +
    `committed value (${firstCommittedArgsText(descriptorTrapRecord)}) equals ` +
    "exactly what the trap presented — predictable and bounded to a " +
    "schema-valid number, never a host escape, never a corrupted or " +
    "unrelated field, and still subject to ordinary value validation " +
    "afterward. This is accepted as-is, not closed by this unit.";
  const status =
    "**Current measured status**: `malformed-proxy-args` → `" +
    `${proxyRecord?.outcome ?? "not run"}\`, committed ${firstCommittedArgsText(proxyRecord)}; \`malformed-overwrite-descriptor-fn\` → \`${overwriteRecord?.outcome ?? "not run"}\`, committed ${firstCommittedArgsText(overwriteRecord)} — ` +
    (isClosed
      ? "both are the *true* target values, the guest's tampering had zero effect, and every integrity fixture (proxy-args, getter-side-effect, nested-getter-parity, overwrite-descriptor-fn, proxy-descriptor-trap) ran and matched its expected outcome: the escape is closed."
      : `**inconclusive** — this fix cannot be confirmed from this run: ${failedIntegrityChecks.map((c) => `\`${c.fixtureId}\` ${c.reason}`).join("; ")}. This is either a live regression (outcome disagrees with expectation) or the fixture simply did not run — either way, treat it as unverified, never report it as closed.`);

  return [round1, round2, round3, residual, status].join(" ");
}
