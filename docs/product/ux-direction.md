# UX specification

Status: Accepted direction and delegated defaults after round nine.
Requirements X01–X06 and the player/operator requirements define the release obligations.
The world is the primary surface, with inspection and controls revealed when relevant.

## Setup and first entry

Detect rendering support, available local providers, model readiness, and writable world storage.
Offer an existing local endpoint or a guided download.
Show model size, disk requirement, progress, cancellation, and a recoverable failure state.

Explain local-only versus mixed-provider operation before activating hosted connections.
First setup can need networking; subsequent core use must work offline.
Until the model is ready, distinguish a presentation preview from a genuinely autonomous live world.

After setup, the title overlays the running saved or starter world.
Offer observe, create/enter mortal, resume mortal, and Universe.
Introduce the seven gods and provide a skippable orientation for movement, conversation, observation, and realm travel.

## World and movement

Use an isometric canvas with consistent pixel scale and expressive character portraits.
Keep primary HUD information limited to current realm, character condition, immediate interaction, and relevant alerts.
Avoid exposing raw model or database details in ordinary play.

Support keyboard and joypad movement.
Pointer selection opens a contextual menu or selects a movement destination.
Use clear reachable/unreachable feedback and retain a way to cancel movement.

In-world transport moves the mortal between realms.
Observer realm cards switch the camera without moving a character.
Travel restrictions explain the relevant in-world condition, such as a ward or banishment.

## Dialogue and encounters

Show free-form text input, contextual actions, speech history, and expressive portraits.
Keep waiting states specific: reply pending, interrupted, unavailable, or routine-only mode.
An NPC remains responsive to danger and other characters while conversing.

Conflict exposes readiness, available actions, and target feedback.
Present fight, flee, persuade, and call/summon according to capability.
Do not promise success merely because an action is selectable.

Cutscenes follow committed or scheduled presentation events.
Skip affects presentation only and cannot cancel a completed world action.
Keep urgent player-state feedback visible and permit immediate exit from a scene.

## Observation and inspection

The default observer view shows the world and speech.
Selecting a god opens recent activity, current imperatives, and a concise in-character motive account.
Deeper inspection exposes memories, relationships, inventory, powers, events, prompts, and model performance.

Link a narrative account to actual event records where available.
A motive account is fictional character content, not a promise to expose private model reasoning.
Inspection does not inform characters by default; inspection-detecting powers are deferred.

Allow following a character, switching locations, and returning to the last view.
Show when a followed entity travels, dies, becomes banished, or no longer exists.
Distinguish current observation from recorded playback.

## Universe

Use separate visual controls, a command palette/console, and natural-language entry.
Show selected targets and the effect of a pending natural-language instruction before committing it.
The local owner has full authority without an in-world operator avatar.

Provide character relocation, prompt/imperative editing, resource changes, environment recovery, and event scheduling.
Show scheduled events, cancellation controls, and execution results.
History identifies the operator action, affected entities, time, and trace links.

Snapshot restoration creates a new branch by default.
Show the selected snapshot and which world will become active.
Do not present individual-event reversal as a reliable undo operation.

## Continuity and recovery

Offer pause, resume, background status, stop-world, snapshot, export, and restore.
Closing a window leaves the configured background world running.
Make the distinction between closing the view and stopping the simulation visible.

After an absence, summarize catch-up, deaths, transformations, relationship changes, and damaged or recovered places.
An afterlife return resumes play at the actual character state.
Retiring a character displays its consequence before committing permanent death.

## Accessibility and responsive layout

Honor operating-system reduced-motion preferences and provide an in-app override.
Provide a reduced-effects mode without screen shake or high-intensity flashes.
Communicate effects through text and persistent world state as well as animation.

Core menus and inspection support keyboard focus, visible focus indicators, and controller navigation.
Allow input rebinding and separate dialogue entry from movement hotkeys.
Scale UI text independently from pixel-art zoom.

Use ordinary readable interface fonts for long text; pixel typography can serve short decorative elements.
Do not rely on color alone for state.
Target a usable 1280×720 desktop window initially, with reflow and scroll for larger text.

Keep menus, dialogue, and inspection accessible through semantic UI elements where possible.
Provide a textual selected-entity/event view alongside the canvas.
Full nonvisual navigation of the entire game world is a future accessibility extension, not an implied completed capability.

## Audio and release review

Provide independent music and effects volume with mute controls.
Music is selective and ambient.
Spoken voices are post-MVP.

Review the first ten minutes, a Zeus strike, an afterlife transition, model failure, and snapshot restore on the actual baseline device.
Assess hierarchy, readability, input parity, pacing, and recovery using the owner's Impeccable quality direction.
