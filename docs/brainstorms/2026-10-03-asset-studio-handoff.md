# Handoff: Asset Studio foundation

Written 2026-10-03 for a fresh OpenCode root session that builds the asset studio in its own worktree, in parallel with the M2 core session (`ses_f069d18e6ffeWyhvY4uvJbG9gH`, main checkout, currently `feat/contests` and `perf/catchup-bench`). Paste the prompt below as the first message of the new root. The repository convention for root handoffs is `~/.local/state/opencode-handoffs/`; copy this file there as `panthea-studio-2026-10-03.md` if you keep that habit.

---

## Prompt

STUDIO-ROOT-V1

You are a fresh root session for the Panthea repository (`/Users/mrbrown/src/github.com/marcusrbrown/panthea`). Your lane is the **asset studio**: the tooling that turns a prompt such as "Zeus movement sprites" into conformant, provenance-tracked pixel-art, tile, effect, and sound assets, hand-finished in Aseprite, procedurally extended, and registered so the game client hot-swaps them over its placeholders. A separate root session owns M2 simulation work in the main checkout; you do not share a working tree with it.

### 1. Establish your worktree

- From the main checkout, create a sibling worktree following the existing pattern (`../panthea-dispatch`, `../panthea-settings`): `git worktree add ../panthea-studio -b feat/studio-foundation origin/main`. Work only there.
- Do not modify files, config, git state, or remote state in the main checkout.
- Confirm `bun install --frozen-lockfile` and `bun run check` pass in the worktree before changing anything.

### 2. Read, in this order

1. `AGENTS.md` (invariants, layout, workflow, verification, owner interaction).
2. `docs/brainstorms/2026-10-03-asset-studio-requirements.md` (what to build; R1–R24, flows F1–F6, acceptance examples).
3. `docs/research/asset-generation-2026-10-03.md` (model, cleanup, tile, sound, and editor options with licences; candidate packages).
4. `docs/product/art-guide.md` (draft standards the conformance step enforces; the owner may still veto defaults).
5. `docs/product/content-direction.md`, `docs/decisions/0007-local-image-generation.md`, `tools/probes/art-local/README.md`, `tools/probes/art-local/src/placeholder.ts` (the M0 base arm, LoRA licence caveat, cancellation limits, deterministic placeholder contract).
6. `docs/decisions/0005-model-providers.md` (the memory-coexistence gate governs in-game generation, not authoring).
7. `apps/client/src/renderer/scene.ts`, `markers.ts`, `presentation.ts`, `packages/assets/src/index.ts`, `packages/contracts/src/content.ts` (what the registry replaces and where contracts live).
8. `docs/plans/2026-10-02-001-feat-god-practices-plan.md` as the house example of a Systematic plan.

### 3. Owner decisions already made (do not reopen)

- Local-only generation; hosted providers (PixelLab, Retro Diffusion) exist as an interface, never wired or keyed.
- `apps/studio` is a separate Tauri app that embeds the client renderer for preview; `tools/studio` is the headless CLI with the same pipeline.
- Aseprite is the human-loop editor, owner-installed, driven headless; the pipeline degrades to PNG+JSON when it is absent.
- M1 Pro 16 GB is the authoring ceiling; 24 GB+ paths stay documented.
- Hybrid pipeline: diffusion makes candidates, the owner makes them canon in Aseprite, derivation covers only what it can guarantee (mirror, palette swap, overlay, idle bob), new poses are hand-drawn or generated and repaired.
- Tier 1 is Zeus idle-south, seated-on-cloud, one strike `act`, and the six-expression portrait. Walk cycles wait for actor position and facing in the contracts (core lane).
- Work ships by tier (T1 Zeus on screen, T2 reference scene, T3 tiles and sound), each independently.

### 4. First actions / next thread

Run `ce:plan` against `docs/brainstorms/2026-10-03-asset-studio-requirements.md` and produce `docs/plans/2026-10-03-001-feat-asset-studio-foundation-plan.md`. The plan must sequence these units; keep each one a separate small PR so the core session's PRs and yours merge without conflict:

