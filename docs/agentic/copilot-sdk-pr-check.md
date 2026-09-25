# Feature 2: PR-time consolidation check (Actions + Copilot SDK)

This document describes the PR-time, advisory consolidation check — Feature 2
of the agentic config normalization work described in
[`docs/agentic/README.md`](README.md). Read that doc first for the shared
conventions (dry-run acceptance gate, `agentic-normalization` label, PR body
template, comment-command spec) that this feature implements.

Unlike an earlier in-app design, this feature does **not** ship inside the
safe-settings Probot app. It is a plain GitHub Actions workflow template an
org admin installs into their **admin repo** (the repo holding
`settings.yml`, `repos/*.yml`, `suborgs/*.yml`):

- [`templates/agentic-consolidation-check.yml`](templates/agentic-consolidation-check.yml)
  → copy to `.github/workflows/agentic-consolidation-check.yml`
- [`templates/agentic-consolidation.js`](templates/agentic-consolidation.js)
  → copy to `.github/scripts/agentic-consolidation.js`

Two reasons for the Actions architecture:

1. **Headless auth without a PAT.** Inside Actions, the built-in
   `GITHUB_TOKEN` can carry the `copilot-requests: write` permission, which
   Copilot accepts for inference. Outside Actions there is no headless,
   PAT-free way to call Copilot: GitHub App installation tokens (what the
   safe-settings Probot app holds) are rejected by the Copilot backend.
2. **Speed.** This is a single-shot completion, not an agentic run. The
   changed files are already known from the PR, their contents are inlined
   into one prompt, all tools are disabled, and the model returns one JSON
   object. Runner spin-up aside, the whole job typically finishes in about a
   minute — compared to several minutes for a full gh-aw agentic workflow.

## What it does

**On every PR that touches config files** (`.github/settings.yml`,
`.github/repos/**`, `.github/suborgs/**`):

1. Checks out the PR merge ref and reads the changed config files from disk,
   plus the rest of the config set (org settings and suborgs first, within a
   character budget) as context — duplication is usually *across* files,
   e.g. a changed repo config versus an unchanged suborg config.
2. Makes one tool-less Copilot SDK call asking for "consolidation
   opportunities" — duplication that could be relocated to a higher scope
   (repo → suborg → org) without changing the effective merged settings —
   generalized across every safe-settings plugin type, and scoped to
   findings that involve at least one changed file.
3. Writes the findings to the job's step summary and posts/updates a single
   advisory PR comment — either describing each finding (pattern,
   before/after, why it's safe) or explicitly stating that nothing was
   found, so a clean result is visible on the PR and stale findings are
   cleared. The findings travel in a machine-readable marker in that
   comment. The job itself always succeeds — analysis errors are logged as
   warnings, never as a red ✗ on the PR.

**On a `/safe-settings consolidate` comment** (from an `OWNER`/`MEMBER`/
`COLLABORATOR` on a PR):

1. Reads the findings back from the marker in the advisory comment. If none
   are found, replies asking the user to push a commit to re-run analysis.
2. Makes a second tool-less SDK call to author the full updated file
   contents that remove the duplication.
3. Creates a branch from the source PR's head and opens a **stacked patch
   PR targeting the source PR's own branch**, labeled
   `agentic-normalization`, using the shared PR body template, and links it
   from the source PR.

The stacked patch PR means the bot never rewrites a branch that's meant to
merge to the default branch: the small consolidation diff is proposed *onto*
the source PR, and a human merges it. The acceptance gate is safe-settings'
own dry-run check (the App receives its webhooks regardless of the PR having
been created by `GITHUB_TOKEN`):

- Source PR still open → merging the patch PR folds the consolidation into
  the source PR, whose dry-run must be **unchanged** by that merge — the
  consolidation only relocates config; the intended change stays intact.
  The source PR then merges to the default branch as usual.
- Source PR already merged/closed → the patch PR targets the source PR's
  base branch instead and stands alone; as a pure consolidation of existing
  config, its dry-run must show **zero diff**.

## Requirements

- The organization has a **Copilot subscription with centralized billing
  enabled**. This is what lets the workflow's `GITHUB_TOKEN` carry
  `copilot-requests: write`; without it the inference call fails and there
  is no headless fallback (PATs are out of scope by design).
- The admin repo's config PRs come from **branches in the same repo** (the
  normal case for an admin repo). PRs from forks get a read-only token and
  the advisory step will be unable to comment.
- Nothing is required of the safe-settings App deployment itself: no new
  webhook events, no new permissions, no feature flags. The App is
  completely unchanged by this feature.

## Configuration

Environment variables on the workflow steps (all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONFIG_PATH` | `.github` | Where configs live in the admin repo; match your App deployment's `CONFIG_PATH`. |
| `SETTINGS_FILE_PATH` | `settings.yml` | Org settings file name; match your App deployment. |
| `COPILOT_MODEL` | Copilot CLI default | Model for both the analysis and authoring calls; leave unset unless you have a reason. On "model not available" errors the job log lists the models your billing plan offers. |
| `COPILOT_TIMEOUT_MS` | `240000` | Hard timeout on each SDK call. |
| `CONTEXT_BUDGET_CHARS` | `200000` | Cap on unchanged-config context included in the analysis prompt. |

## Safety

- **Advisory only, never blocking.** The advisory job exits 0 even when
  analysis fails (failures surface as workflow warnings and in the step
  summary). It posts at most one comment per PR, updating it in place on
  subsequent pushes. The consolidate job *is* allowed to fail visibly, since
  the user explicitly asked for it.
- **No self-triggering.** Comments and PRs created with `GITHUB_TOKEN` do
  not trigger workflows, so the advisory comment (which mentions the command
  phrase) cannot start the consolidate job, and the follow-up PR does not
  re-trigger the advisory. The comment command additionally requires
  `OWNER`/`MEMBER`/`COLLABORATOR` author association.
- **Prompt-injection containment.** Config file contents are untrusted input
  (any PR author controls them). Both SDK calls run with `availableTools: []`
  — the model cannot execute tools, touch the filesystem, or reach the
  network; it can only return text. Its output is parsed as JSON and only
  ever becomes PR content, which the dry-run gate and human review then
  check.
- **Stateless.** Findings live in the advisory comment's marker, so nothing
  is lost between the advisory and the command — there is no app state and
  no restart window.

## Trying it out

1. Copy the two template files into your admin repo as described above.
2. Open a PR against the admin repo that, e.g., adds a team to a
   `repos/<name>.yml` where the repo already matches a suborg's
   `suborgrepos` glob. The "Agentic Consolidation / advisory" job should
   post an advisory comment within about a minute of the run starting.
3. Comment `/safe-settings consolidate` on the PR. The "consolidate" job
   opens a stacked patch PR against your PR's branch and links it.
4. Merge the patch PR into your PR, confirm your PR's `Safe-setting
   validator` dry-run is unchanged, then merge your PR as usual.
