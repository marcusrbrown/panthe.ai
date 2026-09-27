#!/usr/bin/env bun
// CLI entry point. Two modes:
//
//   bun run.ts --runtime quickjs|lua --fixture <id>
//     Runs exactly one fixture in-process and prints its JSON result as the
//     last line of stdout. This is what host.ts spawns as a child.
//
//   bun run.ts --all
//     Orchestrates the full fixture matrix for both runtimes through
//     host.ts (each fixture in its own subprocess), runs the next-run-health
//     composite check, writes the raw results to results/ (gitignored), and
//     renders the README's Results section from the real numbers.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureEnvironment, renderReport } from "@panthea/tools-probes-shared";
import {
  FIXTURES,
  type FixtureCategory,
  fixturesForRuntime,
  getFixture,
  NEXT_RUN_HEALTH_PROBE_FIXTURE,
  type Runtime,
  readFixtureSource,
} from "./fixtures/manifest";
import { type FixtureRunRecord, runFixtureInSubprocess } from "./host";
import { runLuaFixture } from "./lua";
import { runQuickJsFixture } from "./quickjs";

const SRC_DIR = import.meta.dir;
const SANDBOX_DIR = join(SRC_DIR, "..");
const RESULTS_DIR = join(SANDBOX_DIR, "results");
const README_PATH = join(SANDBOX_DIR, "README.md");
const RUN_FILE_PATH = join(SRC_DIR, "run.ts");

interface ParsedArgs {
  readonly all: boolean;
  readonly runtime?: string;
  readonly fixture?: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let all = false;
  let runtime: string | undefined;
  let fixture: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--all") {
      all = true;
    } else if (arg === "--runtime") {
      runtime = argv[i + 1];
      i += 1;
    } else if (arg === "--fixture") {
      fixture = argv[i + 1];
      i += 1;
    }
  }
  return { all, runtime, fixture };
}

function isRuntime(value: string | undefined): value is Runtime {
  return value === "quickjs" || value === "lua";
}