**Tier 1 — Zeus on screen**

1. **Probe `tools/probes/art-local-2`**: on the M1 Pro, with the current `sd-server` release (the M0 release binary had Metal; build from source only if this one does not), measure the fallback order from R6 — FLUX.2-klein-4B + svntax sprite-sheet LoRA, Z-Image-Turbo + Pixel Art Style LoRA, then SDXL + `pixel-art-xl` — at the art guide's cells (64×80 god, 96×96 portrait, generated at 8×): warmup, seconds/image p50/p95, peak RSS, LoRA firing confirmed by fixed-seed with/without comparison, abort-to-idle time for the subprocess-restart cancel path, contact sheets for owner review. Pass criteria are in the requirements doc's Dependencies. Record licences and hashes like the M0 probe. Output: README with results and a recommended chain; a supersession note on ADR-0007 (do not erase its measurements).
2. **Contracts and registry (`packages/contracts`, `packages/assets`, `packages/content`)**: asset manifest, provenance record (including cancelled jobs and weight licences), registry entry keyed by the god profile's `sprite` field, lifecycle states, per-kind provider interfaces with a shared job/provenance envelope, conformance report types; content-addressed registry read/write; placeholder fallback resolution; a registry URI scheme that does not collide with Tauri's `asset:`; additive visual fields on `GodProfile`. Versioned schemas with tests. Move the deterministic placeholder from the probe into `@panthea/assets` with byte-identical output. Add the manifest/registry validator to `tools/content`.
3. **Conformance library (`packages/assets`)**: grid detection with a confidence value, k-centroid downscale, fixed-palette quantization, alpha binarization, silhouette test, mirror check, report-only mode; pure TypeScript, deterministic, fixture-tested. Optional external `pixel-art-fixer` detector behind a flag.
4. **Master palette gate**: propose the 64-colour master palette and the three realm families as `.gpl`/`.hex` under `content/greek/palette/`, with contact-sheet swatches; ask the owner to approve before any canon publish.
5. **CLI pipeline (`tools/studio`)**: `generate` (batch of N, request form resolution, reroll appends), `conform`, `open` (Aseprite round trip via `aseprite -b --script`; "export/import edited" when absent), `derive`, `pack`, `publish`; queue with remove, abort by generator restart, one heavy model resident at a time; contact sheets with per-check results. Exercise F1, F2, F4 headless on Zeus idle south and the portrait.
6. **Isometric preview layer**: a three-flatland scene with integer zoom, nearest-neighbour upscale, `x + y − z` ordering, placeholder context elements; verify `TileMap2D` isometric support first. Studio-owned code; extraction into a shared renderer package the client adopts is a later coordinated unit.
7. **`apps/studio` shell**: Tauri app hosting the pipeline as a Bun sidecar (follow `apps/simulation/scripts/build-sidecar.sh` and the `panthea-sim` capability pattern; no shell or fs permissions in the webview), with the request form, queue, contact sheet, approve/reroll, open-in-Aseprite with the "editing externally" state, draft and approved preview, live reload. Screenshots as evidence.
8. **Client integration (`apps/client`, `apps/desktop`)**: resolve actor visuals through the registry with placeholder fallback; define the packaged client's registry file location and loading path (coordinated capability PR); a scenario step in a new `tools/scenarios/studio-zeus-scene` that loads the canon Zeus set and asserts idle-south renders. Coordinate with the core session (see §5).

**Tier 2 — reference scene**

9. **Derivation**: mirrors with asymmetry rules, idle bob, palette swaps, overlays; byte-identical regeneration tests; reference-conditioned generation plus inpaint repair for non-derivable frames; multi-frame playback on the contact sheet.
10. **Structures and effects**: tree; building intact/damaged/burning as overlays; lightning effect at three tiers with tier one under 300 ms; reduced-effects preview.

**Tier 3 — world and sound**

