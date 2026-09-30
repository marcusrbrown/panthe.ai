---
title: Fro Bot cannot push a fix from a PR comment without a brokered-push anchor
date: 2026-09-29
category: integration-issues
module: workspace
problem_type: integration_issue
component: tooling
symptoms:
  - A PR comment asked Fro Bot to remove one file change, and Fro Bot committed the fix only in the runner workspace
  - The agent's own `git push` failed with `could not read Username`
  - The run log said `GitHub CLI credential withheld from child (affected trigger)`
  - A repeat mention updated the PR only after the brokered push created `chore: apply brokered changes`
root_cause: missing_workflow_step
resolution_type: config_change
severity: medium
tags: [fro-bot, brokered-push, issue-comment, github-actions, trusted-head-sha, credentials]
---

# Fro Bot cannot push a fix from a PR comment without a brokered-push anchor

## Problem

A PR comment can ask Fro Bot to edit a same-repository PR branch, but on affected triggers the agent never receives a GitHub credential. On PR #59 the agent made the requested local commit and then couldn't push it. The PR branch stayed unchanged until the workflow gave the action a trusted head SHA for its brokered push.

## Symptoms

- A comment on PR #59 asked Fro Bot to drop the `docs/product/traceability.md` change and keep the `server.ts` change.
- Run 36666534128 logged `GitHub CLI credential withheld from child (affected trigger)`.
- The agent committed the correction locally as `dad67f4`, then reported that `git push` failed because the runner had no GitHub credentials.
- After the fix, run 36668605167 still showed the agent's own push failing. The action then logged `chore: apply brokered changes` and created commit `84d17df787ef4843de0ab3914ffaba29323583af`.
- PR #59 merged with only `apps/simulation/src/server.ts` changed.

## What Didn't Work

1. **Treating it as a workflow permission problem.** The job already had `contents: write`, `issues: write` and `pull-requests: write` in `.github/workflows/fro-bot.yaml`.
2. **Changing `persist-credentials`.** The checkout must keep `persist-credentials: false`. A persisted checkout credential would hand the agent the token the action deliberately withholds.
3. **Changing `output-mode`.** `output-mode` controls delivery only for `schedule` and `workflow_dispatch` runs. A PR comment goes through the brokered push instead.
4. **Letting the agent push directly.** On `issue_comment`, `pull_request` and `issues` triggers, fro-bot/agent v0.117.0 withholds the GitHub CLI credential from the agent. That is what the `credential withheld` log line records.

## Solution

PR #63 changed `.github/workflows/fro-bot.yaml` so that a same-repository PR comment resolves the PR's head SHA before checkout and passes that SHA to the Fro Bot action.

```yaml
- name: Resolve same-repo PR head
  id: prehead
  env:
    GH_TOKEN: ${{ github.token }}
    REPO: ${{ github.repository }}
    IS_PR_COMMENT: ${{ github.event_name == 'issue_comment' && github.event.issue.pull_request != null }}
    PR_NUMBER: ${{ github.event.issue.number }}
  run: |
    set -euo pipefail
    sha=""
    if [ "${IS_PR_COMMENT}" = "true" ]; then
      pr_json="$(gh api "repos/${REPO}/pulls/${PR_NUMBER}")"
      if [ "$(printf '%s' "${pr_json}" | jq -r '.head.repo.full_name // empty')" = "${REPO}" ]; then
        sha="$(printf '%s' "${pr_json}" | jq -r '.head.sha // empty')"
      fi
    fi
    echo "sha=${sha}" >> "${GITHUB_OUTPUT}"
```

Checkout uses that SHA as its ref:

```yaml
- name: Checkout repository
  uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0
  with:
    fetch-depth: 0
    ref: ${{ steps.prehead.outputs.sha }}
    token: ${{ secrets.FRO_BOT_PAT }}
    persist-credentials: false
```

The same SHA goes to the action:

```yaml
- name: Run Fro Bot
  uses: fro-bot/agent@e6efc1f13ed05056cc9ba68d6f8fb5e71bed8ca6 # v0.117.0
  with:
    github-token: ${{ secrets.FRO_BOT_PAT }}
    trusted-head-sha: ${{ steps.prehead.outputs.sha }}
    brokered-push-extra-paths: apps,content,tools
```

`brokered-push-extra-paths: apps,content,tools` covers the repository's product directories. The action's default allowlist already has `src/`, `packages/*/src/`, `docs/`, `README.md`, `ARCHITECTURE.md` and `STRUCTURE.md`. The action still refuses protected paths such as `.github`, package manifests and lockfiles.

## Why This Works

The brokered push is the action's trusted write path for comment-driven edits. In fro-bot/agent v0.117.0, `src/features/delegated/brokered-push-gate.ts` admits an `issue_comment` only when the comment is on a pull request, the commenter is an owner, member or collaborator, and `trustedHeadSha` is present. Without that anchor the gate returns `Trusted head SHA anchor is missing`, and the push is skipped without an error.

With the anchor, the action does the following:
- checks out the exact head SHA;
- lets the agent make its edit locally without a credential;
- rebuilds the change against the trusted SHA;
- checks the changed paths against its allowlist;
- confirms the live PR head hasn't moved;
- writes the commit through the Git Data API.

The live proof is run 36668605167. The agent still had no credential and its own push still failed, but the brokered push delivered commit `84d17df` as `chore: apply brokered changes`. That commit removed only the traceability note, and PR #59 merged with only `apps/simulation/src/server.ts` in its file list.

## Prevention

- For a comment-driven fix, look for `Brokered push` or `chore: apply brokered changes` in the run log, not just the agent's final message.
- Check that the delivered commit's author is `fro-bot[bot]` and that the PR's file list matches the requested scope.
- Keep `persist-credentials: false`, so the agent never receives the token on affected triggers.
- If comment-driven edits stop landing, check whether `trusted-head-sha` resolved to an empty value before touching permissions.

## Related Issues

- [PR #59: chore(simulation): simplify trace-query ID guards](https://github.com/marcusrbrown/panthea/pull/59)
- [PR #63: ci(fro-bot): anchor brokered pushes so comment replies can update PR branches](https://github.com/marcusrbrown/panthea/pull/63)
- [fro-bot/agent brokered-push gate at v0.117.0](https://github.com/fro-bot/agent/blob/e6efc1f13ed05056cc9ba68d6f8fb5e71bed8ca6/src/features/delegated/brokered-push-gate.ts)
- [fro-bot/agent brokered-push validation at v0.117.0](https://github.com/fro-bot/agent/blob/e6efc1f13ed05056cc9ba68d6f8fb5e71bed8ca6/src/features/delegated/brokered-push-validation.ts)
