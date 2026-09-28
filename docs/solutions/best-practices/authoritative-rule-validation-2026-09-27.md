---
title: Authoritative rules take intent from proposals and everything else from the world
date: 2026-09-27
category: best-practices
module: world-persistence
problem_type: design_pattern
component: development_workflow
severity: high
applies_when:
  - Writing or changing a rule handler in packages/world/src/validate.ts
  - A proposal names an amount, a resource type, a target, or an identity
  - A rule moves a balance between actors or buildings
  - A rule changes a status such as a building lifecycle
  - A new invariant must hold after reopen and decode
tags: [authoritative-rules, proposal-validation, conservation, state-machine, lifecycle, w05, w06, w08]
---

# Authoritative rules take intent from proposals and everything else from the world

## Context

The world engine validates every proposal at execution time; routines and fixtures propose today, and models join them in M2. The M1 economy and consequence rules passed the package suite and still admitted seven holes. Each one let a proposal decide something the world should decide:

- Gather committed any resource the proposal named, and the amount the proposal asked for. One proposal could mint currency or a million wood.
- A trade between an actor and itself overwrote that actor's inventory, because the second `Map#set` won.
- Trade holds were checked line by line. Two 8-currency lines against a balance of 10 both passed, the balance went negative, and the world then failed to decode on reopen.
- Any actor could be worshipped. A farmer could worship itself, credit its own divinity, and strike.
- A strike on a destroyed building set it burning or damaged again, skipping repair.
- A strike on a burning building either reset its fire or moved it to damaged, which nothing advanced or repaired. That left it with no services or income.

## Guidance

A proposal carries intent: who acts, what kind of action, and which target. Everything else comes from authored rules and committed state.

1. **Magnitudes come from authored rules.** Yield, cost, and bonus values are read from content and state. A proposal's amount is never trusted.
2. **Claimed authority is an authored marker.** The world only accepts an action type or role when it is authored in content, carried in state, and round-tripped by the codec. Examples are the resource an actor gathers, and whether an actor is a deity.
3. **Check the total effect per resource.** Sum all lines for each resource on each side, then compare the sums with what each side holds.
4. **Reject identity aliasing.** The validator rejects the same id on both sides of a transfer, and the transfer helper throws on it.
5. **Guard every transition by the current status.** Write down which actions may act in which status. Test that every status can reach the normal operating state.
6. **Keep invariants visible at the persistence boundary.** The codec parser rejects impossible values, such as negative balances or inconsistent flags.
7. **Change the whole path together.** A new proposal kind, status, or authority marker updates the validator, the reducer or helper it relies on, the codec parser, and a real-store test that reopens the world.

These checks pass the [greenfield rent test](greenfield-anti-over-engineering-2026-09-27.md). Each one closes a concrete violation of W05 (rules are authoritative over intentions), the conservation rule for W06, or the recovery requirement in W08. None of them is speculative hardening.

## Why This Matters

A rule that trusts a proposal-supplied value lets any producer mint value, claim a role, or push the world into a state it cannot leave. M2 adds model-generated proposals, so the same rule will then face untrusted input. Unit tests written from the happy path rarely try a caller who lies, and a proposal that is valid in shape is not valid in effect. The persistence boundary is where silent corruption becomes a load failure, so invariants checked there turn hidden bugs into visible ones.

## When to Apply

- Adding or changing any handler in `packages/world/src/validate.ts`, and any reducer it relies on
- Adding a proposal field, a content field that grants a role, or a new status
- Reviewing a rule: for each proposal field, ask whether the world should decide it instead

## Examples

| Hole | Rule it broke | Fix | Test |
|---|---|---|---|
| Gather amount from the proposal | Magnitudes from authored rules | `gatherAmountOf(state.rules)` plus the active favor bonus | A proposal for 1,000,000 wood commits the authored yield |
| Gather of any resource | Authority is authored | Reject unless `proposal.resource === actor.gathers` | A currency gather is rejected |
| Self-trade | Reject aliasing | `handleTrade` rejects `actor === counterparty`; `transferBetweenActors` throws | Self-trade rejected, inventory unchanged |
| Repeated trade lines | Total effect per resource | `aggregateByResource` before the holds check | Two 8-currency lines against 10 are rejected; no negative balance after reopen |
| Any actor worshipped | Authority is authored | `deity: true` in content becomes `ActorState.isDeity`; worship and strike require it | Self-worship and worship of a mortal are rejected |
| Strike on destroyed or burning | Guard transitions by status | Strikes on burning, destroyed, or repairing buildings are rejected | The fire still progresses to destroyed, then repair |
| Damaged with no way out | Every status recoverable | Repair also accepts damaged | Table test over every status |

Before and after, gather:

```ts
// Before: the proposal decides the amount
amount: proposal.amount,

// After: the world decides it
amount: gatherAmountOf(state.rules) + bonus,
```

Holds checked on totals:

```ts
for (const [resource, amount] of aggregateByResource(proposal.give)) {
  if (getResourceAmount(actor.inventory, resource) < amount) {
    return reject("insufficient-resources", `actor lacks ${amount} ${resource} to give`);
  }
}
```

Closed lifecycle, from `packages/world/src/fire.test.ts`:

```ts
test("every building status has a path back to operational", () => {
  for (const status of BUILDING_STATUSES) {
    let state = buildingInStatus(status);
    let prng: PrngState = createPrng(1);
    let guard = 0;
    while (state.buildings.get(toEntityId("the-tavern"))?.status === "burning" && guard < 20) {
      const tick = runTick(state, prng, []);
      state = tick.state;
      prng = tick.prng;
      guard += 1;
    }
    guard = 0;
    while (state.buildings.get(toEntityId("the-tavern"))?.status !== "operational" && guard < 20) {
      const decision = decideRoutineProposal(state, toEntityId("farmer"));
      const tick = runTick(state, prng, decision ? [decision.proposal] : []);
      state = tick.state;
      prng = tick.prng;
      guard += 1;
    }
    expect(state.buildings.get(toEntityId("the-tavern"))?.status).toBe("operational");
  }
});
```

## Related

- [Build the direct version first in a greenfield, single-user codebase](greenfield-anti-over-engineering-2026-09-27.md)
- [World and persistence composed incorrectly despite green package tests](../integration-issues/world-persistence-composition-broken-after-reopen-2026-09-27.md)
- `docs/plans/2026-09-27-001-feat-m1-persistent-living-world-plan.md`: Key Technical Decisions (execution-time validation) and Unit 6 (checking legend links at intake)
- `docs/product/requirements.md`: W05, W06, W07, W08