11. **Tiles**: dual-grid stamping with isometric diamond masks, Tiled tileset export with Wang metadata, depth-sorted map preview.
12. **Sound**: zzfx/jsfxr presets, mutation, and parameter panel; optional LLM proposals through a configured local endpoint; offline render, true-peak normalisation, Opus output, committed parameters as source. The SFX model is deferred until a sound the synth cannot produce is identified.

Then execute unit 1 with `ce:work` without asking "what next". Units 2–4 may proceed in parallel with unit 1's measurements where they do not depend on the chosen chain.

### 5. Working alongside the core session

- Shared-additive packages are `packages/contracts`, `packages/assets`, `packages/content`, and `tools/content`. Changes there are additive and land first in their own PR, rebased on `main`, before any dependent studio PR.
- Do not edit `packages/world`, `packages/agents`, `packages/persistence`, `apps/simulation`, `content/greek/gods/*`, or `tools/scenarios/m1-*`/`m2-*` without stating the need in the PR and tagging the owner; the core session owns them. The studio writes its subject-to-asset mappings in `content/greek/assets/`.
- `apps/client` changes are limited to visual resolution through the registry and the renderer extraction unit; do not change store, connection, observer, or settings behaviour. `apps/desktop` capability changes are coordinated PRs.
- Record the D18/D24 narrowing as D26 in `docs/product/decisions.md` in the first studio PR (owner-facing authoring tooling for assets is in scope; player-facing in-game editors stay deferred).
- Update `docs/product/traceability.md` rows U06, U07, X02, X03, and U08 in every PR that touches them, with evidence paths; propose a new requirement ID for authoring tooling in the plan if none fits.
- Record every architecture choice as an ADR (`docs/decisions/0009-...` onward) with Status, Context, Decision, Consequences, Evidence/links, Requirement IDs; update `docs/decisions/README.md`.
- After each merged unit, run `ce:compound` into `docs/solutions/`.

### 6. Gates that need the owner (use the question tool, finish document updates first, then wait)

- Adding any dependency or touching `bun.lock` (the research doc lists candidates with licences and lighter alternatives; prefer vendoring tiny libraries and writing the quantizer in TypeScript).
- Any model, LoRA, or weight whose licence is not Apache-2.0, MIT, or an OpenRAIL variant with outputs free; never vendor weights.
- Changes to CI, release, or build pipelines; Tauri capabilities or permissions for `apps/studio`.
- Deleting files, removing worktrees or branches, force pushes.
- Any art-guide default you want to change rather than enforce; propose the change to `docs/product/art-guide.md` and ask.

### 7. Verification (nothing is done without it)

- `bun install --frozen-lockfile`, `bun run check`; `cargo fmt --check && cargo clippy -- -D warnings` in any Tauri crate you touch.
- Conformance and derivation are deterministic: tests assert byte-identical output for identical inputs.
- Probe claims carry measured numbers, hardware, and hashes; contact sheets for owner review; no quality claims without the owner's rating.
- UI changes carry window-cropped screenshots under `docs/evidence/asset-studio/`.
- Mocks, successful installs, and browser-only demos are not proof; the Zeus set rendering in the packaged client over its placeholder is.

### 8. Future handoff contract

When asked for a handoff, include: goal and verified state; worktree, branch, commits, PRs, CI state; reusable subagent session IDs; exact paths, URLs, commands, and errors that affect continuation; deferred work and open owner gates; and a mandatory "First actions / next thread" section that directs the next root's first work.

---

## Notes for the owner

- The handoff assumes the research doc and art guide are merged on `main` before the new root starts (so the worktree sees them). Open the docs PR from this session's output first.
- `apps/studio` as a Tauri app means a second Rust crate under `apps/studio/src-tauri`; expect the first `cargo` build to be slow and a `renovate` config touch for the new crate, which is a CI gate.
- Aseprite on `PATH` is a prerequisite for unit 4's `open` step; `/Applications/Aseprite.app/Contents/MacOS/aseprite` is the usual path if a symlink is needed.
