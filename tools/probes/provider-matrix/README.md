## Question

Can hosted provider adapters (OpenCode Zen, OpenCode Go, OpenAI/Anthropic by contract) produce structured actions and a bounded fallback chain, and is offline mode silent on the wire?

## How to run

```sh
cd tools/probes/provider-matrix
bun install
bun test                 # unit tests (auth, providers, repair, fallback, offline capture ordering — no network)
bun run src/run.ts --contract  # OpenAI/Anthropic fixture-server contract check
bun run src/run.ts --live      # live Zen/Go matrix (requires ~/.local/share/opencode/auth.json)

# Offline proof — the probe owns the whole capture window itself (single owner,
# no separately-started background tcpdump). Prime sudo once, then run --capture:
sudo -v
bun run src/run.ts --offline --capture   # 20 offline-mode requests + capture summary

# If sudo timestamp caching isn't available/persistent on this machine, run the
# whole command under sudo instead — -E preserves $HOME so auth.json still resolves:
# sudo -E bun run src/run.ts --offline --capture

# Optional advisory companion (not sudo-gated, run separately if wanted):
# log stream --predicate 'process == "mDNSResponder"' > results/offline-dns.log
```

## Caveat

Zen `zen/v1` free models are a scope note, not a tested arm — one request per model per run just reconfirms the 403 `FreeTierError` gate documented below is still in effect; see Findings for the full investigation (23 requests, 23 403s, across headers/endpoint/key-source combinations and a #50627 tool-shape follow-up). Go's free models (`space-bunny-free`, `longcat-2.5-preview-free`) aren't billed but are slow (longcat measured ~20s p50), so the live arm runs 4 requests each rather than the full 20-request cap. Go's paid model is billed per request against a $10/month subscription cap, so it intentionally runs 3 requests. Any live model may return 429s under load; the matrix records the count and aborts a model's run early after 3 consecutive 429s rather than exhausting the cap against a rate limit. `--offline` alone only proves the router-level guarantee (zero hosted-client constructions); the packet-capture proof needs `--capture` and `sudo`. The probe owns the capture itself (start → run requests → stop → read back) rather than relying on a separately-started background tcpdump, and never reports a result it can't verify: a failed or unreadable capture is reported as `capture-failed`, never as silence.

## Environment

| Field | Value |
| --- | --- |
| Hardware | Apple M1 Pro |
| Memory | 17179869184 |
| OS | macOS 15.7.9 (24G830) |
| Bun | 1.4.2 |
| Tauri | 2.12.0 |
| Three.js | 0.185.1 |
| Three Flatland | 0.1.0-alpha.10 |
| zenScopeNoteModels | nemotron-3.5-lightning-free, muse-spark-1.3-contributor-free |
| goFreeModels | space-bunny-free, longcat-2.5-preview-free |
| goPaidModel | mimo-v2.5 |

## Results

| Metric | Unit | Samples | p50 | p95 |
| --- | --- | --- | --- | --- |
| zen-scope-note/nemotron-3.5-lightning-free latency | ms | 1 | 431.985041 | 431.985041 |
| zen-scope-note/muse-spark-1.3-contributor-free latency | ms | 1 | 335.76312499999995 | 335.76312499999995 |
| go-free/space-bunny-free latency | ms | 4 | 6772.472207999999 | 7137.838958 |
| go-free/longcat-2.5-preview-free latency | ms | 4 | 19128.571792000002 | 23071.828500000003 |
| go-paid/mimo-v2.5 latency | ms | 3 | 19407.704665999976 | 40635.52308299999 |

## Findings

- Zen auth.json key: `opencode`; Go auth.json key: `opencode-go` — the SAME credential (confirmed by direct comparison); this is not a key/subscription distinction.
- Zen `nemotron-3.5-lightning-free` (chat-completions, scope note only): 1 request(s), typed 403 `FreeTierError`: "OpenCode's free tier can only be used from within OpenCode".
- Zen `muse-spark-1.3-contributor-free` (responses, scope note only): 1 request(s), typed 403 `FreeTierError`: "OpenCode's free tier can only be used from within OpenCode".
- **Zen `zen/v1` free-tier gate (investigated separately, not re-run every time)**: every request to Zen's free models returns a typed 403 `FreeTierError` from a non-public inference service, regardless of headers (none / session-only / the full `x-opencode-session`, `x-opencode-project`, `x-opencode-request`, `x-opencode-client`, `User-Agent` set), endpoint (`/chat/completions` and `/responses`), or which auth.json entry sourced the credential — 23 requests, 23 `FreeTierError` 403s, zero exceptions. A follow-up check for a reported request-shape heuristic (anomalyco/opencode#50627: a `bash`-style tool in the `tools` array) did not reproduce here either (6/6 still 403, both a bash-only tool and a broader OpenCode-like tool set, with and without `x-opencode-client`). This is a scope note for ADR-0005, not a blocker: Zen's free tier is simply out of scope for direct third-party API access.
- Go free `space-bunny-free` (`/chat/completions` only — `/responses` returns `ModelProtocolUnsupported`): 4 requests, structured native=0 repaired=4 failed=0, tool call supported.
- Go free `longcat-2.5-preview-free` (`/chat/completions` only — `/responses` returns `ModelProtocolUnsupported`): 4 requests, structured native=0 repaired=4 failed=0, tool call supported.
- Go paid `mimo-v2.5`: 3 requests (capped given per-request Go billing), structured native=0 repaired=3 failed=0, tool call supported.
- Fallback trace (Go free → Go paid → local → routine-only; see fallback.ts's `DEFAULT_STEP_ORDER`): go-free:space-bunny-free(success, 1 attempt).
- Offline router guarantee: 0 hosted-client construction(s) across 20 offline-mode requests (must be 0).
- Packet capture: pending owner run — non-interactive sudo is unavailable on this machine; run `sudo -v` first to prime the sudo timestamp cache and re-run with --capture (or run the whole command under `sudo -E` — the -E preserves $HOME so auth.json still resolves — if timestamp caching isn't available/persistent here). Manual fallback: `sudo tcpdump -i any -w results/offline.pcap` (optionally alongside `log stream --predicate 'process == "mDNSResponder"'`), then re-run `bun run src/run.ts --offline --capture`.
- Contract repair parity across OpenAI/Anthropic fixture shapes: identical parsed action; no-valid-action fixtures fail identically: true.

## Bottom line

OpenCode Zen and OpenCode Go share one credential (the `opencode` and `opencode-go` auth.json entries hold the same key) — the earlier framing of this as a key/subscription difference was wrong. Zen's `zen/v1` base gates its free models with an unconditional 403 `FreeTierError` from a non-public service (measured across headers, endpoint, and key-source combinations, plus a #50627 tool-shape heuristic check that also didn't reproduce it) — a scope note for ADR-0005, not a blocker. Go's base (`zen/go/v1`) applies no such gate: its own free models (`space-bunny-free`, `longcat-2.5-preview-free`) are reachable with the same credential over `/chat/completions`, both repair to valid structured actions and support tool calls. For ADR-0005, the OpenCode arm is **Go**, with its free models first and the paid model (`mimo-v2.5`) as the fallback within Go. Offline mode's router-level guarantee held (zero hosted-client constructions), but the packet-capture proof has not completed yet — do not treat offline mode as proven silent until --offline --capture reports a captured result.