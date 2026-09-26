# Simulation specification

Status: Accepted direction plus delegated defaults after round nine.
Requirements W01–W11, M01–M08, and U04–U07 govern these rules.
Numerical balance belongs in data files and configuration, not hidden prompt text.

## Authority and state

The world engine is the sole authority for committed state.
Models produce speech, intentions, plans, and candidate behaviors.
Each attempted action names its actor, targets, preconditions, required capabilities, costs, and expected state revision.

Validate an action when it executes, not only when a model first proposes it.
A moved target, interrupted cast, spent item, or dead actor can invalidate a pending action.
Record rejection and permit replanning without pretending the action succeeded.

Separate objective events, character beliefs, and narrative accounts.
A god can lie, misunderstand, forget, or spread an apocryphal legend.
Its statement cannot grant inventory or cause harm without a valid action.

## Character contract

Each character has stable identity, origin realm, form, core drives, powers, resources, inventory, routines, memories, and relationships.
Player control is a mode attached to a mortal, not a separate species of world entity.
Background NPCs retain the same available mechanics but can use simpler prompts and less frequent reasoning.

Perception determines the observations available to a character.
Knowledge comes through sensing, reports, memories, or an explicit divine power.
Observer and Universe information do not leak into character context.

Preserve an event reference, source, confidence, and time for important memories or beliefs.
Summary and forgetting policies can reduce inference load without deleting the authoritative history.
Personality can evolve around core drives; model fine-tuning and lesser-deity creation are not required for MVP.

## Scheduling and interruption

Movement, animation, and routine actions continue while a model request is pending.
Use bounded reasoning queues and reserve capacity for direct player interaction.
Cancel or revalidate stale results after interruption, death, travel, or state changes.

One character cannot simultaneously spend the same resource in two actions.
A conversation records participants and can be interrupted by other actors or environmental changes.
An interruption can end, suspend, or redirect dialogue according to explicit rules.

Offscreen areas continue at reduced detail where needed.
Reduced detail must preserve consequential resource, relationship, and life-state changes.
Record when a result comes from approximate catch-up rather than a full live sequence.

## World geography

The initial world contains a town with shop, tavern, inn, nearby wilderness, compact Olympus, and a playable Underworld.
Town and wilderness form a continuous traversable landscape.
Realm transitions use in-world transport elements and prepared visual transitions.

Observer switching changes only the camera.
Gods travel freely unless protection, power, or banishment rules restrict them.
Gods can transport mortals past ordinary access restrictions through explicit powers.

Model realm identity separately from map identity.
An Olympus room and mortal town can share Greek tradition without sharing location or access rules.
Realm modifiers govern power costs, capability limits, and the presentation of replicated creations.

## Combat

Use readiness-based, asynchronous turns with cast and recovery times.
The world continues while encounters resolve.
Pause remains a world-level control rather than an automatic dialogue or combat behavior.

Expose fight, flee, persuade, and call/summon actions when available.
A call is a request, not a guaranteed divine intervention.
Items or granted powers can enable hiding.

Gods have power costs and cooldowns even when ordinary players cannot see their exact values.
Damage can cause injury, death, interruption, transformation, or environmental effects through typed outcomes.
Defeated gods enter banishment or recovery; permanent divine death is deferred.

## Economy, damage, and recovery

NPCs gather, produce, move goods, trade, consume resources, and pursue personal economic drives.
Start with a small documented resource graph: currency, food, timber/materials, and trade goods.
This graph is a delegated implementation minimum, not a requirement for a complex survival game.

Buildings expose operational state, ownership or control, inventory, services, and repair needs.
A burning tavern becomes unavailable and loses inventory and trade opportunities.
Fire propagation uses explicit material/adjacency rules with bounded updates.

Recovery requires resources and a motivated actor.
Gods, NPCs, and players can support repair, purchase land, or restore services.
Universe can recover or terraform an area through an attributed operator event.

Worship acts and allegiance influence divine capacity through tunable rules.
Favor is an explicit effect with source and duration or removal conditions.
Legends record attributed narratives, including disputed versions, and link to verified events when available.

## Death and absence

The spawn realm selects the initial fate policy.
Patronage and the killer are recorded influences, with specific exceptions defined in content rules.
The Greek MVP normally routes dead mortals into the Underworld.

Death preserves identity and memory unless a specific effect changes them.
Apply item disposition rules explicitly rather than silently deleting possessions.
Offer at least one playable return condition that works for NPCs and players under the same rules.

When a player leaves, routine control takes over the same mortal.
It can be harmed, transformed, or killed while absent.
On return, show a summary and the character's current situation.

Voluntary permanent death retires control of the character in the current branch.
Keep history and relationships available for study.
A new mortal can enter the existing world without resetting it.

## Director

The director proposes events based on world state and activity.
It uses a separate role, prompt, model assignment, and trace identity.
Apply ordinary validation and a configurable event budget.

A director event can create opportunity or misfortune.
It cannot silently erase losses to manufacture a happy outcome.
A quiet period is not permission to repeatedly trigger catastrophe.

## Generated behavior

A candidate behavior includes a version, description, permitted inputs, world API calls, resource rules, and presentation references.
Validate its schema and authority, then run bounded trials before automatic activation.
Universe records accepted, rejected, superseded, and disabled versions.

The game-only runtime exposes no files, shell, credentials, network, or unrestricted host callbacks.
Bound CPU time, instructions, memory, event fan-out, object creation, and recursion.
Lua can be evaluated as an implementation option, but an ordinary Lua interpreter is not itself the required sandbox.

Use transactions or equivalent atomic commits so failed behavior cannot leave partial world corruption.
Persist generated definitions and invocation outcomes for replay.
Adapt presentation through explicit realm attributes rather than assuming a single culture for all realms.

## Visual creation

Procedural combinations provide original local visuals from authored parts, geometry, palettes, and effects.
Local and hosted image adapters add richer generation when configured.
All generation uses the same job/provenance contract and versioned asset registry.

Give a valid creation coherent temporary art while a job runs.
World activity has priority over generation, including on the 16 GB baseline.
Persist prompts, selected inputs, model/version where available, result hashes, and asset lineage according to telemetry policy.

## Time and continuity

Store simulation time separately from wall time.
Pause, background execution, and catch-up obey [defaults](defaults.md).
A persisted cursor prevents applying the same elapsed interval twice after restart.

Catch-up uses bounded steps and reports elapsed time applied, time skipped, and major outcomes.
Do not fabricate detailed recorded footage for an interval simulated only at coarse resolution.
Playback must disclose reduced-detail intervals while preserving the recorded consequences.
