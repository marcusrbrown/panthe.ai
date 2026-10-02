---
title: Check a hosted endpoint's usage policy and smoke-test it before a gate run
date: 2026-10-02
category: best-practices
module: provider-matrix
problem_type: tooling_decision
component: tooling
severity: medium
applies_when:
  - Choosing a hosted model endpoint for P07 evidence, a gate run, or a role assignment
  - Pointing the router or the M2 gate harness at a non-local OpenAI-compatible endpoint
  - Using an endpoint whose reasoning controls or JSON-schema handling pass through a proxy
tags: [opencode-go, hosted-provider, openai-compatible, keychain, reasoning-effort, structured-output, p07, m2-gate]
---

# Check a hosted endpoint's usage policy and smoke-test it before a gate run

## Context

P07 asks for optional hosted and mixed inference. ADR-0005 treats any OpenAI-compatible endpoint (base URL, model, optional key) as a provider, with OpenCode Go named as the easy hosted option. When the M2 gate needed a hosted run, two things surfaced:

- **OpenCode Go is not a general inference endpoint.** Its documentation ("Where can I use it?", <https://opencode.ai/docs/go/#where-can-i-use-it>) says Go is designed for OpenCode and other coding agents that send similar requests, and that traffic is monitored for abuse. Clients should send coding-agent traffic, their own user agent, and a stable `x-opencode-session`. A raw request without that header gets HTTP 400 `MissingSessionID`. Panthea's router already sends both headers (`packages/agents/src/providers.ts`), so the header is not the problem. The traffic is: god turns are game-agent requests, not coding-agent requests. Go is not used for gate runs or game turns, and the plan's manual run with a role pointed at Go stays open.
- **Reasoning controls differ per model behind the same proxy.** Through a self-hosted OpenAI-compatible proxy, `reasoning_effort: "none"` got HTTP 400 from a Claude-family model, because the proxy translates it to `thinking: disabled`, which that model rejects. The same model answered with schema-valid JSON when the field was omitted. `gpt-6-luna` accepted `"none"` and used 0 reasoning tokens; without it, it used 10 to 16. (Smoke results from 2026-10-02, three requests each; not committed as files.)

## Guidance

Before a hosted endpoint is used for anything beyond a one-off request, check three things.

1. **Policy fit.** Read the provider's usage terms. A subscription plan built for coding agents is not a general inference API, whatever its URL shape.
2. **Wire fit.** Send about three requests to the exact endpoint, model, and settings the run will use: the real response schema, and the reasoning setting both set and omitted. Record status, latency, reasoning tokens, and whether the content is schema-valid JSON.
3. **Credential hygiene.** The key stays in the Keychain. The gate harness reads it once and passes it only in the sidecar's stdin launch line, never in argv, the environment, logs, transcripts, or committed docs. Public docs name a private endpoint generically, never by hostname.

The gate harness on `main` runs only against local Ollama. Branch `feat/hosted-gate` (not yet merged) adds a hosted endpoint:

```sh
bun run --cwd tools/scenarios scenario:m2 --episodes=3 --episode-seconds=300 \
  --model=<model> --base-url=https://<host>/v1 --key-ref=<keyRef> --reasoning-effort=none
```

On that branch it reads the key with `security find-generic-password -s ai.panthe.desktop.endpoint-keys -a <keyRef> -w`, puts it only in the launch config's `keys`, and skips the Ollama model check for a non-local URL. Its tests assert that a sentinel key never appears in the model config, transcript settings, or rendered output.

## Why This Matters

- A provider that is technically compatible can still be wrong for Panthea. Using it out of policy risks the owner's account, and no amount of header work changes that.
- A full gate run takes about 17 minutes. A 400 on every request, or hidden reasoning that pushes latency past the 15-second timeout, wastes the run and reads as a model failure.
- Native versus repaired structured output depends on the provider. In the hosted run every answer was labelled "repaired" (0 native), even though a direct request returned clean JSON. The router uses that label for both extracted JSON and its plain-text fallback (`packages/agents/src/router.ts`). The likely cause is the endpoint rejecting strict JSON-schema mode, but that is unverified. It did not change which actions the model could choose.

## When to Apply

- Adding or switching a hosted endpoint in settings or in the gate harness.
- Setting `reasoningEffort` on an endpoint, or changing models behind the same proxy.
- Reading a hosted run's native/repaired counts or latency.

## Examples

Minimum smoke record before a gate run:

```text
endpoint path, model, 3+ requests
reasoning: set to "none" and omitted
status codes and exact error messages
latency per request, reasoning tokens
content schema-valid? native or needs repair?
policy: does the provider allow game-agent traffic?
```

## Related

- [ADR-0005: model providers](../../decisions/0005-model-providers.md): the provider model this refines
- [Proving "offline mode sends nothing" needs a falsifiable packet capture](../test-failures/tcpdump-sudo-pid-resolution-offline-proof-2026-09-27.md): the offline half of P07
- [Provider settings bugs at the key and routing boundaries](../logic-errors/provider-settings-routing-key-boundary-bugs-2026-10-02.md): how keys reach the sidecar
