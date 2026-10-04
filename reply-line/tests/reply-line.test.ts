import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { FsEntry, On, ProcessRunResult, SessionRateLimit } from 'claude-code'

const T0 = Date.UTC(2026, 9, 4, 12, 0, 0)
const M = 60_000
const H = 60 * M
const at = (ms: number) => new Date(T0 + ms).toISOString()
const INSTRUCTION = 'End your reply with the most recent [reply-line] status you were given, as its own last line, in italics, copied exactly.'

const PUSHED = '# branch.oid 1a2b\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n'
const WORK_LEFT = '# branch.oid 1a2b\n# branch.head feature\n# branch.upstream origin/feature\n# branch.ab +1 -0\n'
  + '1 .M N... 100644 100644 100644 aaa bbb src/App.jsx\n1 M. N... 100644 100644 100644 ccc ddd SMOKE.md\n? notes.txt\n'
const ran = (exitCode: number, stdout = ''): ProcessRunResult => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const dir = (name: string): FsEntry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
const fiveHour: SessionRateLimit[] = [{ kind: 'five_hour', percentUsed: 42, resetsAt: at(2 * H + 15 * M) }]

// The engine beneath the plugin: a session at 64% of its context and 42% of
// its 5-hour window, a working directory holding the repos given, tools that
// succeed unless their command says FAIL, and the context each prompt and
// each tool result carried.
function engine(on: On, repos: Record<string, { status: string }>, { usage = true } = {}) {
  mock.clock(on, { now: T0 })
  const promptContext: (readonly string[] | undefined)[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => (usage
    ? { value: { startedAt: T0, context: { tokens: 640_000, window: 1_000_000, percent: 64 }, rateLimits: fiveHour } }
    : { value: { startedAt: T0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('process.run', ($, e) => {
    const [, , where, command] = e.argv
    const repo = repos[where ?? '']
    if (command === 'rev-parse' || !repo) return { value: ran(128) }
    if (command === 'status') return { value: ran(0, repo.status) }
    return { value: ran(0, '0\n') }
  })
  on('fs.list', () => ({ value: Object.keys(repos).map(path => dir(path.split('/').pop() ?? path)) }))
  on('fs.exists', ($, e) => ({ value: Object.keys(repos).some(path => e.path === `${path}/.git`) }))
  on('prompt.submit', ($, e) => {
    promptContext.push(e.context)
    return { text: e.text }
  })
  on('tool.call', ($, e) => {
    const command = (e as { command?: unknown }).command
    return { result: 'ok', isError: typeof command === 'string' && command.includes('FAIL') } as never
  })
  return {
    promptContext,
    start: ($: Engine) => $.session.start({ cwd: '/home/user', surface: null, isInteractive: false }),
    prompt: ($: Engine, text = 'go on') => $.prompt.submit({ text, origin: { kind: 'bridge' }, wait: false }),
    call: async ($: Engine, tool: string, command?: string) =>
      (await $.tool.call({ tool, ...(command ? { command } : {}) } as never)).context,
  }
}

describe('with the prompt', () => {
  test('the instruction, and the line as the turn starts', async ($, on) => {
    const world = engine(on, { '/home/user/listenWell': { status: WORK_LEFT } })
    await world.start($)
    await world.prompt($)
    expect(world.promptContext[0]).toEqual([
      `${INSTRUCTION}\n[reply-line] ctx 64% · 5h 42% (resets 2h 15m) · listenWell: 3 uncommitted, 1 unpushed`,
    ])
  })

  test('nothing to say, nothing added', async ($, on) => {
    const world = engine(on, {}, { usage: false })
    await world.start($)
    await world.prompt($)
    expect(world.promptContext[0]).toBeUndefined()
  })
})

describe('after each tool call', () => {
  test('the line as of that call, with the turn\'s work counted by kind and failures noted', async ($, on) => {
    const repo = { status: WORK_LEFT }
    const world = engine(on, { '/home/user/listenWell': repo })
    await world.start($)
    await world.prompt($)
    await world.call($, 'Read')
    await world.call($, 'Read')
    repo.status = `${WORK_LEFT}? another.txt\n`
    await world.call($, 'Edit')
    const last = await world.call($, 'Bash', 'npm test FAIL')
    expect(last).toEqual(['[reply-line] ctx 64% · 5h 42% (resets 2h 15m) · listenWell: 4 uncommitted, 1 unpushed · this turn: 2 read, 1 edit, 1 test (1 failed)'])
  })

  test('a push shows at once, and the next prompt starts the count afresh', async ($, on) => {
    const repo = { status: WORK_LEFT }
    const world = engine(on, { '/home/user/listenWell': repo })
    await world.start($)
    await world.prompt($)
    repo.status = PUSHED
    expect(await world.call($, 'Bash', 'git push -u origin main')).toEqual(['[reply-line] ctx 64% · 5h 42% (resets 2h 15m) · listenWell: all pushed · this turn: 1 git'])
    await world.prompt($, 'next thing')
    expect(world.promptContext[1]?.[0]).toBe(`${INSTRUCTION}\n[reply-line] ctx 64% · 5h 42% (resets 2h 15m) · listenWell: all pushed`)
  })

  test('the usage figures follow the engine\'s measurements', async ($, on) => {
    const world = engine(on, {})
    await world.start($)
    await $.session.measure({ context: { tokens: 710_000, window: 1_000_000, percent: 71 }, rateLimits: [{ kind: 'five_hour', percentUsed: 88, resetsAt: at(40 * M) }], changed: ['context', 'rateLimits'] })
    expect(await world.call($, 'Grep')).toEqual(['[reply-line] ctx 71% · 5h 88% (resets 40m) · this turn: 1 find'])
  })
})
