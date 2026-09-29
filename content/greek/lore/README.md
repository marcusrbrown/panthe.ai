# Lore sourcing rule

Each god profile in [`../gods`](../gods) carries its own source manifest.
The loader rejects a profile that breaks these rules.

- **Lore is sourced.** Every `lore` statement is a short paraphrase with at least one citation.
  A citation names a source id from the profile's `sources` list and a `locator` (book and line, or book.chapter.section).
  Where a line number is uncertain, cite the work and section only. Do not invent line numbers.
- **Variants are cited.** Where accounts differ, a `variants` entry says how and cites each account, and says which reading the profile keeps.
- **Inventions are labeled.** Anything the game adds that no source states goes in `inventions` with a reason.
  An invention never carries citations and is never listed in `lore`. Never label an unsourced invention as researched mythology.
- **Abilities are game mappings.** An ability names an existing world action (`strike`, `legend`, and so on). The world's rules enforce it. The profile grants nothing by itself.
- **Sources record what was checked.** A source's `accessed` date means someone checked the cited locators against that edition on that date.
  Locators are the line or section numbers of that edition; other editions may number differently.
- **Attribution.** Profiles paraphrase. They reproduce no translation text. Cite the translation used when a translator is named.

Requirements: W01 (sourced profiles and variant notes). The lore-sources decision is in [open-decisions.md](../../../docs/product/open-decisions.md).
