---
description: "Weekly scan of settings.yml, repos/*.yml, and suborgs/*.yml for safe-settings structural config consolidation opportunities"
labels: ["safe-settings", "config-normalization"]
on:
  schedule: weekly
  workflow_dispatch:
permissions:
  contents: read
  # Recommended Copilot auth: mint inference tokens from the built-in Actions
  # token instead of requiring a COPILOT_GITHUB_TOKEN PAT secret. Requires
  # your org to have centralized Copilot billing enabled — see
  # https://github.github.io/gh-aw/reference/auth/#copilot-requests-write-permission
  copilot-requests: write
# Explicit least-privilege network policy: this workflow only reads local
# YAML files and never needs outbound network access beyond gh-aw/GitHub's
# own basic infrastructure domains.
network: defaults
tools:
  bash: ["find", "cat", "ls", "grep", "wc", "sort", "uniq", "head", "tail", "yq", "echo", "printf"]
  # Required for the agent to actually relocate/dedupe YAML content — bash
  # alone only covers read-only inspection commands above.
  edit:
safe-outputs:
  create-pull-request:
    title-prefix: "[safe-settings consolidate] "
    labels: ["agentic-normalization"]
    draft: true # gh-aw enforces draft PRs for create-pull-request regardless; set explicitly for clarity
    if-no-changes: ignore # most runs will find nothing to consolidate — don't open empty/noisy PRs
  missing-tool: # let the agent report gracefully if it needs a capability it wasn't granted
  noop: # let the agent explicitly no-op (with a reason) when there's nothing safe to consolidate
timeout-minutes: 20
---

# Safe-settings config consolidation scan

You are auditing a **safe-settings admin repository** — the repo that stores
an organization's GitHub configuration as code, read and applied by the
[safe-settings](https://github.com/github-community-projects/safe-settings)
Probot app. This repo has (some subset of):

- `settings.yml` — org-wide defaults, applied to every repo in the org.
- `repos/*.yml` — one file per repo, named `<repo-name>.yml` (or `.yaml`),
  containing repo-specific overrides layered on top of org/suborg config.
- `suborgs/*.yml` — one file per "sub-org" grouping of repos. A suborg file
  matches repos via **exactly one** of:
  - `suborgrepos:` — a list of repo name glob patterns (e.g. `test*`).
  - `suborgteams:` — a list of team slugs; every repo that team has access to
    is a member of the suborg.
  - `suborgproperties:` — a list of custom-property key/value matchers (e.g.
    `- EDP: true`); every repo whose custom properties satisfy the matcher is
    a member of the suborg.

  The rest of a suborg file's keys are the same plugin sections as
  `settings.yml` (see below) and apply only to the suborg's matched repos.

Every one of these files, at every level, can declare the same kind of
plugin sections, e.g.:

- `repository:` — repo metadata/visibility/branch/merge settings
- `teams:` — team → permission grants
- `collaborators:` — individual user → permission grants
- `branches:` — branch protection rules
- `rulesets:` — repository rulesets
- `environments:` — deployment environments (with their own protection rules
  and variables/secrets references)
- `variables:` — repository-level Actions variables
- `labels:` — issue/PR labels
- `autolinks:` — autolink references
- `custom_properties:` — custom property values
- `milestones:`, `archive:`, `overrides:` — see the plugin implementations
  under `lib/plugins/` in the safe-settings repo for full semantics if you
  need to double check a corner case.

**Merge/precedence model** (this is the part you must get exactly right):
for any given repo, the *effective* settings are computed by deep-merging, in
this order, each layer on top of the previous — **org (`settings.yml`) →
matching suborg (`suborgs/*.yml`) → repo override (`repos/<repo>.yml`)** —
with later layers overriding/extending earlier ones. Object keys are merged
recursively; array items that represent named entities (teams, rules,
variables, etc. — matched by fields like `name`, `username`, `login`, or
`context`) are merged/replaced by that identity, not wholesale-replaced by
array position. A repo can only belong to **one** suborg at a time (safe-settings
treats this as a conflict otherwise) — always confirm which single suborg (if
any) actually matches a given repo, by glob/team-membership/property-matching,
before proposing to move anything into or out of a suborg file.

## Your task

Read `settings.yml`, every file under `repos/`, and every file under
`suborgs/` in this repository. Look for exactly two kinds of duplication,
generalized across **every** plugin section listed above (not just teams and
rulesets):

### Pattern A — repo-level config that duplicates its suborg

A `repos/<repo>.yml` file declares a plugin-section entry (a team grant, a
label, a ruleset, an environment, a variable, a collaborator, an autolink, a
custom property, etc.) that is **identical** to an entry already declared in
the `suborgs/*.yml` file whose `suborgrepos`/`suborgteams`/`suborgproperties`
match that same repo. Since the suborg config already applies to this repo,
the repo-level copy is redundant — moving it out of `repos/<repo>.yml`
(or deleting it if it's a pure duplicate with nothing else needed at repo
level) has no effect on the repo's effective settings.

**Before you propose this**, verify:

1. The suborg's matcher (`suborgrepos` glob, `suborgteams` membership, or
   `suborgproperties`) genuinely matches this repo — don't assume from the
   file name alone.
