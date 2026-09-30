---
title: An accepted memory tunable can make a committed world unreloadable
date: 2026-09-29
category: logic-errors
module: simulation-core
problem_type: logic_error
component: service_object
symptoms:
  - "A content pack with `rules.memoryBalance.capacity: -1` could hang memory eviction once the list was empty"
  - Fractional salience or relationship deltas could commit live but fail later event parsing
  - "`salience_told: 0` committed a report-derived memory with salience 0, then stored-world decode failed"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [memory, tunables, contracts, persistence, salience, reload, w04, o01]
---

# An accepted memory tunable can make a committed world unreloadable

## Problem

`rules.memoryBalance` holds the memory tunables, set by the content pack and stored with the world. PR #58 first parsed it with the generic `parseBalanceRecord`, which accepted any finite number. Some of the values it let through broke the world reducers, the event parser or the projection decoder.

## Symptoms

- **Negative capacity.** With `capacity: -1`, memory eviction looped forever once a list was empty: `0 > -1` stayed true, and `splice(0, 1)` removed nothing.
- **Fractional salience.** A fraction could produce a live `memory-recorded` event, but `parseEvent` requires salience to be a positive integer.
- **Fractional relationship deltas.** These could produce a live `relationship-changed` event, but `parseEvent` requires `affinityDelta` to be an integer and `grudgeDelta` to be a non-negative integer.
- **Zero told salience, after the first fix.**
  - `salience_told: 0` was still accepted.
  - A valid report committed, and `toldMemory` derived a `memory-recorded` event with salience 0.
  - `parseEvent` and the projection decoder both reject salience below 1. So `decode(encode(state))` threw, and the world couldn't be read back.

## What Didn't Work

The first, generic parser was too permissive:

```ts
// packages/contracts/src/content.ts, before the parser fix in PR #58
function parseBalanceRecord(
  value: unknown,
  path: string,
): ParseResult<Readonly<Record<string, number>>> {
  if (!isRecord(value)) return fail(path, "expected a balance object");
  const balance: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    const parsed = parseFiniteNumber(entry, `${path}.${key}`);
    if (!parsed.ok) return parsed;
    balance[key] = parsed.value;
  }
  return ok(balance);
}
```

Commit `adcdf44` replaced it with `parseMemoryBalance`, which runs both at content parse and at stored-world decode. That closed the negative and fractional cases:

```ts
// packages/contracts/src/content.ts
if (MEMORY_COUNT_KEYS.has(key)) {
  parsed = parseNonNegativeInteger(entry, at);
} else if (key === MEMORY_FRACTION_KEY) {
  parsed = parseNonNegativeNumber(entry, at);
} else {
  return fail(at, "not a memory tunable");
}
```

One bad boundary value was still left. `salience_told` is a count, so zero passed as a non-negative integer. Downstream, though, a memory's salience must be at least 1:

```ts
// packages/contracts/src/event.ts
export function parseSalience(value: unknown, path: string): ParseResult<number> {
  const salience = parseNonNegativeInteger(value, path);
  if (!salience.ok) return salience;
  if (salience.value < 1) return fail(path, "expected a positive integer");
  return salience;
}
```

The projection decoder uses the same salience parser for stored memories, so a world that committed live couldn't be reloaded.

## Solution

Commit `b995a2d` changed the producer. A report still records its `report-told` event. When the told salience is below 1, the report derives no memory and no relationship change, which matches what witnessed memory already did:

```ts
// packages/world/src/memory.ts
const salience = balanceOf(after, "salience_told");
if (salience < 1) return undefined;
```

```ts
// packages/world/src/memory.ts, witnessed memories
const salience = balanceOf(before, `salience_${event.kind}`);
if (salience < 1) return [];
```

The regression tests exercise the real boundary:

- **`packages/world/src/memory.test.ts`:** a real report tick with `salience_told: 0` records the report and derives no belief or relationship. Every emitted event parses, and `decode(encode(state))` succeeds. As a positive control, `salience_told: 4` still derives the belief.
- **`apps/simulation/src/world-store.test.ts`:** the same report commits through the real store, survives close and reopen, and survives export and import.

## Why This Works

`parseMemoryBalance` may accept `salience_told: 0`, because zero means "no told belief is formed". The producer must not pass that zero on to `memory-recorded`, whose salience field is stricter: positive integers only.

The general rule covers every tunable. A value the parser accepts must either be valid for every downstream field it feeds, or the producer must skip that field.

## Prevention

- For each tunable parser, list every downstream field the tunable feeds. The parser should accept only values those fields accept, unless the producer has an explicit skip rule.
- Test accepted boundary values through the whole path, not just the parser:
  - 0;
  - the smallest positive value;
  - a fraction, wherever a downstream field is integer-only.
- Round-trip each one through a real commit, reopen, projection rebuild, and export and import.
- Keep a positive control next to each boundary test, so the test can't pass just because the feature is switched off.

## Related Issues

- PR #58: <https://github.com/marcusrbrown/panthea/pull/58>
- Fix: `b995a2d` (`fix(world): derive no belief from a report when told salience is zero`)
- First parser fix: `adcdf44`
- `docs/product/defaults.md`: the memory and relationship tunables
- [Authoritative rule validation](../best-practices/authoritative-rule-validation-2026-09-27.md): keep invariants visible at the persistence boundary
- [World and persistence composed incorrectly despite green package tests](../integration-issues/world-persistence-composition-broken-after-reopen-2026-09-27.md): decode is a parser, so a malformed value fails reload
