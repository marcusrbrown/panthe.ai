# Solutions

Reusable engineering lessons captured through the Systematic compound workflow (`ce:compound`). Write an entry whenever a probe, a bug, or a design dead-end produces a lesson worth not re-deriving later.

## Frontmatter convention

Each entry is `docs/solutions/YYYY-MM-DD-slug.md` with YAML frontmatter:

```yaml
---
title: Short problem statement
date: YYYY-MM-DD
category: renderer | backend | sandbox | providers | telemetry | content | tooling
requirement_ids: [P02]
tags: [webgpu, wkwebview, macos]
---
```

Body sections: Problem, Method, Result, Decision (link the ADR or decision row if one exists), Re-check (how and when to redo the investigation, e.g., on a new OS version).

## Entries

| Date | Title | Requirement IDs |
| --- | --- | --- |
| [2026-09-26](2026-09-26-wkwebview-webgpu-unavailable-macos-15.md) | WKWebView does not expose WebGPU on macOS 15 | P02 |