2. No *other* suborg also matches this repo with a conflicting definition.
3. The repo-level entry is truly identical to the suborg's (same keys/values,
   not just superficially similar) — a partial override is not safe to
   remove.

### Pattern B — the same config repeated identically across suborgs

The same plugin-section entry — **identical in its definition, regardless of
what it's named** — appears independently in two or more `suborgs/*.yml`
files. For example, two suborgs each define their own ruleset requiring the
same status checks and merge strategy, or two suborgs each grant the same
team the same permission. Since it's identical everywhere, it can be promoted
once to `settings.yml` at the org level and inherited by every suborg/repo
instead of being maintained redundantly in multiple places.

**Before you propose this**, verify:

1. The definitions are actually identical (not just similar-looking) across
   every suborg where you found them.
2. No suborg or repo that *doesn't* already have this definition would
   suddenly gain it once it's promoted to org level (i.e. it wouldn't
   introduce the setting for repos that don't currently have it — check
   whether any repos are excluded from every suborg that currently has this
   definition; if such repos exist, promoting to org level would change
   their effective settings, which is **not safe**).
3. No suborg overrides the same section with a *conflicting* value — if
   even one does, promoting to org level would change that suborg's
   effective result, which is **not safe**.

## Safety requirement — read this carefully

**Any change you propose must be purely structural**: relocating or
deduplicating a definition between files, never altering what safe-settings
would actually apply to any repository. Do not propose a change unless you
have reasoned through the merge/precedence model above and are confident the
*effective, merged* configuration for every affected repo is byte-for-byte
equivalent before and after your change.

This repository's safe-settings app already runs a pull-request dry-run
check (a `check_run` driven by the diff logic in `lib/plugins/diffable.js`
and `index.js`, in the safe-settings source) on every PR that touches these
config files. A correct consolidation PR **must** produce a **zero-diff**
dry run — no additions, modifications, or deletions to any repo's computed
settings. If you're not confident a proposed move is zero-diff, do not
propose it. It is always safe to find nothing and open no PR.

Only consider one plugin-section entry (or a small, closely related group of
entries) per PR — do not bundle multiple unrelated consolidation
opportunities into a single PR; if you find several, open one PR per
opportunity (up to the configured max) so each can be reviewed and verified
independently.

## Opening the PR

If you find at least one safe, verified consolidation opportunity, make the
minimal file edits (moving/deduplicating YAML — do not reformat or reorder
unrelated content) and open a pull request.

If you find nothing to consolidate this run (the common case), **do not**
silently end the run — call the `noop` tool with a brief explanation of what
you checked (e.g. "scanned N repo overrides and M suborgs; no duplicated or
relocatable entries found"). This keeps a visible, auditable record of every
run, not just the ones that produced a PR.

If you're missing information or a capability you'd need to safely evaluate
a potential opportunity (for example, a config file you can't parse, or a
matcher you can't resolve with the tools available), call `missing-tool`
explaining what you needed instead of guessing.

The PR body **must** follow this structure:

```markdown
## Consolidation opportunity

**Pattern detected:** <short description, e.g. "team X duplicated across repo and suborg configs">

**Before:**
<snippet(s) of the duplicated/redundant config>

**After:**
<snippet(s) of the consolidated config>

**Why this is safe:** Explains why the effective/merged settings are
unchanged (zero-diff) — e.g. "Repo already matches suborg's `suborgrepos`
pattern, so moving the team declaration into the suborg config produces an
identical merged result."

_Opened automatically by safe-settings' agentic config normalization. Please
verify the dry-run check below shows no diff before merging._
```

Fill in the real pattern, before/after YAML snippets, and safety reasoning —
do not leave the placeholders unfilled. Mention which repos/suborgs are
affected so a human reviewer can double check your matcher reasoning quickly.

## Permission boundary (important)

This workflow must never approve, merge, or self-review any pull request —
including PRs it creates itself or PRs created by other agentic workflows. It
has no write access to pull request reviews. Do not attempt to call
`gh pr review`, approve reviews via the GitHub API, or merge pull requests
under any circumstances. Your job ends at opening a draft PR for a human (and
safe-settings' own dry-run check) to review.
