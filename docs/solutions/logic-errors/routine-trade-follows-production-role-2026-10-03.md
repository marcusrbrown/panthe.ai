---
title: Two traders passed one good back and forth forever, because resale followed possession
date: 2026-10-03
category: logic-errors
module: simulation-core
problem_type: logic_error
component: service_object
symptoms:
  - "With twenty routine mortals, two traders passed the same good back and forth on every tick"
  - "Gathering stopped while the trade loop ran, so livelihoods produced nothing"
  - "A mortal who only held a recipe's output resold it like its maker"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [routines, trade, economy, production-role, resale, livelihoods, w06, r21]
---

# Two traders passed one good back and forth forever, because resale followed possession

## Problem

Unit 7 grew the town to twenty routine mortals. Several of them now gathered or wanted the same goods. Routine trade treated any held good as sellable surplus, so two mortals with matching wants passed one good back and forth forever. Because selling ranked ahead of gathering, nothing got gathered (W06, practice R21).

## Symptoms

- In a scripted day, sales of one good between the same two actors grew every tick, with no matching production.
- Gatherers in the loop stopped gathering.
- A buyer who merely held a recipe's output (planks, cloth, tools) resold it to the next buyer like its maker.

## What Didn't Work

Trade acceptance alone can't stop it. A counterparty accepts by value (`packages/world/src/economy.ts`, `evaluateTradeAcceptance`):

```ts
const received = totalValue(rules, give);
const given = totalValue(rules, receive);
const demand = 1 + counterpartyDrives.thrift - counterpartyDrives.greed;
return received >= given * demand;
```

That is right for safety: the world never commits an unfair trade. But it says nothing about whether the trade makes sense for either livelihood, so two actors with symmetric values will accept the same exchange in both directions.

## Solution

Two rules in `packages/world/src/routines.ts` tie routine resale to production role.

A gatherer does not sell surplus to someone who gathers the same good:

```ts
(candidate) =>
  // Someone who gathers the same thing has no use for more of it: two
  // gatherers of one good would pass it back and forth and never gather.
  candidate.gathers !== resource &&
  getResourceAmount(candidate.inventory, "currency") >= askPrice &&
  evaluateTradeAcceptance(state.rules, candidate.drives ?? NEUTRAL_DRIVES, give, receive),
```

Only someone who works a recipe's inputs sells its output:

```ts
// Only someone who works the recipe's inputs sells what it makes; a buyer
// who merely holds the output keeps it, or two traders would pass it back
// and forth forever.
const works = recipe.inputs.some(
  (input) => input.resource === actor.gathers || input.resource === actor.wants,
);
if (!works) continue;
```

Tests in `packages/world/src/routines.test.ts` pin both rules: a fisher with a willing buyer who also fishes keeps gathering, and a mere holder of an output does not resell it. The old carpenter test now has the carpenter gather wood.

## Why This Works

The rules separate holding a good from making it. Real surplus still sells to someone with a use for it, and makers still sell what they make. An incidental holder keeps the good instead of becoming a distributor. No produced-good loop remains in the authored pack.

On the authored Greek pack over a 400-tick day, there were 208 cloth trades and 226 tools trades, with 0 cloth or tools round trips (A sells to B, then B sells the same good back to A). Production matched gathering: 208 cloth made from 209 wool gathers, and 226 tools from 226 ore gathers.

**Known limit:** nothing stops a buyer who works the same recipe. It can't loop in the authored pack, because weavers want olives and smiths want nothing they make. A pack that gives same-recipe makers a want for their own output could loop again.

## Prevention

- Keep the scripted-day test in `apps/simulation/src/greek-livelihoods.test.ts`. It checks that each livelihood produces and trades, and that fishers, weavers and smiths sell no more fish, cloth or tools than they gathered or made:

  ```ts
  expect(sold(weavers, "cloth").length).toBeLessThanOrEqual(produced(weavers, "cloth").length);
  ```

- When adding a livelihood, check for round trips of the same good between the same two actors, not just total trade counts.
- Decide who sells what from production role (gathers it, or works its recipe), never from inventory alone.

## Related Issues

- PR #102 (squash `d566975`).
- [tick-admission-starved-external-proposals-2026-09-28.md](tick-admission-starved-external-proposals-2026-09-28.md): another way routine mortals starved useful work, through admission order.
- [authoritative-rule-validation-2026-09-27.md](../best-practices/authoritative-rule-validation-2026-09-27.md): the world validates each trade; this fix is upstream, in which trades routines propose.
