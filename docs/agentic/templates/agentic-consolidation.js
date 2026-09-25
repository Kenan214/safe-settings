#!/usr/bin/env node
/**
 * PR-time agentic consolidation check for a safe-settings admin repo.
 * Feature 2 of the agentic config normalization work — see
 * docs/agentic/README.md and docs/agentic/copilot-sdk-pr-check.md in the
 * safe-settings repo for the design and shared conventions.
 *
 * Runs inside GitHub Actions (see agentic-consolidation-check.yml) in one of
 * two modes:
 *
 *   node agentic-consolidation.js advisory     analyze the PR's changed config
 *                                              files and post advisory findings
 *   node agentic-consolidation.js consolidate  open a follow-up PR from the
 *                                              findings recorded on the PR
 *
 * Both modes make a single tool-less Copilot SDK call (availableTools: []) —
 * config contents are untrusted PR input, so the model can only return text.
 * Auth is the workflow's GITHUB_TOKEN (exported as GH_TOKEN) carrying the
 * `copilot-requests: write` permission; no PAT is involved.
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CONFIG_PATH = process.env.CONFIG_PATH || '.github'
const SETTINGS_FILE_PATH = process.env.SETTINGS_FILE_PATH || 'settings.yml'
const MODEL = process.env.COPILOT_MODEL || ''
const TIMEOUT_MS = parseInt(process.env.COPILOT_TIMEOUT_MS || '240000', 10)
const REPO = process.env.GITHUB_REPOSITORY
const PR_NUMBER = process.env.PR_NUMBER
const RUN_ID = process.env.GITHUB_RUN_ID || `${Date.now()}`

const CONSOLIDATION_LABEL = 'agentic-normalization'
const FINDINGS_MARKER = '<!-- agentic-consolidation-findings:'

function run (cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts })
}

function gh (...args) {
  return run('gh', args)
}

function git (...args) {
  return run('git', args)
}

function summary (markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + '\n')
  }
}

function warn (message) {
  console.log(`::warning::${message}`)
}

/** One tool-less, single-shot Copilot SDK call; returns the response text. */
async function runCopilotPrompt (prompt) {
  const { CopilotClient } = require('@github/copilot-sdk')
  const client = new CopilotClient()
  await client.start()
  let session
  try {
    const config = { availableTools: [] }
    if (MODEL) {
      config.model = MODEL
    }
    try {
      session = await client.createSession(config)
    } catch (e) {
      try {
        const models = await client.listModels()
        warn(`available models: ${models.map((m) => m.id || m.name).join(', ')}`)
      } catch (listErr) {
        // listing models is best-effort diagnostics only
      }
      throw e
    }
    const reply = await session.sendAndWait({ prompt }, TIMEOUT_MS)
    return reply?.data?.content || ''
  } finally {
    try {
      if (session) {
        await session.disconnect()
      }
    } finally {
      await client.stop()
    }
  }
}

/** Extracts a JSON object from a model response, tolerating fences/prose. */
function parseJsonFromResponse (text) {
  if (!text) {
    return null
  }
  const attempts = [text.trim()]
  // The response may reason first and can contain multiple fenced blocks
  // (e.g. yaml snippets); the JSON answer is instructed to come last.
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
  for (const match of fenced.reverse()) {
    attempts.push(match[1].trim())
  }
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last > first) {
    attempts.push(text.slice(first, last + 1))
  }
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt)
    } catch (e) {
      // try the next candidate
    }
  }
  return null
}

function isConfigFile (file) {
  if (typeof file !== 'string') {
    return false
  }
  // Reject path traversal: model-authored paths must never escape the config
  // tree via `..` segments.
  if (file.split('/').includes('..')) {
    return false
  }
  if (file === path.posix.join(CONFIG_PATH, SETTINGS_FILE_PATH)) {
    return true
  }
  // Mirror the app's own matching rules (lib/settings.js REPO_PATTERN /
  // SUB_ORG_PATTERN): `<config>/repos/*.yml` and `<config>/suborgs/*.yml` —
  // `.yml` only, exactly one level deep. Anything else is never loaded by the
  // app, so the dry-run gate cannot vouch for changes to it.
  for (const dir of ['repos', 'suborgs']) {
    const prefix = `${CONFIG_PATH}/${dir}/`
    if (file.startsWith(prefix)) {
      const rest = file.slice(prefix.length)
      if (rest && !rest.includes('/') && rest.endsWith('.yml')) {
        return true
      }
    }
  }
  return false
}

