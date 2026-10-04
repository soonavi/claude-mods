import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, FoundElement } from 'claude-code/testing'
import type { On } from 'claude-code'

const T0 = Date.UTC(2026, 9, 4, 12, 0, 0)
const CHARS = ['▁', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
const BAND_IDS = ['read', 'find', 'edit', 'write', 'shell', 'test', 'git', 'hub', 'web', 'other'] as const

// The engine beneath the plugin: tools that succeed (a command with FAIL in
// it fails), a row of its own beneath the band, and a clock and store in
// memory.
function engine(on: On) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('tool.call', ($, e) => {
    const command = (e as { command?: unknown }).command
    return { result: 'ok', isError: typeof command === 'string' && command.includes('FAIL') } as never
  })
  on('ui.render', () => ({ type: 'Box', props: {}, children: [{ type: 'Text', props: {}, children: ['beneath'] }] }) as never)
  return {
    clock,
    start: ($: Engine) => $.session.start({ cwd: '/home/user', surface: 'terminal', isInteractive: true }),
    call: ($: Engine, tool: string, command?: string) => $.tool.call({ tool, ...(command ? { command } : {}) } as never),
    band: ($: Engine, { isWorking = true, bodyColumns = 100 } = {}) => $.ui.mount({
      plugin: 'session-equalizer',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking, maxRows: 4, bodyColumns, scroll: { offset: 0, bodyRows: 4 }, view: {} },
    }),
  }
}

// A bar is a keyed Box around one Text: its colour and dimness are the Text's.
const look = (bar: FoundElement | undefined) => (bar?.children[0] as { props?: { color?: string; dimColor?: boolean } } | undefined)?.props ?? {}
// A bar's height: 0 is the dim floor, 1 to 8 its block.
const height = (bar: FoundElement | undefined) =>
  !bar ? -1 : look(bar).dimColor === true ? 0 : Math.max(1, CHARS.indexOf(bar.text.charAt(0)))

async function heights(band: Awaited<ReturnType<ReturnType<typeof engine>['band']>>) {
  const out: Record<string, number> = {}
  for (const id of BAND_IDS) out[id] = height(await band.find({ key: `bar-${id}` }))
  return out
}

describe('the bands', () => {
  test('each kind of work lifts its own band, the busiest highest', async ($, on) => {
    const world = engine(on)
    await world.start($)
    for (let i = 0; i < 3; i += 1) await world.call($, 'Read')
    await world.call($, 'Edit')
    await world.call($, 'Bash', 'git status')
    await world.call($, 'Bash', 'git diff')
    const h = await heights(await world.band($))
    expect(h.read!).toBeGreaterThan(h.git!)
    expect(h.git!).toBeGreaterThan(h.edit!)
    expect(h.edit!).toBeGreaterThan(0)
    for (const id of ['find', 'write', 'shell', 'test', 'hub', 'web', 'other']) expect(h[id]).toBe(0)
  })

  test('commands sort into tests, git, GitHub and shell; tools into theirs', async ($, on) => {
    const world = engine(on)
    await world.start($)
    await world.call($, 'Bash', 'npm test 2>&1 | tail -3')
    await world.call($, 'Bash', 'cd /home/user/listenWell && git push -u origin main')
    await world.call($, 'Bash', 'gh api repos/soonavi/listenWell/pulls')
    await world.call($, 'Bash', 'ls -la')
    await world.call($, 'Grep')
    await world.call($, 'Write')
    await world.call($, 'WebFetch')
    await world.call($, 'mcp__github__get_me')
    await world.call($, 'Agent')
    const h = await heights(await world.band($))
    for (const id of ['test', 'git', 'hub', 'shell', 'find', 'write', 'web', 'other']) expect([id, h[id]! > 0]).toEqual([id, true])
    expect(h.read).toBe(0)
    expect(h.edit).toBe(0)
  })

  test('a failure turns its band red for a few seconds', async ($, on) => {
    const world = engine(on)
    await world.start($)
    await world.call($, 'Bash', 'npm test FAIL')
    expect(look(await (await world.band($)).find({ key: 'bar-test' })).color).toBe('#dc2626')
    await world.clock.advance(7_000)
    expect(look(await (await world.band($)).find({ key: 'bar-test' })).color).not.toBe('#dc2626')
  })
})

describe('the shape of it', () => {
  test('flat while Claude waits on you', async ($, on) => {
    const world = engine(on)
    await world.start($)
    await world.call($, 'Read')
    await world.call($, 'Edit')
    const h = await heights(await world.band($, { isWorking: false }))
    expect(Object.values(h)).toEqual(BAND_IDS.map(() => 0))
  })

  test('only the last minute counts', async ($, on) => {
    const world = engine(on)
    await world.start($)
    for (let i = 0; i < 4; i += 1) await world.call($, 'Read')
    await world.clock.advance(61_000)
    expect((await heights(await world.band($))).read).toBe(0)
  })

  test('labels under full-width bars; slimmer bars and no labels on a narrow screen', async ($, on) => {
    const world = engine(on)
    await world.start($)
    const wide = await world.band($, { bodyColumns: 100 })
    expect((await wide.find({ key: 'bar-read' }))?.text).toBe('▁▁▁▁▁▁ ')
    expect((await wide.find({ key: 'label-hub' }))?.text).toBe('github ')
    const narrow = await world.band($, { bodyColumns: 40 })
    expect((await narrow.find({ key: 'bar-read' }))?.text).toBe('▁▁ ')
    expect(await narrow.find({ key: 'label-read' })).toBeUndefined()
  })

  test('/eq hides it and shows it again, and the row beneath stays either way', async ($, on) => {
    const world = engine(on)
    await world.start($)
    const band = await world.band($)
    expect(await band.find({ key: 'bar-read' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'beneath' })).toBeDefined()
    expect((await $.command.run({ command: 'eq' } as never)).text).toContain('hidden')
    expect(await band.find({ key: 'bar-read' })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: 'beneath' })).toBeDefined()
    await $.command.run({ command: 'eq' } as never)
    expect(await band.find({ key: 'bar-read' })).toBeDefined()
  })
})
