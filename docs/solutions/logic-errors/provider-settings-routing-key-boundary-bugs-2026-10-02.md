---
title: Provider settings broke at every boundary between the form, the Keychain, and the router
date: 2026-10-02
category: logic-errors
module: provider-matrix
problem_type: logic_error
component: assistant
symptoms:
  - A Zeus assignment saved from the settings view never routed, because roles were saved under display names
  - Offline launch still read hosted endpoint keys from the Keychain and sent them to the sidecar
  - A key reference with surrounding spaces was saved trimmed but stored in the Keychain untrimmed, so the endpoint failed `key-missing`
  - A key containing a quote, backslash or newline appeared in its JSON-escaped form past redaction
  - Loading and saving settings turned a role's explicit empty fallback into "inherit the global fallback"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [provider-settings, model-routing, keychain, offline-mode, credential-redaction, fallback-routing, p06, p07]
---

# Provider settings broke at every boundary between the form, the Keychain, and the router

## Problem

Provider settings (P06, P07) pass data across several boundaries: the React form, the saved `model-settings.json`, the macOS Keychain, the sidecar's stdin launch line, the router, and the trace store. Five bugs, all caught in PR review before merge, made settings look right while routing to the wrong place, reading hosted keys offline, or leaking a key in escaped form.

## Symptoms

1. **Role keys.** `apps/client/src/ui/settings.tsx` saved roles under `"Zeus"`/`"Hera"`. The router looks roles up by lowercase actor id (`turn.actorId` in `packages/agents/src/turn.ts`, `config.roles.get(role)` in `config.ts`), so the assignment was silently ignored.
2. **Offline key reads.** `apps/desktop/src-tauri/src/launch.rs` read every referenced key and sent it to the sidecar even when offline. The router dropped hosted endpoints only later, but the plan requires offline to drop them before any key read.
3. **Untrimmed key references.** Settings saved `keyRef.trim()`, but set, delete and status used the raw text. A key stored under `" openai "` was never found under `"openai"`.
4. **Escaped keys.** `createRedactor` in `packages/telemetry/src/trace.ts` replaced only the raw key. Callers redact `JSON.stringify(...)` output, where `"`, `\` and newlines are escaped, so those forms got through. The router's own failure-detail redaction (`packages/agents/src/router.ts`) had the same gap.
5. **Fallback states.** `settingsToForm` mapped both an omitted role `fallback` (inherit the global list) and `fallback: []` (no fallback) to the same empty field, and `formToSettings` dropped it. With a global fallback of `["hosted"]`, a load and save turned a local-only Zeus into `local → hosted`.

The tray's Restart also ran the key-reading spawn on the main thread, so a Keychain prompt could freeze the app. It is now handed off like `spawn_sidecar`.

## What Didn't Work

- Dropping hosted endpoints in the router alone: the shell had already read their keys.
- Using display labels as identifiers: readable in the UI, wrong for the consumer.
- Trimming only on save: the Keychain commands still saw the raw input.
- Redacting only the raw string: serialized output carries other forms.
- One empty text field for two persisted meanings.

## Solution

PR #84 (squash `b6f11ed`) and PR #85 (`64fa0bf`), each fix test-first:

1. **Ids, not labels.** Roles are `{ id: "zeus", label: "Zeus" }` and save by id. The test parses the saved JSON and checks `planRoute(config, "zeus")` routes to the assigned endpoint.
2. **Drop before read, at the read.** When offline, `launch.rs` reads keys only for endpoints whose `baseUrl` is local, mirroring `isLocalHost`/`isLocalUrl` in `packages/agents/src/config.ts`. Local means loopback, `localhost`, private LAN ranges, `fc00::/7`, `fe80::/10`, IPv4-mapped v6, and `*.local`; anything unparsable counts as hosted. A spy test shows the hosted key is never read offline and both are read online. A Rust table test runs the same host list as `config.test.ts`. It is a copy, so the two must change together.
3. **One normalizer.** The settings view runs every key reference through `normalizeKeyRef` before saving settings, before set, delete and status calls, and for row lookups. The Rust commands take the reference as given.
4. **Every serialized form.**

   ```ts
   for (const secret of secrets) {
     if (secret === "") continue;
     forms.add(secret);
     forms.add(JSON.stringify(secret).slice(1, -1));
   }
   ```

   Tests cover trace rows, router failure details, and a model answer echoing an escaped key, which is refused before the journal.
5. **Absent is not empty.** The role form carries `inheritFallback: boolean`. Saving omits `fallback` only when inheriting, and otherwise writes the list, even `[]`. Each role row has a "Use the global fallback" checkbox; PR #85 aligned it with its field, with window-cropped screenshots in `docs/evidence/provider-settings/role-fallback-*.png`.

## Why This Works

Each rule is now enforced where it can be broken. The id the UI saves is the id the router reads. The offline rule runs before the Keychain read, not after. A key reference is normalized once for every operation. Redaction covers the forms a key takes once serialized. And the form model has a state for each distinct persisted meaning. This keeps the credential invariant in AGENTS.md (no credential-bearing data in content, saves, prompts, telemetry, or logs) and P07's offline rule.

## Prevention

- At a persistence boundary, test through the consumer: parse what was saved and call the real lookup (`planRoute`), not just check the rendered label.
- Enforce "drop before read" where the read happens, even when a downstream layer also filters.
- Keep cross-language copies of one rule (here, locality) under one shared table of cases, and change both together.
- Send user-entered references through one named normalizer, and test every operation that takes one.
- Test redaction with a key containing `"`, `\` and a newline, on every sink: trace row, failure detail, journal.
- When the schema gives absent and empty different meanings, give the form model both states and test the round trip for each.

## Related Issues

- [PR #84: provider settings, endpoint keys in the Keychain, and an offline switch](https://github.com/marcusrbrown/panthea/pull/84)
- [PR #85: align role fallback controls with their field](https://github.com/marcusrbrown/panthea/pull/85)
- [Proving "offline mode sends nothing" needs a falsifiable packet capture](../test-failures/tcpdump-sudo-pid-resolution-offline-proof-2026-09-27.md): the probe-side half of the offline rule
- [Lifecycle state behind one lock](../best-practices/lifecycle-state-one-lock-transitions-2026-09-28.md): blocking work, such as a Keychain read during spawn, stays off the main thread
- [Check a hosted endpoint's usage policy and smoke-test it](../best-practices/hosted-endpoint-policy-and-smoke-test-2026-10-02.md)