/**
 * All config files in the checked-out workspace, ordered org settings ->
 * suborgs -> repos so the higher scopes survive the context budget first.
 */
function listAllConfigFiles () {
  const files = []
  const settings = path.posix.join(CONFIG_PATH, SETTINGS_FILE_PATH)
  if (fs.existsSync(settings)) {
    files.push(settings)
  }
  for (const dir of ['suborgs', 'repos']) {
    const full = path.posix.join(CONFIG_PATH, dir)
    if (fs.existsSync(full)) {
      for (const name of fs.readdirSync(full).sort()) {
        if (/\.ya?ml$/.test(name)) {
          files.push(path.posix.join(full, name))
        }
      }
    }
  }
  return files
}

function readWorkspaceFiles (paths) {
  return paths.map((p) => {
    let content = ''
    try {
      content = fs.readFileSync(p, 'utf8')
    } catch (e) {
      warn(`could not read ${p}: ${e.message}`)
    }
    return { path: p, content }
  })
}

function renderFileBlock (files) {
  return files.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n')
}

const ANALYSIS_INSTRUCTIONS = `You are reviewing a pull request against a "safe-settings" GitHub App admin
repository. safe-settings lets an org manage GitHub settings as code via an
org-level settings file, per-repo overrides in repos/*.yml, and grouped-repo
overrides in suborgs/*.yml (matched via suborgrepos/suborgteams/suborgproperties
globs). Plugin types include: teams, rulesets, branch protection, labels,
deployment environments, repository variables, collaborators, autolinks, and
custom properties.

Your job is ONLY to detect "consolidation opportunities": duplication that
could be relocated/deduplicated to a higher scope (repo -> suborg -> org)
WITHOUT changing the effective, merged settings applied to any repo. Two
motivating (non-exhaustive) examples:
1. A team is granted access directly in a repo config even though the repo
   already belongs to a suborg that could declare the team once.
2. The same ruleset (or other property), with identical rules/properties, is
   independently redefined under different names in multiple suborgs, and
   could instead be defined once at the org level.

Generalize this reasoning across ALL plugin types listed above.

You are given the files this pull request CHANGED, plus the repository's
other config files for context (duplication is usually across files, e.g. a
changed repo config versus an unchanged suborg config). Only report
opportunities that involve at least one CHANGED file — this check is scoped
to what this PR is introducing, not a full audit.

Work through this checklist for EVERY changed file before answering:
1. For a changed repos/<name>.yml: check every suborg config whose
   suborgrepos globs match <name>. Any team, ruleset, branch protection,
   label, environment, variable, collaborator, autolink, or custom property
   in the changed file that an applicable suborg (or the org settings file)
   already declares with the same effective value IS a finding.
2. For a changed suborgs/*.yml: check the org settings file the same way,
   and check sibling suborgs for identical definitions that could move to
   the org level.
3. For the changed org settings file: check whether it makes existing
   suborg/repo-level declarations redundant.

Reason step by step through the checklist first. Then end your response
with a fenced \`\`\`json code block containing ONLY a JSON object matching:
{
  "findings": [
    {
      "pattern": "short description of the duplication pattern",
      "description": "more detail on where it occurs",
      "scope": "teams|rulesets|branches|labels|environments|variables|collaborators|autolinks|custom_properties|other",
      "files": ["path/to/file.yml"],
      "before": "yaml snippet showing the duplicated/redundant config",
      "after": "yaml snippet showing the consolidated config",
      "whySafe": "why the effective/merged settings are unchanged"
    }
  ]
}
If there are no consolidation opportunities, end with {"findings": []}.`

