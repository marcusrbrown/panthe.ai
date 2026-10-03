// A bag of named wall-clock accumulators: how long a benchmark run spent in
// each phase, and how many times it entered it. Plain data, no globals, so a
// run that is not measuring simply never creates one.

export interface Phase {
  ms: number;
  n: number;
}

export class Phases {
  readonly byName = new Map<string, Phase>();

  add(name: string, ms: number, n = 1): void {
    const held = this.byName.get(name);
    if (held) {
      held.ms += ms;
      held.n += n;
    } else {
      this.byName.set(name, { ms, n });
    }
  }

  /** Runs `fn`, adding its wall time to `name`. */
  time<T>(name: string, fn: () => T): T {
    const start = performance.now();
    try {
      return fn();
    } finally {
      this.add(name, performance.now() - start);
    }
  }

  ms(name: string): number {
    return this.byName.get(name)?.ms ?? 0;
  }

  count(name: string): number {
    return this.byName.get(name)?.n ?? 0;
  }

  toJSON(): Record<string, Phase> {
    return Object.fromEntries(
      [...this.byName.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  }
}