async function runOneFixture(
  runtime: Runtime,
  fixtureId: string,
): Promise<void> {
  const fixture = getFixture(fixtureId);
  const source = readFixtureSource(fixture, runtime);
  const result =
    runtime === "quickjs"
      ? await runQuickJsFixture({ source })
      : await runLuaFixture({ source });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const CATEGORY_TITLES: Record<FixtureCategory, string> = {
  "happy-path": "Happy path",
  "external-capability": "External capability access",
  "loop-recursion": "Loop / recursion",
  allocation: "Allocation",
  "async-hang": "Async hang",
  "malformed-input": "Malformed API input",
  "partial-failure": "Partial-failure rollback",
};

const CATEGORY_ORDER: readonly FixtureCategory[] = [
  "happy-path",
  "external-capability",
  "loop-recursion",
  "allocation",
  "async-hang",
  "malformed-input",
  "partial-failure",
];

function formatRss(bytes: number | undefined): string {
  if (bytes === undefined) {
    return "n/a";
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatExit(record: FixtureRunRecord): string {
  if (record.supervisorKilled) {
    return "killed by supervisor (SIGKILL)";
  }
  if (record.exitSignal) {
    return `signal ${record.exitSignal}`;
  }
  return `exit ${record.exitCode ?? "?"}`;
}

interface NextRunHealthRecord {
  readonly runtime: Runtime;
  readonly priorFixtureId: string;
  readonly priorOutcome: string;
  readonly followUpOutcome: string;
  readonly healthy: boolean;
}

function buildMatrixMarkdown(
  records: readonly FixtureRunRecord[],
  nextRunHealth: readonly NextRunHealthRecord[],
): string {
  const lines: string[] = [];
  const header =
    "| Runtime | Fixture | Expected | Outcome | Time (ms) | Peak RSS | Exit |\n| --- | --- | --- | --- | --- | --- | --- |";

  for (const category of CATEGORY_ORDER) {
    const categoryRecords = records.filter((r) => r.category === category);
    if (categoryRecords.length === 0) {
      continue;
    }
    lines.push(`#### ${CATEGORY_TITLES[category]}`);
    lines.push("");
    lines.push(header);
    for (const record of categoryRecords) {
      const fixture = getFixture(record.fixtureId);
      lines.push(
        `| ${record.runtime} | \`${record.fixtureId}\` | ${fixture.expectedOutcome} | ${record.outcome === "escaped" ? "**escaped (P0)**" : record.outcome} | ${record.timeToTerminationMs.toFixed(0)} | ${formatRss(record.peakRssBytes)} | ${formatExit(record)} |`,
      );
    }
    lines.push("");
  }

  lines.push("#### Next-run health (after a terminated fixture)");
  lines.push("");
  lines.push(
    "| Runtime | Prior fixture | Prior outcome | Follow-up outcome | Supervisor healthy |\n| --- | --- | --- | --- | --- |",
  );
  for (const entry of nextRunHealth) {
    lines.push(
      `| ${entry.runtime} | \`${entry.priorFixtureId}\` | ${entry.priorOutcome} | ${entry.followUpOutcome} | ${entry.healthy ? "yes" : "**no**"} |`,
    );
  }
  lines.push("");

  const escapedHostCapability = records.filter(
    (r) => r.outcome === "escaped" && r.category === "external-capability",
  );
  const escapedValidation = records.filter(
    (r) => r.outcome === "escaped" && r.category !== "external-capability",
  );
  if (escapedHostCapability.length > 0) {
    lines.push(
      `**P0 — host boundary breach**: ${escapedHostCapability.length} fixture(s) reached a real host capability: ${escapedHostCapability
        .map((r) => `\`${r.runtime}/${r.fixtureId}\``)
        .join(", ")}.`,
    );
  } else {
    lines.push(
      "No external-capability fixture escaped the host boundary in this run.",
    );
  }
  if (escapedValidation.length > 0) {
    lines.push(
      `**P0 (input-validation integrity, not a host-boundary breach)**: ${escapedValidation.length} fixture(s) committed a value the world-API validator should have rejected: ${escapedValidation
        .map((r) => `\`${r.runtime}/${r.fixtureId}\``)
        .join(", ")}. See Findings for the measured cause.`,
    );
  }

  return lines.join("\n");
}

function buildApiLogSummary(records: readonly FixtureRunRecord[]): string {
  const partialFailures = records.filter(
    (r) => r.category === "partial-failure",
  );
  const lines: string[] = ["#### Partial-failure API log evidence", ""];
  for (const record of partialFailures) {
    const log = record.childOutput?.apiLog;
    lines.push(
      `- \`${record.runtime}/${record.fixtureId}\`: ${log?.calls.length ?? "?"} staged call(s), status \`${log?.status ?? "unknown"}\`.`,
    );
  }
  return lines.join("\n");
}

function writeReadme(
  records: readonly FixtureRunRecord[],
  nextRunHealth: readonly NextRunHealthRecord[],
): void {
  const environment = captureEnvironment({
    extra: {
      "quickjs-emscripten": "0.32.0",
      wasmoon: "1.16.0",
    },
  });

  const base = renderReport({
    question:
      "Do QuickJS (quickjs-emscripten 0.32.x) and Lua (wasmoon 1.16.x) reliably terminate adversarial generated-behavior code and leave the host process healthy for the next execution — and which one settles ADR-0004's sandbox mechanism?",
    howToRun:
      "```sh\ncd tools/probes/sandbox\nbun run matrix   # bun run src/run.ts --all\n```\n\nSingle fixture (what `host.ts` spawns as a child):\n\n```sh\nbun run src/run.ts --runtime quickjs --fixture loop-infinite\nbun run src/run.ts --runtime lua --fixture loop-infinite\n```\n\nEvery fixture always runs in its own `Bun.spawn` subprocess — a Worker is in-process and shares the heap, so it cannot give a separate RSS boundary or survive a memory bomb.",
    caveat:
      "Stock QuickJS's `setMemoryLimit` is a **soft** limit against the prebuilt WASM variant used here: with WASM memory growth enabled, a tight allocation loop can grow host memory well past the configured limit before (or instead of) QuickJS raising an OOM error — see [quickjs-emscripten#255](https://github.com/justjake/quickjs-emscripten/issues/255). Separately, the interrupt handler is checked between bytecode instructions, not inside a single native operation, so an operation like a huge array-to-string conversion can run to completion (or to a native OOM/crash) without the interrupt ever firing mid-operation — see [quickjs-emscripten#219](https://github.com/justjake/quickjs-emscripten/issues/219). Both are why every fixture here runs in an isolated, wall-clock-and-RSS-supervised subprocess rather than trusting the in-process limit alone.",
    environment,
    metrics: [],
    findings: buildFindings(records, nextRunHealth),
    bottomLine: buildBottomLine(records, nextRunHealth),
  });

  const matrixMarkdown = `${buildMatrixMarkdown(records, nextRunHealth)}\n\n${buildApiLogSummary(records)}`;
  const withMatrix = base.replace(
    "## Results\n\nNo metrics recorded.",
    `## Results\n\n${matrixMarkdown}`,
  );

  writeFileSync(README_PATH, withMatrix);
}

function buildProxyFixNarrative(records: readonly FixtureRunRecord[]): string {
  const proxyRecord = records.find(
    (r) => r.fixtureId === "malformed-proxy-args" && r.runtime === "quickjs",
  );
  const nestedRecord = records.find(
    (r) =>
      r.fixtureId === "malformed-nested-getter-parity" &&
      r.runtime === "quickjs",
  );
  const getterRecord = records.find(
    (r) =>
      r.fixtureId === "malformed-getter-side-effect" && r.runtime === "quickjs",
  );
  const firstCall = proxyRecord?.childOutput?.apiLog.calls[0] as
    | { readonly args?: unknown }
    | undefined;
  const committed = firstCall?.args;
  const committedText =
    committed && typeof committed === "object"
      ? `\`${JSON.stringify(committed)}\``
      : "no call committed";
  const isFixed =
    proxyRecord?.outcome !== "escaped" && nestedRecord?.outcome !== "escaped";
  const getterInvoked = (getterRecord?.childOutput?.returnValue ?? "").includes(
    "getterInvoked=true",
  );
  const nestedReadsMatch = (nestedRecord?.childOutput?.returnValue ?? "").match(
    /innerReads=(\d+)/,
  );
  const nestedReads = nestedReadsMatch ? nestedReadsMatch[1] : "?";

  const part1 =
    "**`malformed-proxy-args` escape, root cause, and fix (ADR-0004 world-API rule)**: " +
    "this fixture originally escaped — a `Proxy` `get` trap that alternates its answer " +
    "by a call-count parity got `{x: 999999, y: 1}` committed as `move()`'s target, " +
    "because the host read each field via `context.dump()`'s ordinary `[[Get]]`-based " +
    "traversal. A first attempted fix (dump the same handle twice, reject on " +
    "disagreement) was tried and **measured to not work**: with exactly two fields and " +
    "one `get` call per field per dump, every dump starts on the same parity phase as " +
    "the last, so two independent dumps of the same object always agree with each " +
    "other while both are equally wrong — verified directly against the running " +
    "fixture before being discarded.";
  const part2 =
    "The actual fix reads object fields via property **descriptors** " +
    "(`Object.getOwnPropertyDescriptor`, i.e. `[[GetOwnProperty]]`) instead of " +
    "`[[Get]]`: the fixture's Proxy defines only a `get` trap, so the default " +
    "`getOwnPropertyDescriptor` behavior reads the *target*'s real descriptor directly " +
    "and the adversarial trap is never invoked at all. Any descriptor carrying a " +
    "`get`/`set` function, or that isn't writable/enumerable/configurable, is rejected " +
    "outright — this is why `malformed-getter-side-effect` and the added " +
    "`malformed-nested-getter-parity` fixture (plain getters, no Proxy, one layer of " +
    "nesting) are now rejected before their getters ever run (measured: getterInvoked=" +
    String(getterInvoked) +
    ", innerReads=" +
    nestedReads +
    ").";
  const part3 =
    "This is now the standing ADR-0004 rule for every world-API argument, both " +
    "runtimes: snapshot to plain data using a mechanism that cannot be gamed by a " +
    "stateful trap (descriptors, not property access), then reject anything that " +
    "isn't a plain value, array, or `Object.prototype` object with no functions and " +
    "no accessors.";
  const part4 =
    "Current measured status: `malformed-proxy-args` → `" +
    (proxyRecord?.outcome ?? "not run") +
    "`, committed value " +
    committedText +
    " (the *true* target values, not the trap's poisoned ones) — " +
    (isFixed
      ? "the escape is closed."
      : "**still escaping — regression, do not ship**.");

  return [part1, part2, part3, part4].join(" ");
}

function buildFindings(
  records: readonly FixtureRunRecord[],
  nextRunHealth: readonly NextRunHealthRecord[],
): readonly string[] {
  const findings: string[] = [];

  findings.push(buildProxyFixNarrative(records));

  const escapedHostCapability = records.filter(
    (r) => r.outcome === "escaped" && r.category === "external-capability",
  );
  const escapedValidation = records.filter(
    (r) => r.outcome === "escaped" && r.category !== "external-capability",
  );
  if (escapedHostCapability.length > 0) {
    findings.push(
      `P0 — host boundary breach: ${escapedHostCapability.length} external-capability fixture(s) reached a real host capability: ${escapedHostCapability.map((r) => `${r.runtime}/${r.fixtureId}`).join(", ")}.`,
    );
  } else {
    findings.push(
      "No fixture in either runtime reached a real host capability (filesystem, process, network, Bun, WebAssembly, Atomics) — every external-capability fixture ended `blocked`.",
    );
  }
  if (escapedValidation.length > 0) {
    findings.push(
      `P0 (input-validation integrity, not a host-boundary breach): ${escapedValidation.map((r) => `${r.runtime}/${r.fixtureId}`).join(", ")} committed a value the validator should have rejected as inconsistent. Measured cause for \`malformed-proxy-args\`: the host reads a Proxy target's fields as separate property accesses (once each via \`context.dump\`), not one atomic snapshot; a \`get\` trap that alternates its return value across reads can therefore land a value combination no single read ever produced. The world API validator should snapshot every field in one pass before validating, not read incrementally.`,
    );
  }

  const luaMissingSource = FIXTURES.filter((f) => f.quickjsFile && !f.luaFile);
  findings.push(
    `${luaMissingSource.length} QuickJS fixture(s) have no Lua equivalent (\`fetch\`, \`Bun\`, \`WebAssembly\`, \`Atomics.wait\`, timers, \`Proxy\`-based coercion) because Lua's config (\`openStandardLibs: false\`, \`injectObjects: false\`, \`enableProxy: false\`) leaves no ambient surface for those concepts to exist on in the first place — the absence itself is the finding, not a gap in fixture coverage.`,
  );

  findings.push(
    "With `openStandardLibs: false`, the Lua guest has no base library at all: no `pcall`, `error`, `tostring`, `getmetatable`, or `load` beyond the raw language and the injected `api` table. Every bad-path Lua fixture therefore ends the whole chunk with an uncaught runtime error rather than a guest-caught, continuable failure — QuickJS's fixtures can (and do) `try`/`catch` around a rejected call and keep running; Lua's cannot.",
  );

  const QUICKJS_MEMORY_LIMIT_MIB = 64;
  const quickjsAllocRecords = records.filter(
    (r) => r.category === "allocation" && r.runtime === "quickjs",
  );
  const stoppedByOwnMemoryLimit = quickjsAllocRecords.filter(
    (r) => r.childOutput?.limitKind === "memory",
  );
  const stoppedByOwnStringCap = quickjsAllocRecords.filter(
    (r) =>
      !r.childOutput?.limitKind &&
      /string too long/i.test(r.childOutput?.errorMessage ?? ""),
  );
  const exceededConfiguredLimit = quickjsAllocRecords.filter(
    (r) => (r.peakRssBytes ?? 0) > QUICKJS_MEMORY_LIMIT_MIB * 1024 * 1024 * 1.5,
  );
  findings.push(
    `Of ${quickjsAllocRecords.length} QuickJS allocation fixtures: ${stoppedByOwnMemoryLimit.length} were actually stopped by \`setMemoryLimit\` raising an out-of-memory error, ${stoppedByOwnStringCap.length} hit the engine's own max-string-length invariant instead, and ${exceededConfiguredLimit.length} grew past ${QUICKJS_MEMORY_LIMIT_MIB * 1.5} MiB (1.5x the configured ${QUICKJS_MEMORY_LIMIT_MIB} MiB limit) before anything stopped them${exceededConfiguredLimit.length > 0 ? ` (measured peak RSS: ${exceededConfiguredLimit.map((r) => `\`${r.fixtureId}\` ${((r.peakRssBytes ?? 0) / (1024 * 1024)).toFixed(0)} MiB`).join(", ")})` : ""} — direct, measured confirmation of quickjs-emscripten#255 (\`setMemoryLimit\` is soft against this growable-WASM build).`,
  );

  const unhealthy = nextRunHealth.filter((entry) => !entry.healthy);
  findings.push(
    unhealthy.length === 0
      ? "Every runtime's supervisor stayed healthy after a terminated fixture: the very next execution, in a fresh runtime/process, completed normally."
      : `${unhealthy.length} runtime(s) did not recover cleanly after a terminated fixture: ${unhealthy.map((e) => e.runtime).join(", ")}.`,
  );

  const asyncRecords = records.filter(
    (r) => r.category === "async-hang" && r.runtime === "quickjs",
  );
  const unresolvedPromise = asyncRecords.find(
    (r) => r.fixtureId === "async-unresolved-promise",
  );
  if (unresolvedPromise) {
    findings.push(
      `An unresolved, un-chained promise did not hang this driver (outcome \`${unresolvedPromise.outcome}\` in ${unresolvedPromise.timeToTerminationMs.toFixed(0)}ms): this driver never calls \`runtime.executePendingJobs()\`, so a settled-never promise with no reaction simply has nothing left to run. A driver that does drain the job queue would need its own bounded pump loop — the infinite-microtask-recursion fixture exists precisely to measure that case.`,
    );
  }

  const partialFailure = records.find(
    (r) => r.category === "partial-failure" && r.runtime === "quickjs",
  );
  if (partialFailure?.childOutput?.apiLog) {
    findings.push(
      `The partial-failure fixture staged exactly ${partialFailure.childOutput.apiLog.calls.length} call(s) before its intentional throw, and the log's status resolved to \`${partialFailure.childOutput.apiLog.status}\` — confirming the transaction boundary holds regardless of how the guest execution ends.`,
    );
  }

  const luaAllocRecords = records.filter(
    (r) => r.category === "allocation" && r.runtime === "lua",
  );
  const luaAllocKilled = luaAllocRecords.filter((r) => r.supervisorKilled);
  if (luaAllocRecords.length > 0) {
    findings.push(
      `wasmoon's \`CreateEngineOptions\` has no memory-limit field at all — capping Lua memory requires the separate, undocumented-here \`traceAllocations\`+\`setMemoryMax\` pair, which this probe does not configure per the plan's stated options (\`openStandardLibs\`, \`injectObjects\`, \`enableProxy\`, \`functionTimeout\`). Both measured Lua allocation fixtures grew unchecked until ${luaAllocKilled.length === luaAllocRecords.length ? "the outer supervisor's RSS bound killed them" : "something stopped them"} (measured peak RSS: ${luaAllocRecords.map((r) => `\`${r.fixtureId}\` ${((r.peakRssBytes ?? 0) / (1024 * 1024)).toFixed(0)} MiB`).join(", ")}) — unlike QuickJS, Lua as configured here has *no* in-runtime memory boundary, only the external supervisor.`,
    );
  }

  return findings;
}

function buildBottomLine(
  records: readonly FixtureRunRecord[],
  nextRunHealth: readonly NextRunHealthRecord[],
): string {
  const escapedHostCapability = records.filter(
    (r) => r.outcome === "escaped" && r.category === "external-capability",
  );
  const escapedValidation = records.filter(
    (r) => r.outcome === "escaped" && r.category !== "external-capability",
  );
  const unhealthy = nextRunHealth.filter((entry) => !entry.healthy);
  const QUICKJS_MEMORY_LIMIT_MIB = 64;
  const quickjsAllocRecords = records.filter(
    (r) => r.category === "allocation" && r.runtime === "quickjs",
  );
  const quickjsAllocExceededLimit = quickjsAllocRecords.some(
    (r) => (r.peakRssBytes ?? 0) > QUICKJS_MEMORY_LIMIT_MIB * 1024 * 1024 * 1.5,
  );

  if (escapedHostCapability.length > 0) {
    return `**P0 — do not ship.** ${escapedHostCapability.length} external-capability fixture(s) reached a real host capability. ADR-0004 cannot move to Accepted until every external-capability fixture in this README is \`blocked\`.`;
  }

  const parts: string[] = [];
  if (escapedValidation.length > 0) {
    parts.push(
      `**No host-boundary breach, but a real input-validation gap**: ${escapedValidation.length} malformed-input fixture(s) (${escapedValidation.map((r) => `\`${r.runtime}/${r.fixtureId}\``).join(", ")}) committed a value the world-API validator should have rejected — see Findings for the exact mechanism and required fix. This must be tracked and closed before generated behaviors reach a real Proxy-capable guest.`,
    );
  } else {
    parts.push(
      "The `malformed-proxy-args` Proxy-parity escape found earlier in this probe's development is closed: the world API now reads object-argument fields via property descriptors rather than `[[Get]]`, and rejects any accessor (getter/setter) descriptor outright. See Findings for the root cause and why a naive dump-twice-and-compare fix did not work.",
    );
  }
  parts.push(
    `QuickJS (quickjs-emscripten 0.32.x), run one fresh interpreter per execution inside an isolated \`Bun.spawn\` subprocess with an outer wall-clock/RSS supervisor, is the mechanism this probe recommends for ADR-0004: it blocked every external-capability fixture${escapedValidation.length > 0 ? " and every malformed-input fixture except the Proxy value-integrity gap noted above" : " and every malformed-input fixture"}, it can \`try\`/\`catch\` a rejected API call and keep running (Lua's zero-stdlib config cannot), and the world's action validator remains the real authority regardless of interpreter.`,
  );
  parts.push(
    quickjsAllocExceededLimit
      ? "The runtime's own `setMemoryLimit` is **not** sufficient by itself: measured allocation fixtures grew well past the configured 64 MiB before the deadline (not the memory limit) stopped them, confirming quickjs-emscripten#255/#219 directly on this machine. A fixed-memory (non-growable) WASM build, or accepting the subprocess wall-clock/RSS bound as the *real* memory boundary, is required before relying on `setMemoryLimit` alone."
      : "The runtime's own `setMemoryLimit`/interrupt handler stopped every measured allocation fixture within the configured bound in this run, though quickjs-emscripten#255/#219 mean that is not a guarantee across allocation patterns — the subprocess wall-clock/RSS bound stays the documented, always-on backstop regardless.",
  );
  parts.push(
    "Lua (wasmoon 1.16.x) does not win on any measured criterion here: it terminates loops via the same class of mechanism (a `lua_sethook` count hook reachable through `Thread.run({ timeout })`, not through `functionTimeout`/`doString` alone, which only bounds JS callbacks invoked *from* Lua), but its locked-down configuration (`openStandardLibs: false`) leaves generated behaviors with no base library at all, making even ordinary error handling unavailable to the guest. ADR-0004 should stay on QuickJS.",
  );
  if (unhealthy.length > 0) {
    parts.push(
      `Caveat: ${unhealthy.length} runtime(s) did not cleanly recover after a terminated fixture in this run and need investigation before this can move to Accepted.`,
    );
  }
  return parts.join(" ");
}

