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

Go usage is billed per request against a $10/month subscription cap, so the live Go arm intentionally runs 3 requests rather than the full 20-request cap used for the free Zen models. Zen free-tier models may return 429s under load; the matrix records the count and aborts a model's run early after 3 consecutive 429s rather than exhausting the cap against a rate limit. `--offline` alone only proves the router-level guarantee (zero hosted-client constructions); the packet-capture proof needs `--capture` and `sudo`. The probe owns the capture itself (start → run requests → stop → read back) rather than relying on a separately-started background tcpdump, and never reports a result it can't verify: a failed or unreadable capture is reported as `capture-failed`, never as silence.

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
| zenModels | nemotron-3.5-lightning-free, muse-spark-1.3-contributor-free |
| goModel | mimo-v2.5 |

## Results

| Metric | Unit | Samples | p50 | p95 |
| --- | --- | --- | --- | --- |
| zen/nemotron-3.5-lightning-free latency | ms | 2 | 318.2420830000001 | 1393.841834 |
| zen/muse-spark-1.3-contributor-free latency | ms | 2 | 316.9622089999998 | 340.902208 |
| go-bonus/mimo-v2.5 latency | ms | 3 | 40390.323958 | 41861.458708 |

## Findings

- Zen auth.json key: `opencode`; Go auth.json key: `opencode-go`.
- Zen `nemotron-3.5-lightning-free` (chat-completions): 2 requests, structured native=0 repaired=0 failed=2, tool call unsupported, 429s=0 (aborted early) — sample error: "OpenCode's free tier can only be used from within OpenCode".
- Zen `muse-spark-1.3-contributor-free` (responses): 2 requests, structured native=0 repaired=0 failed=2, tool call unsupported, 429s=0 (aborted early) — sample error: "OpenCode's free tier can only be used from within OpenCode".
- Go arm: skipped under the plan's "only if Zen succeeds" gate: at least one Zen free model run failed entirely.
- **Feasibility-conflict finding**: Zen's free-tier models reject direct third-party API access outright ("OpenCode's free tier can only be used from within OpenCode" — a permanent, documented client restriction, not a transient outage), so this unit's "only if Zen succeeds" Go gate is never met from this probe. As the concrete alternative, Go's own endpoint was verified independently (bonus check, outside the gate): `mimo-v2.5`, 3 requests, structured native=0 repaired=3 failed=0, tool call supported. Go required the documented `x-opencode-session` header (https://opencode.ai/docs/go/#where-can-i-use-it); Zen free models still reject the request with that header present.
- Fallback trace: zen(failed, 2 attempts) -> go(success, 1 attempt).
- Offline router guarantee: 0 hosted-client construction(s) across 20 offline-mode requests (must be 0).
- Packet capture: pending owner run — non-interactive sudo is unavailable on this machine; run `sudo -v` first to prime the sudo timestamp cache and re-run with --capture (or run the whole command under `sudo -E` — the -E preserves $HOME so auth.json still resolves — if timestamp caching isn't available/persistent here). Manual fallback: `sudo tcpdump -i any -w results/offline.pcap` (optionally alongside `log stream --predicate 'process == "mDNSResponder"'`), then re-run `bun run src/run.ts --offline --capture`.
- Contract repair parity across OpenAI/Anthropic fixture shapes: identical parsed action; no-valid-action fixtures fail identically: true.

## Bottom line

Zen's free-tier models cannot be exercised via direct third-party API access at all (measured: every request rejected with "OpenCode's free tier can only be used from within OpenCode", regardless of headers) — this is a hard capability conflict for ADR-0005's hosted section, not a flaky/rate-limited failure. Concrete alternative, measured in the same run: OpenCode Go's endpoint works over direct third-party API access once the documented `x-opencode-session` header is sent, so the fallback chain's Go arm is viable even though its free-tier Zen arm is not reachable this way. Offline mode's router-level guarantee held (zero hosted-client constructions), but the packet-capture proof has not completed yet — do not treat offline mode as proven silent until --offline --capture reports a captured result.