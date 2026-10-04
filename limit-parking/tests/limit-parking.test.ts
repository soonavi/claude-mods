import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionRateLimit, UsageUnit } from 'claude-code'

import type { Parked } from '../types'

const T0 = Date.UTC(2026, 9, 4, 12, 0, 0)
const M = 60_000
const H = 60 * M
const at = (ms: number) => new Date(T0 + ms).toISOString()
const changed: UsageUnit[] = ['rateLimits']
const fiveHour = (percentUsed: number, resetsInMs = 80 * M): SessionRateLimit[] => [{ kind: 'five_hour', percentUsed, resetsAt: at(resetsInMs) }]
const NOTE_TOOL = 'mcp__limit-parking__save_note'

// The engine beneath the plugin: a clock and a store in memory, tools that
// answer "ok", and a record of the prompts that reached it (with the context
// riding on them) and of the toasts.
function engine(on: On, stored?: Parked) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, stored ? { parked: stored } : {})
  const submitted: string[] = []
  const promptContext: (readonly string[] | undefined)[] = []
  const toasts: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__limit-parking__${e.name}` } }))
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('ui.render', () => ({ type: 'Box', props: {}, children: [{ type: 'Text', props: {}, children: ['beneath'] }] }) as never)
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    promptContext.push(e.context)
    return { text: e.text }
  })
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return {
    clock,
    submitted,
    promptContext,
    toasts,
    bash: async ($: Engine) => (await $.tool.call({ tool: 'Bash', command: 'npm test' })).context,
    start: ($: Engine) => $.session.start({ cwd: '/home/user', surface: 'terminal', isInteractive: true }),
    measure: ($: Engine, rateLimits: SessionRateLimit[]) => $.session.measure({ context: { window: 1_000_000 }, rateLimits, changed }),
    band: ($: Engine) => $.ui.mount({
      plugin: 'limit-parking',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
    }),
  }
}

describe('parking', () => {
  test('at 95% mid-turn, the next tool result tells Claude how to park, once', async ($, on) => {
    const world = engine(on)
    await world.start($)
    await world.measure($, fiveHour(94))
    expect(await world.bash($)).toBeUndefined()
    await world.measure($, fiveHour(96))
    expect(world.toasts).toEqual(['Parking: the 5-hour window is at 96%. Claude is wrapping up.'])
    const told = (await world.bash($)) ?? []
    expect(told.length).toBe(1)
    expect(told[0]).toContain('The 5-hour usage window is at 96% and resets in 1h 20m. Park now:')
    expect(told[0]).toContain(`Call ${NOTE_TOOL} with a note`)
    expect(await world.bash($)).toBeUndefined()
    await world.measure($, fiveHour(98))
    expect(await world.bash($)).toBeUndefined()
    expect(world.toasts.length).toBe(1)
  })

  test('idle when it parks, the instruction goes with the next prompt instead', async ($, on) => {
    const world = engine(on)
    await world.start($)
    await world.measure($, fiveHour(97))
    await $.prompt.submit({ text: 'how is it going?', origin: { kind: 'composer' }, wait: false })
    expect(world.promptContext[0]?.[0]).toContain('The 5-hour usage window is at 97%')
    expect(await world.bash($)).toBeUndefined()
  })

  test('the row says it is parked, with the countdown and whether a note is saved', async ($, on) => {
    const world = engine(on)
    await world.start($)
    await world.measure($, fiveHour(96))
    const band = await world.band($)
    expect((await band.find({ type: 'Text', text: /Parked/ }))?.text).toBe('⏸ Parked · 5-hour window at 96%, resets in 1h 20m')
    const saved = await $.tool.call({ tool: NOTE_TOOL, note: 'Done: probe counts\nNext: commit and push' })
    expect(JSON.stringify(saved)).toContain('Saved.')
    expect((await band.find({ type: 'Text', text: /Parked/ }))?.text).toContain('· note saved')
    expect(await band.find({ type: 'Button' })).toBeUndefined()
  })
})

describe('resuming', () => {
  test('once the window resets, Resume sends the saved note and puts the row away', async ($, on) => {
    const world = engine(on)
    await world.start($)
    await world.measure($, fiveHour(96))
    await $.tool.call({ tool: NOTE_TOOL, note: 'Done: probe counts\nNext: commit and push' })
    await world.measure($, fiveHour(3, 5 * H))
    const band = await world.band($)
    expect((await band.find({ type: 'Text', text: /Resume:/ }))?.text).toBe('▶ Resume: Done: probe counts ')
    await band.press({ key: 'resume' })
    expect(world.submitted).toEqual(['The usage limit has reset. Pick up where you parked:\n\nDone: probe counts\nNext: commit and push'])
    expect(await band.find({ type: 'Button' })).toBeUndefined()
  })

  test('with no note saved, the last answer stands in for it', async ($, on) => {
    const world = engine(on)
    await world.start($)
    await $.turn.complete({ answer: 'Bumped to 0.2.27.\nNext: open the PR.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await world.measure($, fiveHour(96))
    await world.measure($, fiveHour(2, 5 * H))
    const band = await world.band($)
    expect((await band.find({ type: 'Text', text: /Resume:/ }))?.text).toBe('▶ Resume: Bumped to 0.2.27. ')
    await band.press({ key: 'resume' })
    expect(world.submitted[0]).toContain('(No note was saved. The last answer before the limit was:)\nBumped to 0.2.27.')
  })

  test('a session parked earlier is offered in a new one once its reset time has passed', async ($, on) => {
    const world = engine(on, {
      window: { kind: 'five_hour', percent: 97, resetsAt: at(-10 * M) },
      parkedAt: T0 - 2 * H,
      note: 'Next: run the phone probe against main',
    })
    await world.start($)
    const band = await world.band($)
    expect((await band.find({ type: 'Text', text: /Resume:/ }))?.text).toBe('▶ Resume: Next: run the phone probe against main ')
  })

  test('after the reset, a prompt of your own puts it away; a scheduled check-in does not', async ($, on) => {
    const world = engine(on, { window: { kind: 'five_hour', percent: 97, resetsAt: at(-M) }, parkedAt: T0 - H, note: 'Next: x' })
    await world.start($)
    const band = await world.band($)
    await $.prompt.submit({ text: 'Check-in on the PR', origin: { kind: 'scheduled-trigger' }, wait: false } as never)
    expect(await band.find({ type: 'Button', text: /Resume/ })).toBeDefined()
    await $.prompt.submit({ text: 'never mind, do the other thing', origin: { kind: 'bridge' }, wait: false })
    expect(await band.find({ type: 'Button' })).toBeUndefined()
  })

  test('its row stacks on the one beneath (the equalizer, the engine\'s own) instead of hiding it', async ($, on) => {
    const world = engine(on, { window: { kind: 'five_hour', percent: 97, resetsAt: at(-M) }, parkedAt: T0 - H, note: 'Next: x' })
    await world.start($)
    const band = await world.band($)
    expect(await band.find({ type: 'Button', text: /Resume/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'beneath' })).toBeDefined()
  })

  test('Dismiss puts it away without sending anything', async ($, on) => {
    const world = engine(on, { window: { kind: 'five_hour', percent: 97, resetsAt: at(-M) }, parkedAt: T0 - H, note: 'Next: x' })
    await world.start($)
    const band = await world.band($)
    await band.press({ key: 'dismiss' })
    expect(world.submitted).toEqual([])
    expect(await band.find({ type: 'Button' })).toBeUndefined()
  })
})