const AUTHOR_INSTRUCTIONS = `You previously detected consolidation opportunities in a "safe-settings"
config repository (see findings below). Now produce the FULL, updated
contents of each affected file so the duplication is removed by relocating
the config to the appropriate higher scope (repo -> suborg -> org), WITHOUT
changing the effective/merged settings for any repo.

Respond with ONLY a JSON object (no prose, no markdown fences) matching:
{
  "title": "short PR title",
  "changes": [
    { "path": "path/to/file.yml", "content": "full new file content" }
  ]
}`

function renderFinding (f, i) {
  return `### ${i + 1}. ${f.pattern || 'Consolidation opportunity'}

${f.description || ''}

**Files:** ${(f.files || []).join(', ') || 'n/a'}

**Before:**
\`\`\`yaml
${f.before || ''}
\`\`\`

**After:**
\`\`\`yaml
${f.after || ''}
\`\`\`

**Why this is safe:** ${f.whySafe || ''}
`
}

// Comments posted by this workflow come from the Actions bot identity, so the
// findings marker is only trusted there — any commenter could otherwise forge
// a marker and steer the consolidate step.
const BOT_LOGIN = 'github-actions[bot]'

function isBotComment (c) {
  return !!c && !!c.user && c.user.login === BOT_LOGIN
}

function listPrComments () {
  return JSON.parse(gh('api', `repos/${REPO}/issues/${PR_NUMBER}/comments?per_page=100`, '--paginate'))
}

function upsertAdvisoryComment (body) {
  const existing = listPrComments().find((c) => isBotComment(c) && (c.body || '').includes(FINDINGS_MARKER))
  if (existing) {
    gh('api', '--method', 'PATCH', `repos/${REPO}/issues/comments/${existing.id}`, '-f', `body=${body}`)
  } else {
    gh('api', `repos/${REPO}/issues/${PR_NUMBER}/comments`, '-f', `body=${body}`)
  }
}

function postComment (body) {
  gh('api', `repos/${REPO}/issues/${PR_NUMBER}/comments`, '-f', `body=${body}`)
}

async function advisory () {
  // The files API can transiently return an empty list right after a PR is
  // reopened (GitHub recomputing PR state), even though the workflow's paths
  // filter just matched a config change — retry briefly before giving up.
  let changed = []
  for (let attempt = 1; attempt <= 3; attempt++) {
    changed = gh('api', `repos/${REPO}/pulls/${PR_NUMBER}/files?per_page=100`, '--paginate', '--jq', '.[].filename')
      .split('\n')
      .filter(Boolean)
      .filter(isConfigFile)
    if (changed.length > 0) {
      break
    }
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 5000))
    }
  }

  if (changed.length === 0) {
    warn('the PR reported no changed config files (after retries); skipping analysis')
    summary('No safe-settings config files changed; nothing to analyze.')
    return
  }

  const changedFiles = readWorkspaceFiles(changed)

  // Include the rest of the config set as context (higher scopes first),
  // within a character budget so huge admin repos still fit one prompt.
  const contextBudget = parseInt(process.env.CONTEXT_BUDGET_CHARS || '200000', 10)
  let used = 0
  const contextFiles = []
  for (const file of listAllConfigFiles()) {
    if (changed.includes(file)) {
      continue
    }
    const [entry] = readWorkspaceFiles([file])
    if (used + entry.content.length > contextBudget) {
      warn(`context budget reached; omitting ${file} and later files from the prompt`)
      break
    }
    used += entry.content.length
    contextFiles.push(entry)
  }

  const prompt = `${ANALYSIS_INSTRUCTIONS}

Here are the config files CHANGED by this pull request:

${renderFileBlock(changedFiles)}

Here are the repository's other (unchanged) config files, for context:

${renderFileBlock(contextFiles)}
`
  const response = await runCopilotPrompt(prompt)
  const parsed = parseJsonFromResponse(response)
  if (!parsed || !Array.isArray(parsed.findings)) {
    warn('could not parse findings JSON from the model response')
    summary('Consolidation analysis ran but the model response could not be parsed; see the job log.')
    return
  }

  const findings = parsed.findings
  console.log(`model returned ${findings.length} finding(s)`)
  if (findings.length === 0) {
    console.log(`model response (truncated): ${response.slice(0, 1000)}`)
  }
  const marker = `${FINDINGS_MARKER}${Buffer.from(JSON.stringify(findings), 'utf8').toString('base64')} -->`
  let headSha = ''
  try {
    headSha = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).pull_request.head.sha.slice(0, 7)
  } catch (e) {
    // sha in the comment is nice-to-have only
  }
  const analyzed = `Analyzed ${changed.length} changed config file(s)${headSha ? ` as of ${headSha}` : ''}`

  // Always upsert the one advisory comment — an explicit "nothing found"
  // state makes a clean result visible on the PR and clears any stale
  // findings so the consolidate command can't act on outdated analysis.
  if (findings.length === 0) {
    summary(`${analyzed}; no consolidation opportunities found.`)
    upsertAdvisoryComment(`#### :robot: Agentic config normalization

${analyzed}; no consolidation opportunities found.

${marker}`)
    return
  }

  const sections = findings.map(renderFinding).join('\n---\n')
  summary(`## ${findings.length} consolidation opportunit${findings.length === 1 ? 'y' : 'ies'} detected\n\n${sections}`)

  upsertAdvisoryComment(`#### :robot: Agentic config normalization: consolidation opportunities detected

${analyzed}.

${sections}

_This is advisory only — this job always succeeds and does not affect the safe-settings dry-run check._
_An owner, member, or collaborator can comment \`/safe-settings consolidate\` to open a follow-up PR proposing these changes._

${marker}`)
}

