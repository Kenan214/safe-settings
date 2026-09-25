/* eslint-disable no-undef */
const template = require('../../docs/agentic/templates/agentic-consolidation.js')

const {
  isConfigFile,
  isBotComment,
  parseJsonFromResponse,
  encodeFindingsMarker,
  decodeFindingsMarker,
  FINDINGS_MARKER,
  BOT_LOGIN
} = template

describe('agentic consolidation template: isConfigFile', () => {
  it('accepts the files the app loads', () => {
    expect(isConfigFile('.github/settings.yml')).toBe(true)
    expect(isConfigFile('.github/repos/a.yml')).toBe(true)
    expect(isConfigFile('.github/suborgs/team.yml')).toBe(true)
  })

  it('rejects extensions and nesting the app ignores', () => {
    expect(isConfigFile('.github/repos/a.yaml')).toBe(false)
    expect(isConfigFile('.github/repos/nested/a.yml')).toBe(false)
    expect(isConfigFile('.github/workflows/ci.yml')).toBe(false)
    expect(isConfigFile('.github/repos/a.json')).toBe(false)
  })

  it('rejects path traversal', () => {
    expect(isConfigFile('.github/repos/../../.github/workflows/ci.yml')).toBe(false)
    expect(isConfigFile('.github/repos/..')).toBe(false)
  })

  it('rejects non-string input', () => {
    expect(isConfigFile(null)).toBe(false)
    expect(isConfigFile(undefined)).toBe(false)
  })

  it('honors a custom CONFIG_PATH', () => {
    const OLD = process.env.CONFIG_PATH
    jest.resetModules()
    process.env.CONFIG_PATH = 'config'
    try {
      const custom = require('../../docs/agentic/templates/agentic-consolidation.js')
      expect(custom.isConfigFile('config/repos/a.yml')).toBe(true)
      expect(custom.isConfigFile('.github/repos/a.yml')).toBe(false)
    } finally {
      if (OLD === undefined) {
        delete process.env.CONFIG_PATH
      } else {
        process.env.CONFIG_PATH = OLD
      }
      jest.resetModules()
    }
  })
})

describe('agentic consolidation template: findings marker', () => {
  it('round-trips findings through encode/decode', () => {
    const findings = [{ pattern: 'p', files: ['.github/repos/a.yml'] }]
    const body = `header\n${encodeFindingsMarker(findings)}\nfooter`
    expect(decodeFindingsMarker(body)).toEqual(findings)
  })

  it('throws on a missing or corrupt marker', () => {
    expect(() => decodeFindingsMarker('no marker here')).toThrow()
    expect(() => decodeFindingsMarker(`${FINDINGS_MARKER}!!! -->`)).toThrow()
  })

  it('trusts the marker in bot comments only', () => {
    expect(isBotComment({ user: { login: BOT_LOGIN }, body: 'x' })).toBe(true)
    expect(isBotComment({ user: { login: 'attacker' }, body: 'x' })).toBe(false)
    expect(isBotComment({ body: 'x' })).toBe(false)
    expect(BOT_LOGIN).toBe('github-actions[bot]')
  })
})

describe('agentic consolidation template: parseJsonFromResponse', () => {
  it('parses plain JSON', () => {
    expect(parseJsonFromResponse('{"findings": []}')).toEqual({ findings: [] })
  })

  it('prefers the trailing JSON block after reasoning and snippets', () => {
    const response = `Reasoning through the checklist...
\`\`\`yaml
repos/a.yml: {}
\`\`\`
\`\`\`json
{"findings": [{"pattern": "dup"}]}
\`\`\``
    expect(parseJsonFromResponse(response)).toEqual({ findings: [{ pattern: 'dup' }] })
  })

  it('returns null when nothing parses', () => {
    expect(parseJsonFromResponse('')).toBeNull()
    expect(parseJsonFromResponse('no json here')).toBeNull()
  })
})
