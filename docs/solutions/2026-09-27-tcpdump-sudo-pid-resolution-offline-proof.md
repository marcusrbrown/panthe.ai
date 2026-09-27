---
title: Proving "offline mode sends nothing" needs a self-owned, falsifiable packet capture
date: 2026-09-27
category: providers
requirement_ids: [P07]
tags: [tcpdump, sudo, offline, packet-capture, provider-matrix]
---

## Problem

D22 requires offline mode to make no network requests to hosted providers. "No hosted-client
constructed" (a router-level assertion) is necessary but not sufficient evidence — it doesn't rule
out some other code path opening a socket. A real proof needs a packet capture showing zero
provider-bound traffic, but a capture that never captures anything provable ("0 packets") is not
distinguishable from a capture that is simply blind (wrong interface, wrong filter, tcpdump never
actually started, privileges dropped before it attached).

## Method

`tools/probes/provider-matrix/src/run.ts --offline --capture` owns the whole capture window itself
— start `sudo tcpdump -i any` (all interfaces, including loopback/IPv6/utun/awdl, plus a filter for
every resolved provider IP and port 53) → run 20 offline-mode requests → stop tcpdump → read back
the pcap — rather than relying on a separately-started background `tcpdump` process that the probe
has to trust was actually running. Stopping it correctly required resolving `tcpdump`'s own child
pid (not the `sudo` wrapper's pid) so a `SIGINT` reaches the process that's actually holding the
capture handle, with a bounded grace period before a harder kill. Critically, the probe adds a
**positive control**: a second, identically-filtered capture around exactly one real (non-offline)
request to a live provider, which must show up as `not-silent` — proving the capture path can see
provider traffic at all before trusting a `silent` result from the offline window.

## Result

Offline capture: 0 packets observed, 0 matching a provider IP or DNS lookup — reported `silent`.
Positive control: 39 provider packets observed on the identical capture path — confirming the
`silent` verdict is real, not a blind capture. A failed or unreadable capture is reported as
`capture-failed`, never silently upgraded to `silent`.

## Decision

Any "we don't phone home" claim that depends on a packet capture must (1) own start/stop of the
capture process itself rather than trusting an externally-started one, (2) resolve the actual
capturing process's pid (not a wrapper's) to stop it cleanly, and (3) pair every "silent" verdict
with a positive control run through the identical capture path in the same invocation. See
[ADR-0005](../decisions/0005-model-providers.md) and
[tools/probes/provider-matrix/README.md](../../tools/probes/provider-matrix/README.md).

## Re-check

Re-run this whenever the offline guard's implementation moves from "probe router" to the actual
product's network layer (M1+) — the product-level offline guard is separate work from this probe's
router-level proof, and needs its own falsifiable capture with a positive control, not a reused
result from this probe.
