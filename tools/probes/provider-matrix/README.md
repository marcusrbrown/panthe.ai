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

# --control adds a positive control: a SECOND, identically-filtered capture
# around exactly one real (non-offline) request to Go free space-bunny-free,
# which must show up as not-silent — otherwise a `silent` offline result isn't
# trustworthy (the capture path itself may just be blind to provider traffic):
bun run src/run.ts --offline --capture --control

# If sudo timestamp caching isn't available/persistent on this machine, run the
# whole command under sudo instead — -E preserves $HOME so auth.json still resolves:
# sudo -E bun run src/run.ts --offline --capture --control

# Optional advisory companion (not sudo-gated, run separately if wanted):
# log stream --predicate 'process == "mDNSResponder"' > results/offline-dns.log
```

## Caveat

Zen `zen/v1` free models are a scope note, not a tested arm — one request per model per run just reconfirms the 403 `FreeTierError` gate documented below is still in effect; see Findings for the full investigation (23 requests, 23 403s, across headers/endpoint/key-source combinations and a #50627 tool-shape follow-up). Go's free models (`space-bunny-free`, `longcat-2.5-preview-free`) aren't billed but are slow (longcat measured ~20s p50), so the live arm runs 2 requests each rather than the full 20-request cap. Go's paid model is billed per request against a $10/month subscription cap, so it intentionally runs 1 request. Any live model may return 429s under load; the matrix records the count and aborts a model's run early after 3 consecutive 429s rather than exhausting the cap against a rate limit. `--offline` alone only proves the router-level guarantee (zero hosted-client constructions); the packet-capture proof needs `--capture` and `sudo`. The probe owns the capture itself (start → run requests → stop → read back) rather than relying on a separately-started background tcpdump, and never reports a result it can't verify: a failed or unreadable capture is reported as `capture-failed`, never as silence.

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
| zen-scope-note/nemotron-3.5-lightning-free latency | ms | 1 | 1234.977333 | 1234.977333 |
| zen-scope-note/muse-spark-1.3-contributor-free latency | ms | 1 | 754.7065000000002 | 754.7065000000002 |
| go-free/space-bunny-free latency | ms | 2 | 5004.595499999999 | 6917.876625 |
| go-free/longcat-2.5-preview-free latency | ms | 2 | 20581.072665999996 | 34979.261916999996 |
| go-paid/mimo-v2.5 latency | ms | 1 | 49484.26037499998 | 49484.26037499998 |

## Findings

- Zen auth.json key: `opencode`; Go auth.json key: `opencode-go` — the SAME credential (confirmed by direct comparison); this is not a key/subscription distinction.
- Zen `nemotron-3.5-lightning-free` (chat-completions, scope note only) this run: 1/1 requests returned the typed 403 `FreeTierError` (e.g. "OpenCode's free tier can only be used from within OpenCode").
- Zen `muse-spark-1.3-contributor-free` (responses, scope note only) this run: 1/1 requests returned the typed 403 `FreeTierError` (e.g. "OpenCode's free tier can only be used from within OpenCode").
- Zen scope check, this run: 2/2 requests returned the typed 403 `FreeTierError`, consistent with it being gated.
- **Prior investigation** (recorded once in a dedicated sweep, not re-run on every `--live` invocation — see this PR's history for the full matrix): a sweep across headers (none / session-only / the full `x-opencode-session`, `x-opencode-project`, `x-opencode-request`, `x-opencode-client`, `User-Agent` set) × endpoint (`/chat/completions`, `/responses`) × key source (both auth.json entries) found 23/23 requests returned the same typed 403 `FreeTierError` from a non-public inference service. A follow-up check for a reported request-shape heuristic (anomalyco/opencode#50627: a `bash`-style tool in the `tools` array) did not reproduce it either (6/6 still 403). This is background context for the scope-check numbers above, not a claim about the current run.
- Go free `space-bunny-free` (`/chat/completions` only — `/responses` returns `ModelProtocolUnsupported`): 2 requests, structured native=0 repaired=2 failed=0, tool call supported.
- Go free `longcat-2.5-preview-free` (`/chat/completions` only — `/responses` returns `ModelProtocolUnsupported`): 2 requests, structured native=0 repaired=2 failed=0, tool call supported.
- Go paid `mimo-v2.5`: 1 request (capped given per-request Go billing), structured native=0 repaired=1 failed=0, tool call supported.
- Fallback trace (Go free → Go paid → local → routine-only; see fallback.ts's `DEFAULT_STEP_ORDER`): go-free:space-bunny-free(success, 1 attempt).
- Offline router guarantee: 0 hosted-client construction(s) across 20 offline-mode requests (must be 0) — for this probe's own fallback router; the product service's offline guard is M1 work.
- Packet capture: 0 packet(s) observed, 0 matching a provider IP or DNS lookup — silent.
- Capture stop diagnostics: resolved tcpdump pid(s) [40677], stop path `sigint-child`, grace 2000ms, tcpdump exit code 0, stderr tail: "tcpdump: data link type PKTAP
dropped privs to <USER>
tcpdump: listening on any, link-type PKTAP (Apple DLT_PKTAP), snapshot length 524288 bytes
0 packets captured
18 packets received by filter
0 packets dropped by kernel".
- Capture filter: `(host 172.65.90.21 or host 172.65.90.20 or host 172.65.90.23 or host 172.65.90.22 or host 162.159.140.245 or host 172.66.0.243 or host 160.79.104.10) or port 53` (resolved provider IPs: 172.65.90.21, 172.65.90.20, 172.65.90.23, 172.65.90.22, 162.159.140.245, 172.66.0.243, 160.79.104.10).
- Positive control: not-silent — 39 provider packet(s) (e.g. `1790506438.165005 IP <local-ip>.62891 > 172.65.90.21.443: Flags [S], seq 1657040332, win 65535, options [mss 1460,nop,wscale 6,nop,nop,TS val 53088307 ecr 0,sackOK,eol], length 0`), so the filter and capture path observe provider traffic.
- Contract repair parity across OpenAI/Anthropic fixture shapes: identical parsed action; no-valid-action fixtures fail identically: true.

## Bottom line

OpenCode Zen and OpenCode Go share one credential (the `opencode` and `opencode-go` auth.json entries hold the same key) — a key/subscription difference does not explain any gap between them. Zen's `zen/v1` free tier returned the typed 403 `FreeTierError` on 2/2 requests this run, consistent with the prior dedicated investigation (23/23 403s across headers/endpoint/key-source, plus a #50627 tool-shape check that also didn't reproduce it) — a scope note for ADR-0005, not a blocker. Go's base (`zen/go/v1`) applies no such gate: its own free models (`space-bunny-free`, `longcat-2.5-preview-free`) are reachable over `/chat/completions` and all produced a valid structured action this run, all supporting tool calls. For ADR-0005, the OpenCode arm is **Go**, with its free models first and the paid model (`mimo-v2.5`) as the fallback within Go. Offline mode was silent on the wire: zero packets matched a provider IP or DNS lookup during the capture window, and the positive control confirmed the capture path can see provider traffic.