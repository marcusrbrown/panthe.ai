# Content and art specification

Status: Accepted direction after nine interview rounds.
This document defines content production requirements rather than completed mythology research or final assets.
Requirements W01, W02, W11, X02, X03, and U06–U08 govern delivery.

## Starter content

The Greek starter cast is Zeus, Hera, Athena, Hermes, Hephaestus, Poseidon, and Hades.
Each needs a researched identity, core drives, relationships, powers, ordinary routines, and characteristic responses to fortune or misfortune.
The implementation must select and record the source variants used.

The initial maps are a mortal town and nearby wilderness, compact Olympus, and a playable Underworld.
Include functional town locations such as shop, tavern, and inn.
Olympus includes a small selection of spaces such as a throne room, gardens, and forge.

Ordinary populations include humans, animals, and at least a small example of a non-human mythological inhabitant.
The baseline active population comes from performance probes.
A scheduled mythological beast provides a concrete director/Universe event fixture.

## Mythology and education

Ground profiles in researched myths and document variants.
Keep source tradition, variant, authored interpretation, and emergent simulation event distinct.
A newly generated legend is not automatically historical lore.

For each profile or power, store these fields:

- Source title, author or tradition, edition/translation, stable reference, and access date.
- Relevant passage or locator and a short paraphrase.
- Variant identifier and conflicting interpretations.
- Chosen game interpretation and reasons for simplification.
- Attribution and redistribution information for any included text or media.

Bundle an offline lore index and source summaries with character inspection.
Do not rely on live web retrieval during play.
Detailed character biographies and source selection are implementation content work, not research already completed by this package.

## Tone and expansion

The owner intends no political statement or position for or against modern religion.
Characters express humanlike traits and the emotional range of their stories.
Violence, tragedy, humor, romance, and mature themes can coexist with approachable pixel art.

Future content includes Norse, Yoruba, Roman, and tentatively Akan traditions.
Keep named traditions distinct and document their own variants rather than flattening them into a generic aesthetic.
American Gods informs cross-tradition interaction, while the initial environments remain classic rather than contemporary.

New pantheons must be content packs with explicit realm, visual, source, and power rules.
A test-only alternate realm can validate extension contracts without shipping an additional full pantheon.
Lesser-deity creation, permanent divine death, and character-reset events remain post-MVP exploration.

## Visual language

Use polished original pixel art with an isometric view.
World sprites are simpler than the expressive JRPG portraits used with speech.
Define pixel scale, palette families, silhouettes, animation timing, portrait framing, and effect intensity in a shared art guide.

AI-generated assets are acceptable.
Use procedural composition and local/hosted image jobs through the same asset contract.
Continuous character activity takes priority over long generation jobs.

Every sprite asset needs dimensions, origin/pivot, collision footprint, facing, animation states, and palette/style metadata.
Every portrait needs character identity and supported expressions.
Maps and effects need consistent coordinate, layer, and occlusion rules.

## Reference scene

Zeus sits on a cloud with part of his body obscured.
His portrait changes expression as he speaks.
He extends an arm, lightning forms, and a convincing full-screen strike follows.

The strike destroys a tree beside a building.
The building catches fire and retains damage after the effect ends.
NPCs react and the building's service, stock, and income reflect its state.

The same event must remain legible with reduced motion and effects.
Skipping the cutscene changes presentation, not committed outcomes.
Review this scene as an art, simulation, audio, and accessibility acceptance fixture.

## Audio and provenance

Include event sound effects and selective ambient music.
Provide separate volume controls and mute.
Spoken voices, video export, and direct YouTube publishing are post-MVP.

Record creation method, source assets, generation inputs, model/runtime version where available, result hashes, and license/attribution metadata.
Project MIT licensing does not replace per-asset provenance records.
Use original work or appropriately sourced materials rather than copying Chrono Trigger art, music, or portraits.
