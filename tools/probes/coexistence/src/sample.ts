// Memory-pressure sampling for the coexistence probe (Unit 8): parses
// `vm_stat`/`sysctl vm.swapusage` text into typed snapshots, reads
// per-process RSS via `ps`, and drives a periodic sampler that combines
// both with named process targets (the ollama runner, sd-server, the
// renderer app) into one time series per scenario.
//
// Never throws: every parse degrades to `undefined` on malformed or
// partial input rather than crashing a long-running scenario run.

export interface VmStatSnapshot {
  readonly pageSizeBytes: number;
  readonly freePages: number;
  readonly activePages: number;
  readonly inactivePages: number;
  readonly speculativePages: number;
  readonly wiredPages: number;
  readonly compressorPages: number;
  readonly swapinsTotal: number;
  readonly swapoutsTotal: number;
}

const VM_STAT_HEADER = /page size of (\d+) bytes/;
// `vm_stat` lines look like `Pages free:                  3754.` — label,
// colon, whitespace, digits, trailing period. Some labels are quoted
// (`"Translation faults":`); the label itself is not used for parsing past
// the fixed field list below, only its position in the fixed line set.
const VM_STAT_LINE = /^"?([A-Za-z][A-Za-z "]*?)"?:\s+(\d+)\.?\s*$/;

function extractVmStatFields(text: string): Map<string, number> | undefined {
  const fields = new Map<string, number>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const match = VM_STAT_LINE.exec(line);
    if (match) {
      const label = match[1];
      const value = match[2];
      if (label !== undefined && value !== undefined) {
        fields.set(label, Number(value));
      }
    }
  }
  return fields.size > 0 ? fields : undefined;
}

/** Parses `vm_stat` output into a typed snapshot. Returns `undefined` on malformed/empty input. */
export function parseVmStat(text: string): VmStatSnapshot | undefined {
  const headerMatch = VM_STAT_HEADER.exec(text);
  const fields = extractVmStatFields(text);
  if (!headerMatch || !fields) {
    return undefined;
  }
  const pageSizeStr = headerMatch[1];
  if (pageSizeStr === undefined) {
    return undefined;
  }
  const pageSizeBytes = Number(pageSizeStr);
  const free = fields.get("Pages free");
  const active = fields.get("Pages active");
  const inactive = fields.get("Pages inactive");
  if (free === undefined || active === undefined || inactive === undefined) {
    return undefined;
  }
  return {
    pageSizeBytes,
    freePages: free,
    activePages: active,
    inactivePages: inactive,
    speculativePages: fields.get("Pages speculative") ?? 0,
    wiredPages: fields.get("Pages wired down") ?? 0,
    compressorPages: fields.get("Pages occupied by compressor") ?? 0,
    swapinsTotal: fields.get("Swapins") ?? 0,
    swapoutsTotal: fields.get("Swapouts") ?? 0,
  };
}

export interface SwapUsage {
  readonly totalMiB: number;
  readonly usedMiB: number;
  readonly freeMiB: number;
}

const SWAPUSAGE_LINE =
  /total\s*=\s*([\d.]+)M\s+used\s*=\s*([\d.]+)M\s+free\s*=\s*([\d.]+)M/;

/** Parses `sysctl vm.swapusage` output (e.g. `vm.swapusage: total = 8192.00M  used = 7070.50M  free = 1121.50M`). */
export function parseSwapUsage(text: string): SwapUsage | undefined {
  const match = SWAPUSAGE_LINE.exec(text);
  if (!match) {
    return undefined;
  }
  const total = match[1];
  const used = match[2];
  const free = match[3];
  if (total === undefined || used === undefined || free === undefined) {
    return undefined;
  }
  return {
    totalMiB: Number(total),
    usedMiB: Number(used),
    freeMiB: Number(free),
  };
}

const BYTES_PER_MIB = 1024 * 1024;

/** Converts a page count at `pageSizeBytes` to MiB. */
export function pagesToMiB(pages: number, pageSizeBytes: number): number {
  return (pages * pageSizeBytes) / BYTES_PER_MIB;
}

export type RunCommand = (command: readonly string[]) => string | undefined;

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
    const output = result.stdout.toString();
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}

