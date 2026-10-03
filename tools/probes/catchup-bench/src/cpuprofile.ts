// Reads a V8 `.cpuprofile` (what `bun --cpu-prof` writes) and says where the
// sampled time went: by function (inclusive and self) and by phase, where a
// phase is a named group of functions whose inclusive time is summed once even
// when they call one another.

export interface CallFrame {
  readonly functionName: string;
  readonly url: string;
  readonly lineNumber: number;
}

export interface ProfileNode {
  readonly id: number;
  readonly callFrame: CallFrame;
  readonly children?: readonly number[];
}

export interface CpuProfile {
  readonly nodes: readonly ProfileNode[];
  readonly samples: readonly number[];
  readonly timeDeltas: readonly number[];
}

export interface FunctionTime {
  readonly name: string;
  readonly file: string;
  /** Microseconds in this function and everything it called, counted once per call stack. */
  readonly inclusiveUs: number;
  /** Microseconds in this function's own frames. */
  readonly selfUs: number;
}

const fileOf = (url: string) =>
  url
    .replace(/^file:\/\//, "")
    .split("/")
    .slice(-3)
    .join("/");

/** Microseconds of sampled time attributed to each node (the time a sample was taken in it). */
function selfTimes(profile: CpuProfile): Map<number, number> {
  const self = new Map<number, number>();
  for (let i = 0; i < profile.samples.length; i += 1) {
    const id = profile.samples[i] as number;
    // `timeDeltas[i]` is the time since the previous sample; the sample that ends an interval owns it.
    self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
  }
  return self;
}

/** Every function by inclusive and self time, largest inclusive first. */
export function byFunction(profile: CpuProfile): FunctionTime[] {
  const self = selfTimes(profile);
  const parent = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parent.set(child, node.id);
  }
  const node = new Map(profile.nodes.map((n) => [n.id, n] as const));
  const keyOf = (id: number) => {
    const frame = (node.get(id) as ProfileNode).callFrame;
    return `${frame.functionName}\u0000${frame.url}:${frame.lineNumber}`;
  };

  const inclusive = new Map<string, number>();
  const selfBy = new Map<string, number>();
  const info = new Map<string, { name: string; file: string }>();
  for (const n of profile.nodes) {
    const key = keyOf(n.id);
    info.set(key, {
      name: n.callFrame.functionName || "(anonymous)",
      file: fileOf(n.callFrame.url),
    });
    selfBy.set(key, (selfBy.get(key) ?? 0) + (self.get(n.id) ?? 0));
  }
  // A sample's time counts once toward each distinct function on its stack.
  for (const [id, us] of self) {
    const seen = new Set<string>();
    for (
      let at: number | undefined = id;
      at !== undefined;
      at = parent.get(at)
    ) {
      const key = keyOf(at);
      if (seen.has(key)) continue;
      seen.add(key);
      inclusive.set(key, (inclusive.get(key) ?? 0) + us);
    }
  }
  return [...info.entries()]
    .map(([key, { name, file }]) => ({
      name,
      file,
      inclusiveUs: inclusive.get(key) ?? 0,
      selfUs: selfBy.get(key) ?? 0,
    }))
    .sort((a, b) => b.inclusiveUs - a.inclusiveUs);
}

export interface PhaseRule {
  readonly phase: string;
  /** Matches a function name. A sample counts toward the first rule, in order, with a matching function on its stack. */
  readonly match: RegExp;
}

/**
 * Time per phase: each sample goes to the phase of the first rule (in the
 * order given) that has a matching function anywhere on the sample's stack, so
 * the phases partition the profile and their sum is the sampled total.
 * Samples that no rule claims are reported as `other`.
 */
export function byPhase(
  profile: CpuProfile,
  rules: readonly PhaseRule[],
): Map<string, number> {
  const self = selfTimes(profile);
  const parent = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parent.set(child, node.id);
  }
  const node = new Map(profile.nodes.map((n) => [n.id, n] as const));
  const out = new Map<string, number>();
  for (const [id, us] of self) {
    const names: string[] = [];
    for (
      let at: number | undefined = id;
      at !== undefined;
      at = parent.get(at)
    ) {
      names.push((node.get(at) as ProfileNode).callFrame.functionName);
    }
    const rule = rules.find((r) => names.some((name) => r.match.test(name)));
    const phase = rule?.phase ?? "other";
    out.set(phase, (out.get(phase) ?? 0) + us);
  }
  return out;
}
