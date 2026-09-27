---
title: Sampling Ollama's real memory usage needs re-resolving the runner child pid every poll
date: 2026-09-27
category: providers
requirement_ids: [P04, P06]
tags: [ollama, rss, process-sampling, benchmarking]
---

## Problem

Measuring peak RSS for a locally-served model requires polling a process's resident memory over
time. `ollama serve`'s own pid is stable across a benchmark run, but it is a supervisor — the
process actually holding the model weights in memory is a separate `llama-server`-shaped runner
child that Ollama spawns per loaded model. Sampling the supervisor's own RSS undercounts
dramatically (mostly on-disk model size ends up reported instead, not resident memory) and a naive
"resolve the child pid once at startup" approach breaks the moment Ollama loads a different model
mid-run, since that spawns a **new** runner pid.

## Method

`servers.ts`'s RSS sampler takes `--rss-pid` as the `ollama serve` supervisor's own pid, then
re-resolves the actual runner child pid (`findOllamaRunnerPids`) on **every poll tick**, not once —
because a new pid appears each time a model loads. If the runner isn't the sampler's only child, or
is named differently across an Ollama version, the sampler sums the whole descendant process tree
rather than assuming a single well-known child.

## Result

Most rows in the inference-baseline results table for Ollama-served models carry a `†` marking them
as "disk size, a lower bound on resident memory, not a measured RSS peak" — the RSS-sampling bug was
caught and disclosed rather than silently reported as a real peak. The one clean measurement in the
same table (`llama3.2:3b` @ 4K, 2783 MiB) is the value that survived correct pid resolution and is
the number cited in [ADR-0005](../decisions/0005-model-providers.md).

## Decision

Never assume a locally-served model's supervisor pid is the pid actually holding the weights.
Resolve the real runner/child process, and re-resolve it on every sampling tick rather than once at
startup, for any local-inference-server RSS measurement (Ollama specifically, and any other
supervisor-plus-runner-child local server shape).

## Re-check

Re-verify `findOllamaRunnerPids`'s child-discovery logic against a new Ollama release before
trusting its RSS numbers — the runner's process name or parent/child relationship is not a
documented, stable contract, and a version bump could change it silently.
