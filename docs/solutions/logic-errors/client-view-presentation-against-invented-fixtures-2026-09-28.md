---
title: Client view presentation logic was written and tested against invented events and maps
date: 2026-09-28
category: logic-errors
module: client-view
problem_type: logic_error
component: tooling
symptoms:
  - Strikes and building destructions were never drawn or receipted, because their event kinds matched no selector
  - Events with no place in the viewed realm were drawn at an arbitrary location and receipted
  - The scene drew 2 of the 12 same-realm paths in the authored Greek world
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [client-view, presentation-receipts, event-kinds, fixtures, o04, scene, contract-types]
---

# Client view presentation logic was written and tested against invented events and maps

## Problem

Three presentation rules in the client view passed their tests and were wrong against real data, because each was written and tested against data the author made up: event kinds the simulation never emits, a `realm` argument nothing read, and a two-location map where every edge points "forward". Effects went missing, events that were never rendered got receipts, and most of the map's paths were missing from the scene.

## Symptoms

- `building-damaged` (a strike) and `building-destroyed` produced no effect and no presentation receipt.
- Viewing Olympus drew mortal-realm events on Olympus locations and receipted them.
- Across the authored world the scene drew 2 of the 12 same-realm paths; `town-square` had no path to `tavern`, `inn`, `shop`, `altar`, `ferry-dock`, or `mountain-path`.

## What Didn't Work

The three original selectors, all in the client's first commit:

1. **Substring matching on the kind.**

   ```ts
   const DRAWN_EVENT_KINDS = ["strike", "fire", "ignit", "trade", "worship"];
   // ...
   const kind = String(event.kind).toLowerCase();
   return DRAWN_EVENT_KINDS.some((marker) => kind.includes(marker));
   ```

   The real kinds (`packages/contracts/src/event.ts`) are `building-damaged`, `building-ignited`, `building-destroyed`, `worship-performed`, `resource-traded`, and so on. `ignit`, `trade`, and `worship` happened to be substrings; `strike` and `fire` match nothing the simulation emits. The scene picked colors the same way (`kind.includes("fire")`).
2. **A realm parameter that was accepted and ignored.**

   ```ts
   export function drawableEvents(
     view: WorldViewModel,
     _realm: string,
   ): readonly RecentEvent[] {
   ```

   The scene then placed each drawable event at `locations[index % locations.length]`, not at the place the event happened. An event that belonged to another realm was drawn on the viewed realm and, through `onDrawn`, receipted.
3. **Drawing an edge from one end only.**

   ```ts
   for (const edge of location.edges) {
     const to = points.get(edge.to);
     if (to && location.id < edge.to) line(from, to, ink, 3);
   }
   ```

   The map is authored per location, so a path exists wherever either end lists it. Only paths listed from the lexically smaller id were drawn. In `content/greek/world/locations.json`, 10 of the 12 same-realm paths are listed only by the lexically larger end: `town-square` lists `tavern`, `inn`, `shop`, `altar`, `ferry-dock`, and `mountain-path`, and `wilderness-path` lists `town-square`. The two that were drawn (`wilderness-grove`–`wilderness-path`, `asphodel-meadow`–`judgment-hall`) happen to be listed from the smaller end.

The tests could not see any of this:

```ts
const view = {
  realms: { mortal: [], olympus: [], underworld: [] },
  recentEvents: [
    { id: "strike-1", sequence: 1, tick: 1, kind: "strike", subjects: [] },
    { id: "trade-1", sequence: 3, tick: 2, kind: "trade", subjects: [] },
    { id: "other-1", sequence: 4, tick: 2, kind: "actor-moved", subjects: [] },
  ],
} as unknown as WorldViewModel;
```

The kinds are invented, every realm is empty, subjects are empty, and the cast hides the mismatch with the real type. The assertion was the invented list coming back out.

## Solution

