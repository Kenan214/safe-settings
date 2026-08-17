# Agentic Config Normalization

This area documents an agentic addition to safe-settings aimed at helping
organizations **consolidate and normalize** duplication across their
`settings.yml`, `repos/*.yml`, and `suborgs/*.yml` configs.

Two example patterns motivate this work:

1. A team is granted access directly in a **repo** config, even though the
   repo already belongs to a **suborg** (via `suborgrepos`/`suborgteams`/
   `suborgproperties`) that could just declare the team once, at the suborg
   level.
2. The same **ruleset** (or other property) — with identical rules/properties
   — is independently defined, under different names, in multiple suborgs. It
   could instead be defined once at the **org** level and inherited by every
   suborg/repo.

Both patterns generalize: the same kind of duplication can occur for any
pluggable property safe-settings supports — teams, rulesets, branch
protection, labels, deployment environments, repository variables,
collaborators, autolinks, and custom properties (see
[`lib/plugins`](../../lib/plugins)).

This work ships as two independently-scoped features. Both are **templates an
org admin installs into their own admin repo** (safe-settings itself is
tooling, not a specific org's admin repo), and both run headless on the
GitHub Actions built-in `GITHUB_TOKEN` — no PAT is required or supported.

| Feature | What it does | Where it lives |
| --- | --- | --- |
| 1. Scheduled normalization workflow | A [GitHub Agentic Workflow](https://github.com/github/gh-aw) (`gh-aw`), run on a schedule, that scans an admin repo's configs, detects consolidation opportunities across **all** plugin types, and opens a PR proposing the change. Full agentic run — good for deep, out-of-band scans where runtime doesn't matter. | Template + docs an org admin installs into their admin repo. |
| 2. PR-time consolidation check | A plain GitHub Actions workflow that uses the [Copilot SDK](https://www.npmjs.com/package/@github/copilot-sdk) for a **single-shot** analysis of the config files a PR changes, posts advisory findings, and opens a follow-up consolidation PR on demand via a `/safe-settings consolidate` comment. Deliberately *not* a gh-aw agentic run — no tools, one model call, so it completes in about a minute. See [`copilot-sdk-pr-check.md`](copilot-sdk-pr-check.md). | Template + docs an org admin installs into their admin repo: [`templates/agentic-consolidation-check.yml`](templates/agentic-consolidation-check.yml) and [`templates/agentic-consolidation.js`](templates/agentic-consolidation.js). |

## Why two features instead of one

- Feature 1 runs **out-of-band**, proactively, across the *entire* set of
  configs on a schedule — good for catching drift that accumulates over time
  regardless of any single PR. It uses the full agentic loop (tools, repo
  exploration) because breadth matters more than speed there.
- Feature 2 runs **in-band**, at PR time, scoped to *only* what a given PR is
  changing — good for catching new duplication as it's introduced, with a
  human in the loop who can opt in to acting on it immediately via a comment.
  It is optimized for speed: the changed files are already known, so it makes
  a single tool-less model call instead of an agentic run.

They intentionally do not share a code library so each can be reviewed,
shipped, and rolled back independently. They do share the conventions below
so their behavior and output feel like one coherent feature to end users.

## Shared conventions

Both features MUST follow these conventions:

### 1. Headless auth via the Actions token — no PATs

Both features run inside GitHub Actions and authenticate Copilot with the
workflow's built-in `GITHUB_TOKEN` by declaring `copilot-requests: write` in
the workflow `permissions:` block. This requires the organization to have a
Copilot subscription with centralized billing enabled. Personal access
tokens are explicitly out of scope: GitHub App installation tokens are not
accepted by Copilot, and PATs create a credential-lifecycle burden this
design avoids.

### 2. Safety guardrail: the dry-run acceptance gate

Any consolidation PR either feature opens must be **structural only** —
relocating or deduplicating configuration, never changing the *effective*,
merged settings applied to any repo, beyond the change the triggering PR
already intended. Because these are real PRs against an admin repo, the
existing safe-settings dry-run check (`Safe-setting validator`, via
[`lib/plugins/diffable.js`](../../lib/plugins/diffable.js)) runs on them
automatically and is the acceptance gate:

- **Post-merge consolidation** (Feature 1, or Feature 2 on a merged PR): the
  dry-run on the consolidation PR must show **zero diff** — the config is
  already applied, so a pure relocation changes nothing.
- **Stacked patch flow** (Feature 2 on an open PR): the consolidation PR
  targets the *source PR's branch*, so a human merges the small
  consolidation diff into their own PR — a bot never rewrites a branch
  that's meant to merge to the default branch. The source PR's dry-run must
  be **unchanged** by that merge: the consolidation only relocates config,
  leaving the effective changes the source PR proposed intact.

Reviewers should treat any unexplained dry-run diff on one of these PRs as a
sign the proposed consolidation was incorrect.

### 3. Model calls are tool-less where possible

Feature 2's model calls MUST disable all tools (`availableTools: []`): the
inputs are inlined into the prompt and the output is JSON, so the model has
no reason to touch the filesystem, network, or shell. This is both the speed
optimization and the prompt-injection containment: config files are authored
by PR submitters and are untrusted input to the model.

### 4. Labeling

PRs and issues opened by either feature should be labeled
`agentic-normalization` so they're easy to filter/audit across an org, in
addition to any repo-specific labels already in use.

### 5. PR body template

Proposed consolidation PRs should use this structure in the PR body:

```markdown
## Consolidation opportunity

**Pattern detected:** <short description, e.g. "team X duplicated across repo and suborg configs">

**Before:**
<snippet(s) of the duplicated/redundant config>

**After:**
<snippet(s) of the consolidated config>

**Why this is safe:** Explains why the effective/merged settings are
unchanged (see the dry-run acceptance gate above).

_Opened automatically by safe-settings' agentic config normalization. Please
verify the dry-run check on this PR before merging (zero diff for a
post-merge consolidation; identical to the source PR's diff for a supersede)._
```

### 6. Comment-command spec

Feature 2 listens for the exact lowercase phrase `/safe-settings consolidate`
in a PR comment (it may appear anywhere in the comment body) to trigger
opening a follow-up consolidation PR for previously-reported findings on
that PR. Only comments from users whose author association is `OWNER`,
`MEMBER`, or `COLLABORATOR` are honored. No other comment commands are
defined by this work.

### 7. Findings travel in the advisory comment

Feature 2 is stateless: the advisory step embeds its findings as
base64-encoded JSON inside an HTML comment marker
(`<!-- agentic-consolidation-findings:<base64> -->`) in the PR comment it
posts. The comment command reads the findings back from that marker, so no
server-side state survives between the two steps and nothing is lost to
restarts.

## Branch / PR stack

```text
main-enterprise
 └─ kenan214/agentic-config-normalization        (design + Feature 2)
     └─ feature/gh-aw-scheduled-normalization     (Feature 1)
```

- Feature 1: `docs/agentic/scheduled-normalization-workflow.md` (added on
  `feature/gh-aw-scheduled-normalization`)
- Feature 2: [`docs/agentic/copilot-sdk-pr-check.md`](copilot-sdk-pr-check.md)
