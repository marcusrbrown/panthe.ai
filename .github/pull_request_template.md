<!-- Keep this terse. Delete instructional text, keep the headings. -->

## Summary

<!-- What changed and why, in 1-3 sentences. -->

## Requirements

- Requirement IDs touched (P/W/M/U/X/O): <!-- e.g. P03, W12 — or "None" -->
- `docs/product/traceability.md` updated: <!-- yes / no / n/a -->

## Decisions

- ADR or D-record affected: <!-- e.g. ADR 0002, D19 — or "None" -->

## Verification

<!-- Exact commands run and their result. -->

- [ ] `bun install --frozen-lockfile`
- [ ] `bun run check` (typecheck, lint, test)
- [ ] `cargo fmt --check && cargo clippy -- -D warnings` (if Rust changed)

## Approval needed

- [ ] Workflows / CI
- [ ] Dependencies / lockfile
- [ ] Secrets, auth, CSP, or Tauri capabilities
- [ ] Release infrastructure