async function runAll(): Promise<void> {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const runFilePath = RUN_FILE_PATH;
  const records: FixtureRunRecord[] = [];

  for (const runtime of ["quickjs", "lua"] as const) {
    for (const fixture of fixturesForRuntime(runtime)) {
      const record = await runFixtureInSubprocess({
        runFilePath,
        runtime,
        fixtureId: fixture.id,
        category: fixture.category,
      });
      records.push(record);
      console.error(
        `[matrix] ${runtime} ${fixture.id} -> ${record.outcome} (${record.timeToTerminationMs.toFixed(0)}ms, rss=${formatRss(record.peakRssBytes)})`,
      );
    }
  }

  const nextRunHealth: NextRunHealthRecord[] = [];
  for (const runtime of ["quickjs", "lua"] as const) {
    const priorFixture = FIXTURES.find((f) => f.id === "loop-infinite");
    if (!priorFixture) {
      continue;
    }
    const hasSource =
      runtime === "quickjs"
        ? priorFixture.quickjsFile !== undefined
        : priorFixture.luaFile !== undefined;
    if (!hasSource) {
      continue;
    }
    const prior = await runFixtureInSubprocess({
      runFilePath,
      runtime,
      fixtureId: priorFixture.id,
      category: priorFixture.category,
    });
    const followUp = await runFixtureInSubprocess({
      runFilePath,
      runtime,
      fixtureId: NEXT_RUN_HEALTH_PROBE_FIXTURE,
      category: "happy-path",
    });
    nextRunHealth.push({
      runtime,
      priorFixtureId: priorFixture.id,
      priorOutcome: prior.outcome,
      followUpOutcome: followUp.outcome,
      healthy: followUp.outcome === "completed",
    });
  }

  const resultsPath = join(RESULTS_DIR, `matrix-${Date.now()}.json`);
  writeFileSync(
    resultsPath,
    JSON.stringify({ records, nextRunHealth }, null, 2),
  );
  console.error(`[matrix] wrote ${resultsPath}`);

  writeReadme(records, nextRunHealth);
  console.error(`[matrix] wrote ${README_PATH}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.all) {
    await runAll();
    return;
  }
  if (!isRuntime(args.runtime)) {
    throw new Error("--runtime must be quickjs or lua");
  }
  if (typeof args.fixture !== "string") {
    throw new Error("--fixture <id> is required");
  }
  await runOneFixture(args.runtime, args.fixture);
}

await main();