async function consolidate () {
  const commentWithFindings = listPrComments()
    .reverse()
    .find((c) => isBotComment(c) && (c.body || '').includes(FINDINGS_MARKER))

  if (!commentWithFindings) {
    postComment(`#### :robot: Agentic config normalization

No consolidation findings are recorded on this PR. Push a new commit (or
reopen the PR) so the advisory check runs, then try \`/safe-settings consolidate\` again.`)
    return
  }

  let findings
  try {
    const encoded = commentWithFindings.body.split(FINDINGS_MARKER)[1].split('-->')[0].trim()
    findings = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  } catch (e) {
    postComment(`#### :robot: Agentic config normalization

The consolidation findings recorded on this PR could not be read (the marker
is missing or corrupted: ${e.message}). Push a new commit (or reopen the PR)
so the advisory check re-runs, then try \`/safe-settings consolidate\` again.`)
    return
  }
  if (!Array.isArray(findings) || findings.length === 0) {
    postComment(`#### :robot: Agentic config normalization

The latest analysis found no consolidation opportunities on this PR, so
there is nothing to consolidate.`)
    return
  }

  const pr = JSON.parse(gh('api', `repos/${REPO}/pulls/${PR_NUMBER}`))
  const headSha = pr.head.sha

  if (pr.state !== 'open' && !pr.merged) {
    postComment(`#### :robot: Agentic config normalization

This PR was closed without merging, so its findings no longer apply to the
current config — there is nothing on \`${pr.base.ref}\` to consolidate
against. Nothing to do here.`)
    return
  }

  // Stacked "patch PR" flow: target the source PR's own branch, so a human
  // merges the consolidation into their PR — the bot never rewrites a branch
  // meant to merge to the default branch. If the source PR is already
  // merged, fall back to its base branch; the consolidation then stands
  // alone and must be zero-diff. See the docs for the acceptance gate.
  const stacked = pr.state === 'open'
  const baseBranch = stacked ? pr.head.ref : pr.base.ref
  const branch = `agentic-normalization/consolidate-pr-${PR_NUMBER}-${RUN_ID}`
  if (stacked) {
    git('fetch', 'origin', `pull/${PR_NUMBER}/head`)
    git('checkout', '-b', branch, headSha)
  } else {
    // The fallback targets pr.base.ref directly, so branch from its current
    // tip rather than the merged PR's headSha: under squash or rebase merge
    // strategies headSha is never an ancestor of the base branch, and
    // branching from it would carry the PR's entire original diff instead
    // of just this structural relocation. This also means the model sees
    // the base branch's current file contents, not the merged PR's old
    // snapshot.
    git('fetch', 'origin', pr.base.ref)
    git('checkout', '-b', branch, 'FETCH_HEAD')
  }

  const paths = [...new Set(findings.flatMap((f) => f.files || []))].filter(isConfigFile)
  const files = readWorkspaceFiles(paths)
  const prompt = `${AUTHOR_INSTRUCTIONS}\n\nFindings:\n${JSON.stringify(findings, null, 2)}\n\nCurrent file contents:\n\n${renderFileBlock(files)}\n`
  const response = await runCopilotPrompt(prompt)
  const authored = parseJsonFromResponse(response)
  if (!authored || !Array.isArray(authored.changes) || authored.changes.length === 0) {
    postComment('#### :robot: Agentic config normalization\n\nThe model did not produce usable consolidation changes; see the workflow run log.')
    throw new Error('model produced no usable changes')
  }

  for (const change of authored.changes) {
    if (!isConfigFile(change.path)) {
      throw new Error(`model proposed a change outside the config paths: ${change.path}`)
    }
    if (typeof change.content !== 'string' || change.content.length === 0) {
      throw new Error(`model proposed an empty change for: ${change.path}`)
    }
    fs.mkdirSync(path.dirname(change.path), { recursive: true })
    fs.writeFileSync(change.path, change.content)
    git('add', change.path)
  }

  git('config', 'user.name', 'github-actions[bot]')
  git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
  git('commit', '-m', `chore: consolidate safe-settings config (agentic normalization, from #${PR_NUMBER})`)
  git('push', 'origin', `HEAD:refs/heads/${branch}`)

  const bodySections = findings.map((f) => `## Consolidation opportunity

**Pattern detected:** ${f.pattern || ''}

**Before:**
\`\`\`yaml
${f.before || ''}
\`\`\`

**After:**
\`\`\`yaml
${f.after || ''}
\`\`\`

**Why this is safe:** ${f.whySafe || ''}`)

  const relation = stacked
    ? `Stacked on #${PR_NUMBER}: this PR targets that PR's branch (\`${baseBranch}\`).
Merging it folds the consolidation into #${PR_NUMBER}, whose own dry-run
check must be **unchanged** by this merge (the consolidation only relocates
config); #${PR_NUMBER} then merges to \`${pr.base.ref}\` as usual.`
    : `Follow-up to #${PR_NUMBER} (no longer open), targeting \`${baseBranch}\`.
As a pure consolidation of existing config, the dry-run check on this PR
must show **zero diff**.`

  const prBody = `${bodySections.join('\n\n---\n\n')}

${relation}

_Opened automatically by safe-settings' agentic config normalization. Please
verify the dry-run acceptance gate above before merging._`

  const bodyFile = path.join(os.tmpdir(), `agentic-consolidation-body-${RUN_ID}.md`)
  fs.writeFileSync(bodyFile, prBody)
  const title = authored.title || `Agentic consolidation: address findings from #${PR_NUMBER}`
  const prUrl = gh('pr', 'create', '--repo', REPO, '--base', baseBranch, '--head', branch, '--title', title, '--body-file', bodyFile).trim()

  try {
    gh('label', 'create', CONSOLIDATION_LABEL, '--repo', REPO, '--description', 'Opened by agentic config normalization', '--force')
    gh('pr', 'edit', prUrl, '--add-label', CONSOLIDATION_LABEL)
  } catch (e) {
    warn(`could not label the follow-up PR: ${e.message}`)
  }

  postComment(`#### :robot: Opened a follow-up consolidation PR: ${prUrl}`)
  summary(`Opened consolidation PR: ${prUrl}`)
}

async function main () {
  const mode = process.argv[2]
  if (!REPO || !PR_NUMBER) {
    throw new Error('GITHUB_REPOSITORY and PR_NUMBER must be set')
  }
  if (mode === 'advisory') {
    // Advisory must never fail the check on the PR: swallow errors as warnings.
    try {
      await advisory()
    } catch (e) {
      warn(`advisory analysis failed: ${e.message}`)
      summary(`Consolidation analysis failed: ${e.message}`)
    }
  } else if (mode === 'consolidate') {
    await consolidate()
  } else {
    throw new Error(`unknown mode: ${mode} (expected "advisory" or "consolidate")`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