/** Reads one process's RSS in KiB via `ps -o rss= -p <pid>`. Returns `undefined` if the pid is gone. */
export function readRssKb(
  pid: number,
  runCommand: RunCommand = defaultRunCommand,
): number | undefined {
  const output = runCommand(["ps", "-o", "rss=", "-p", String(pid)]);
  if (output === undefined) {
    return undefined;
  }
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Resolves the ollama runner child pid(s) of the `ollama serve` supervisor
 * pid — ollama's own process never holds model weights in its own RSS, it
 * spawns a separate `llama-server` runner child per loaded model (a new pid
 * each time a model (re)loads). Falls back to every direct child pid if none
 * is named like a runner (e.g. before the first request loads a model).
 */
export function findOllamaRunnerPids(
  supervisorPid: number,
  runCommand: RunCommand = defaultRunCommand,
): readonly number[] {
  const pgrepOutput = runCommand(["pgrep", "-P", String(supervisorPid)]);
  if (pgrepOutput === undefined) {
    return [];
  }
  const childPids = pgrepOutput
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map(Number)
    .filter((pid) => Number.isFinite(pid));
  if (childPids.length === 0) {
    return [];
  }
  const namedRunners = childPids.filter((pid) => {
    const command = runCommand(["ps", "-o", "command=", "-p", String(pid)]);
    return (
      command !== undefined &&
      (command.includes("llama-server") || command.includes("runner"))
    );
  });
  return namedRunners.length > 0 ? namedRunners : childPids;
}

export interface ProcessRssTarget {
  readonly name: string;
  /** Re-resolved on every sample tick (an ollama runner pid changes across model loads). */
  readonly resolvePids: () => readonly number[];
}

/** A target whose pid is fixed for the life of the sampler (sd-server, the renderer app). */
export function staticPidTarget(name: string, pid: number): ProcessRssTarget {
  return { name, resolvePids: () => [pid] };
}

/** A target resolved via {@link findOllamaRunnerPids} on every tick, falling back to the supervisor pid itself. */
export function ollamaRunnerTarget(
  supervisorPid: number,
  runCommand: RunCommand = defaultRunCommand,
): ProcessRssTarget {
  return {
    name: "ollama",
    resolvePids: () => {
      const runners = findOllamaRunnerPids(supervisorPid, runCommand);
      return runners.length > 0 ? runners : [supervisorPid];
    },
  };
}

export interface MemorySample {
  readonly atMs: number;
  readonly freeMiB: number;
  readonly inactiveMiB: number;
  /** `free + inactive` — the admission-queue policy's gating signal. */
  readonly admissionMiB: number;
  readonly wiredMiB: number;
  readonly compressedMiB: number;
  readonly swapUsedMiB: number | undefined;
  readonly swapTotalMiB: number | undefined;
  /** Per-target summed RSS in MiB, keyed by {@link ProcessRssTarget.name}. */
  readonly processRssMiB: Readonly<Record<string, number>>;
}

export interface MemorySampler {
  start(): void;
  stop(): readonly MemorySample[];
  /** The most recently recorded sample, without stopping the sampler (a live read for a gate check mid-run). `undefined` before the first tick. */
  peek(): MemorySample | undefined;
}

/** Creates a sampler that polls `vm_stat`, `sysctl vm.swapusage`, and every tracked process target's RSS at `intervalMs`. */
export function createMemorySampler(
  intervalMs: number,
  targets: readonly ProcessRssTarget[],
  runCommand: RunCommand = defaultRunCommand,
): MemorySampler {
  const samples: MemorySample[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let startedAtMs = 0;

  function record(): void {
    const vmStatText = runCommand(["vm_stat"]);
    const swapText = runCommand(["sysctl", "vm.swapusage"]);
    const vmStat = vmStatText ? parseVmStat(vmStatText) : undefined;
    const swap = swapText ? parseSwapUsage(swapText) : undefined;
    if (!vmStat) {
      return;
    }
    const freeMiB = pagesToMiB(vmStat.freePages, vmStat.pageSizeBytes);
    const inactiveMiB = pagesToMiB(vmStat.inactivePages, vmStat.pageSizeBytes);
    const processRssMiB: Record<string, number> = {};
    for (const target of targets) {
      const pids = target.resolvePids();
      let totalKb = 0;
      let anySampled = false;
      for (const pid of pids) {
        const kb = readRssKb(pid, runCommand);
        if (kb !== undefined) {
          totalKb += kb;
          anySampled = true;
        }
      }
      if (anySampled) {
        processRssMiB[target.name] = totalKb / 1024;
      }
    }
    samples.push({
      atMs: performance.now() - startedAtMs,
      freeMiB,
      inactiveMiB,
      admissionMiB: freeMiB + inactiveMiB,
      wiredMiB: pagesToMiB(vmStat.wiredPages, vmStat.pageSizeBytes),
      compressedMiB: pagesToMiB(vmStat.compressorPages, vmStat.pageSizeBytes),
      swapUsedMiB: swap?.usedMiB,
      swapTotalMiB: swap?.totalMiB,
      processRssMiB,
    });
  }

  return {
    start(): void {
      samples.length = 0;
      startedAtMs = performance.now();
      record();
      timer = setInterval(record, intervalMs);
    },
    stop(): readonly MemorySample[] {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      return samples;
    },
    peek(): MemorySample | undefined {
      return samples[samples.length - 1];
    },
  };
}
