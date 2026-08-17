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
const MODEL = process.env.COPILOT_MODEL || 'gpt-5'
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
    session = await client.createSession({ model: MODEL, availableTools: [] })
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
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) {
    attempts.push(fenced[1].trim())
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
  if (file === path.posix.join(CONFIG_PATH, SETTINGS_FILE_PATH)) {
    return true
  }
  return (
    (file.startsWith(`${CONFIG_PATH}/repos/`) || file.startsWith(`${CONFIG_PATH}/suborgs/`)) &&
    /\.ya?ml$/.test(file)
  )
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

Respond with ONLY a JSON object (no prose, no markdown fences) matching:
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
If there are no consolidation opportunities, respond with {"findings": []}.`

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

function listPrComments () {
  return JSON.parse(gh('api', `repos/${REPO}/issues/${PR_NUMBER}/comments?per_page=100`))
}

function upsertAdvisoryComment (body) {
  const existing = listPrComments().find((c) => (c.body || '').includes(FINDINGS_MARKER))
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
  const changed = gh('api', `repos/${REPO}/pulls/${PR_NUMBER}/files?per_page=100`, '--paginate', '--jq', '.[].filename')
    .split('\n')
    .filter(Boolean)
    .filter(isConfigFile)

  if (changed.length === 0) {
    summary('No safe-settings config files changed; nothing to analyze.')
    return
  }

  const files = readWorkspaceFiles(changed)
  const prompt = `${ANALYSIS_INSTRUCTIONS}\n\nHere are the changed config files in this pull request:\n\n${renderFileBlock(files)}\n`
  const response = await runCopilotPrompt(prompt)
  const parsed = parseJsonFromResponse(response)
  if (!parsed || !Array.isArray(parsed.findings)) {
    warn('could not parse findings JSON from the model response')
    summary('Consolidation analysis ran but the model response could not be parsed; see the job log.')
    return
  }

  const findings = parsed.findings
  if (findings.length === 0) {
    summary(`Analyzed ${changed.length} changed config file(s); no consolidation opportunities found.`)
    return
  }

  const sections = findings.map(renderFinding).join('\n---\n')
  summary(`## ${findings.length} consolidation opportunit${findings.length === 1 ? 'y' : 'ies'} detected\n\n${sections}`)

  const marker = `${FINDINGS_MARKER}${Buffer.from(JSON.stringify(findings), 'utf8').toString('base64')} -->`
  const body = `#### :robot: Agentic config normalization: consolidation opportunities detected

${sections}

_This is advisory only — this job always succeeds and does not affect the safe-settings dry-run check._
_An owner, member, or collaborator can comment \`/safe-settings consolidate\` to open a follow-up PR proposing these changes._

${marker}`
  upsertAdvisoryComment(body)
}

async function consolidate () {
  const commentWithFindings = listPrComments()
    .reverse()
    .find((c) => (c.body || '').includes(FINDINGS_MARKER))

  if (!commentWithFindings) {
    postComment(`#### :robot: Agentic config normalization

No consolidation findings are recorded on this PR. Push a new commit (or
reopen the PR) so the advisory check runs, then try \`/safe-settings consolidate\` again.`)
    return
  }

  const encoded = commentWithFindings.body.split(FINDINGS_MARKER)[1].split('-->')[0].trim()
  const findings = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))

  const pr = JSON.parse(gh('api', `repos/${REPO}/pulls/${PR_NUMBER}`))
  const headSha = pr.head.sha
  const baseBranch = pr.base.ref

  // Supersede flow: branch from the source PR's head so the follow-up PR
  // carries the intended change plus the consolidation. See the docs for the
  // matching dry-run acceptance gate.
  git('fetch', 'origin', `pull/${PR_NUMBER}/head`)
  const branch = `agentic-normalization/consolidate-pr-${PR_NUMBER}-${RUN_ID}`
  git('checkout', '-b', branch, headSha)

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

  const prBody = `${bodySections.join('\n\n---\n\n')}

Supersedes #${PR_NUMBER}: this PR carries that PR's intended change expressed
at the consolidated scope. If #${PR_NUMBER} is still open, close it in favor
of this one.

_Opened automatically by safe-settings' agentic config normalization. Please
verify the dry-run check on this PR before merging (zero diff if #${PR_NUMBER}
was already merged; otherwise identical to #${PR_NUMBER}'s dry-run diff)._`

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
