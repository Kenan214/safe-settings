# Feature 1: Scheduled normalization workflow (gh-aw)

This is a **template**, not a workflow that runs in the `safe-settings`
repository itself. Safe-settings is tooling — it doesn't have its own
`settings.yml`/`repos/*.yml`/`suborgs/*.yml` to normalize. Org admins install
this template into **their own admin repo** (the repo that stores their
org's safe-settings config), where it runs on a schedule against their real
configs.

The template lives at
[`docs/agentic/templates/consolidate-configs.md`](templates/consolidate-configs.md)
and is written for [GitHub Agentic Workflows](https://github.com/github/gh-aw)
(`gh-aw`) — see the [gh-aw docs](https://github.github.io/gh-aw/) for
background on the framework.

## What it does

On a weekly schedule (plus manual `workflow_dispatch`), the workflow:

1. Reads `settings.yml`, every file under `repos/`, and every file under
   `suborgs/` directly (the AI engine parses the raw YAML itself — there is
   **no separate deterministic parsing script** shipped with this template,
   by design, so the logic stays adaptable as safe-settings' config schema
   evolves).
2. Looks for two motivating patterns, generalized across **every** plugin
   type safe-settings supports (`repository`, `teams`, `collaborators`,
   `branches`, `rulesets`, `environments`, `variables`, `labels`,
   `autolinks`, `custom_properties`, `milestones`, `archive`, `overrides` —
   see [`lib/plugins`](../../lib/plugins)):
   - **Pattern A — repo/suborg duplication:** a `repos/<repo>.yml` file
     declares something already covered by the suborg (matched via
     `suborgrepos`/`suborgteams`/`suborgproperties`) that repo belongs to →
     recommend moving it into the suborg config and dropping the repo-level
     copy.
   - **Pattern B — cross-suborg duplication:** the same property/ruleset —
     identical in definition, regardless of what it's named — is repeated
     independently across multiple suborg configs → recommend promoting it
     once to the org-level `settings.yml`.
3. If (and only if) it finds a **safe, verified** consolidation opportunity,
   it opens a pull request via gh-aw's `safe-outputs: create-pull-request`,
   titled `[safe-settings consolidate] ...`, labeled `agentic-normalization`,
   as a draft, using the PR body template from
   [`../README.md`](README.md#3-pr-body-template). If it finds nothing (the
   common case on most runs), it opens no PR (`if-no-changes: ignore`).

## Safety: the zero-diff requirement

See [`docs/agentic/README.md`](README.md#1-safety-guardrail-zero-diff-requirement)
for the shared safety guardrail both agentic features follow. Concretely for
this workflow:

- Every proposed change must be **purely structural** — relocating or
  deduplicating a definition — and must **never** change the *effective,
  merged* settings safe-settings would apply to any repository.
- Because this workflow opens a real PR against your admin repo,
  safe-settings' own existing PR dry-run check (the `check_run` flow driven
  by `lib/plugins/diffable.js` and `index.js`) runs automatically on it, just
  like any other PR to the admin repo. **A correct consolidation PR must
  produce a zero-diff dry run.**
- The workflow's instructions explicitly tell the agent to reason through
  safe-settings' org → suborg → repo merge/precedence model (glob matching
  for `suborgrepos`, team-membership matching for `suborgteams`,
  custom-property matching for `suborgproperties` — see
  [`lib/settings.js`](../../lib/settings.js) and
  [`docs/status-checks.md`](../status-checks.md) for how these layers
  interact and inherit) before proposing anything, specifically checking
  that no other suborg/repo would gain or lose a setting as a side effect.
- **When you review one of these PRs, treat a non-empty dry-run diff as a
  sign the proposed consolidation is incorrect — do not merge it.** Always
  wait for the dry-run check to pass (zero-diff) before merging.

## Prerequisites

- The [`gh-aw`](https://github.com/github/gh-aw) GitHub CLI extension:
  `gh extension install github/gh-aw`.
- Your admin repo must be set up for `gh-aw` (`gh aw init`, if not already
  done) — this sets up the Actions workflow scaffolding gh-aw needs.
- Copilot engine auth. This template omits `engine:` since Copilot is
  gh-aw's default engine. It runs as GitHub Actions using your org/repo's
  Copilot access; see the
  [gh-aw engines reference](https://github.github.io/gh-aw/reference/engines/)
  for authentication details for your setup (personal Copilot access via a
  PAT/`COPILOT_GITHUB_TOKEN`, or centralized org Copilot billing with
  `permissions.copilot-requests: write` — the compiler will print a tip
  about this option if you haven't set it).
- Repo permissions: the workflow's agent job only needs `contents: read` (it
  reads YAML files already checked out into the workflow's own repo). The
  separate, permission-scoped `safe-outputs` job that gh-aw generates needs
  `contents: write` and `pull-requests: write` to push the branch and open
  the PR — this is handled automatically by the `create-pull-request` safe
  output; you don't need to add these permissions yourself.
- No extra secrets are required beyond what `gh aw init`/`gh aw compile`
  already wires up for the Copilot engine in your repo/org.

## Install steps

1. Install the `gh-aw` extension and initialize your admin repo, if you
   haven't already:

   ```bash
   gh extension install github/gh-aw
   cd /path/to/your-admin-repo
   gh aw init
   ```

2. Add this template to your admin repo's `.github/workflows/`. Either copy
   the raw file from this repo, or use `gh aw add` pointed at the raw file
   URL/path once this feature is merged, e.g.:

   ```bash
   gh aw add github-community-projects/safe-settings/docs/agentic/templates/consolidate-configs.md
   ```

   (If `gh aw add` can't resolve a docs-path source directly in your gh-aw
   version, just copy the file manually into
   `.github/workflows/consolidate-configs.md` in your admin repo.)

3. Compile it to generate the GitHub Actions lock file:

   ```bash
   gh aw compile consolidate-configs
   ```

4. Review the generated `.github/workflows/consolidate-configs.lock.yml`,
   commit both files, and push. The workflow will then run weekly plus
   whenever you trigger it manually via `workflow_dispatch` (`gh aw run
   consolidate-configs` or the Actions UI).

## Expected cadence

Weekly (`schedule: weekly` in gh-aw's fuzzy scheduling — the compiler
assigns a deterministic scattered day/time per workflow file path), plus
on-demand via `workflow_dispatch`. Adjust the `on.schedule` value in the
template if your org wants a different cadence (e.g. `daily` or an explicit
`cron:` entry) — see the
[gh-aw triggers reference](https://github.github.io/gh-aw/reference/triggers/#schedule)
for schedule syntax.

## Verifying the zero-diff expectation

When the workflow opens a consolidation PR:

1. Confirm safe-settings' existing PR dry-run check runs on it (it should,
   automatically, the same as any PR touching `settings.yml`/`repos/*.yml`/
   `suborgs/*.yml`).
2. Open the check's output/comment and confirm it reports **no additions,
   modifications, or deletions** to any repository's computed settings.
3. If the dry-run shows a diff, **do not merge** — close the PR (or comment
   explaining what's wrong) and treat it as a signal the agent's reasoning
   about suborg matching or merge precedence was incorrect for that case.
4. Only merge once the dry-run is confirmed zero-diff.

## Limitations / notes

- This template was validated by running `gh aw compile` /
  `gh aw validate` against it locally with the `gh-aw` CLI (`github/gh-aw`
  extension, installed via `gh extension install github/gh-aw`) — both
  commands succeeded with zero warnings. If your environment can't install
  the `gh-aw` CLI (e.g. restricted network egress), you can still install
  and use this template in your own admin repo, since the CLI is only needed
  locally to compile/validate; the compiled lock file is what actually runs
  in GitHub Actions.
- There is intentionally no bundled Node.js/JS parsing script for detecting
  duplication — the Copilot engine reads the raw YAML files directly in the
  agent job and reasons about patterns itself, per this feature's product
  decision. This keeps the logic adaptable to schema changes without
  requiring a code change to this template, at the cost of being
  probabilistic rather than deterministic — always verify the zero-diff dry
  run before merging any PR it opens, exactly as you would for a
  human-authored consolidation PR.
- This feature does not implement the `/safe-settings consolidate` PR
  comment-command — that's Feature 2 (`feature/copilot-sdk-pr-check`, an
  in-app addition to safe-settings itself). See
  [`docs/agentic/README.md`](README.md) for how the two features relate.
