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
- **One source per book.** A profile may declare a source for each book it cites (`iliad-1`, `iliad-18`), each with the url of the page it was checked on, so a locator is checked against one page. Locators are the line or section numbers of that edition; a page that marks only the start of a passage (Theoi.com's Homer and Hesiod) still numbers lines by the Greek.
- **Relationships are sourced.** A profile ties a god to another only where its lore or a variant names the tie, and the other god must be in the pack. A starting disposition is authored tuning and the profile says so.
- **Attribution.** Profiles paraphrase. They reproduce no translation text. Cite the translation used when a translator is named.

Requirements: W01 (sourced profiles and variant notes). The lore-sources decision is in [open-decisions.md](../../../docs/product/open-decisions.md).

## Motif catalogue

[`motifs.json`](motifs.json) sources the endings a practice thread can draw on (R17): boon, compensation, standing won and lost, transformation as punishment or mercy, and the Styx oath penalty. It follows the same rules as a profile, with two additions.

- **Late Roman accounts are labeled.** A source marked `late-roman` (Ovid) puts that label on every motif that cites it. A motif with a game invention carries `game-invention`. The parser checks both labels against what the motif cites and lists.
- **The world and the catalogue agree.** Every motif the world can apply must be catalogued with the change the world makes, and a motif with no source fails to parse. A motif left out on purpose (the curse) is listed in `omitted` with its reason.

Its locators were checked against the Theoi.com and Perseus texts on 2026-10-02, the `accessed` date on each source. Locators follow those editions' numbering, and Apollodorus follows Frazer's.