**1. An explicit map keyed by the contract's kind.** Frequent per-tick kinds are omitted on purpose.

```ts
// apps/client/src/renderer/presentation.ts:13-20
const EFFECT_TONES: Partial<Record<RecentEvent["kind"], EffectTone>> = {
  "building-damaged": "fire",
  "building-ignited": "fire",
  "building-destroyed": "fire",
  "worship-performed": "worship",
  "resource-traded": "neutral",
  "building-repaired": "neutral",
};
```

The scene takes its color from the tone (`EFFECT_COLOR`, `apps/client/src/renderer/scene.ts:54-58`), not from the kind string.

**2. Place by subject, receipt only what was placed.** `placeEvents` resolves each event's subjects (locations, and actors and buildings standing at them) against the viewed realm and yields the first location that resolves. No resolving subject means no drawing and no receipt.

```ts
// apps/client/src/renderer/presentation.ts:62-88 (abridged)
export function placeEvents(view: WorldViewModel, realm: Realm): readonly PlacedEvent[] {
  const subjectLocation = subjectLocations(view, realm);
  // per event: skip kinds with no tone, then take the first subject that resolves
  // ...
}

export function drawableEvents(view: WorldViewModel, realm: Realm): readonly RecentEvent[] {
  return placeEvents(view, realm).map((placed) => placed.event);
}
```

`App` receipts only events that `draw` returned and that `drawableEvents(view, realm)` still lists (`apps/client/src/App.tsx:152-161`).

**3. Every same-realm path once, as an unordered pair.**

```ts
// apps/client/src/renderer/presentation.ts:113-122 (inside realmPaths)
for (const edge of location.edges) {
  if (edge.to === location.id || !inRealm.has(edge.to)) continue;
  const [a, b] =
    location.id < edge.to ? [location.id, edge.to] : [edge.to, location.id];
  const key = `${a}\u0000${b}`;
  if (seen.has(key)) continue;
  seen.add(key);
  paths.push([a, b]);
}
```

The scene loops over `realmPaths(locations)` (`apps/client/src/renderer/scene.ts:176-180`).

## Why This Works

Each fix moves the rule onto the real data model. The tone map is keyed by the contract's kind union, so it lists what the simulation emits and nothing else. Placement uses the same subject-to-location resolution the world already defines, so "drawn" means "drawn where it happened, in the realm being viewed", which is what O04 asks a presentation receipt to mean. Paths are undirected, so the unordered pair is the right key and declaration order stops mattering.

## Prevention

- Key selectors by the contract's type. `Partial<Record<RecentEvent["kind"], …>>` makes a misspelled or invented kind a type error at the object literal, which a `string[]` of markers never was.
- Give every presentation selector at least one test that runs on real data: the authored content pack, or events that went through the contract parser. `parseSyncFrame` rejects a kind outside `WORLD_EVENT_KINDS` (`packages/contracts/src/snapshot.ts:108`), so `viewWith` in `apps/client/src/renderer/presentation.test.ts:27-33` cannot carry an invented kind. `apps/client/src/renderer/paths.test.ts:72-120` reads `content/greek/world/locations.json` and asserts the drawn set equals the authored same-realm edge set, and names three routes declared only from the larger id.
- Treat a parameter that is accepted and unused as a review flag. `_realm` was the whole bug; a lint rule for unused parameters, or removing the argument, would have surfaced it.
- Assert what the code must not do with realistic data: a noise kind in the viewed realm is not drawn (`presentation.test.ts:79`), and an event whose subjects are all in another realm is neither drawn nor receipted (`presentation.test.ts:145`).

## Related Issues

- [Authoritative rules take intent from proposals and everything else from the world](../best-practices/authoritative-rule-validation-2026-09-27.md)
- [World and persistence composed incorrectly despite green package tests](../integration-issues/world-persistence-composition-broken-after-reopen-2026-09-27.md)
- O04 in [requirements.md](../../product/requirements.md)
