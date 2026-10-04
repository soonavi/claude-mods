import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, SessionContextUsage, SessionRateLimit, UsageUnit } from 'claude-code'

const T0 = Date.UTC(2026, 9, 4, 12, 0, 0)
const M = 60_000
const H = 60 * M
const D = 24 * H
const at = (ms: number) => new Date(T0 + ms).toISOString()

// What the plugin shows, seen from beneath it, and the engine's answer to the
// measurement it passes on.
function watch(on: On) {
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  on('ui.status', ($, e) => { statuses.push(e.text); return { value: undefined } })
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  return { statuses, toasts }
}

const changed: UsageUnit[] = ['context', 'rateLimits']
const reading = (context: SessionContextUsage, rateLimits: SessionRateLimit[]) => ({ context, rateLimits, changed })
const quiet: SessionContextUsage = { tokens: 100_000, window: 1_000_000, percent: 10 }
const fiveHour = (percentUsed: number, resetsInMs = 2 * H): SessionRateLimit[] => [{ kind: 'five_hour', percentUsed, resetsAt: at(resetsInMs) }]

describe('the line', () => {
  test('shows the context fill, then each window with its countdown, 5-hour first', async ($, on) => {
    mock.clock(on, { now: T0 })
    const seen = watch(on)
    await $.session.measure(reading({ tokens: 640_000, window: 1_000_000, percent: 64 }, [
      { kind: 'seven_day', percentUsed: 12, resetsAt: at(3 * D + 4 * H) },
      { kind: 'five_hour', percentUsed: 42.5, resetsAt: at(2 * H + 15 * M) },
    ]))
    expect(seen.statuses.at(-1)).toBe('context 64% of 1M · 5h 43%, resets in 2h 15m · 7d 12%, resets in 3d 4h')
    expect(seen.toasts).toEqual([])
  })

  test('off a subscription it is the context alone, and nothing before a reading', async ($, on) => {
    mock.clock(on, { now: T0 })
    const seen = watch(on)
    await $.session.measure(reading({ window: 200_000 }, []))
    expect(seen.statuses).toEqual([])
    await $.session.measure(reading({ tokens: 20_000, window: 200_000, percent: 10 }, []))
    expect(seen.statuses).toEqual(['context 10% of 200k'])
  })

  test('the countdown moves between turns', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const seen = watch(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.usage', () => ({ value: { startedAt: T0, context: quiet, rateLimits: fiveHour(50, 2 * H + 15 * M) } }))
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    expect(seen.statuses.at(-1)).toBe('context 10% of 1M · 5h 50%, resets in 2h 15m')
    await clock.advance(M)
    expect(seen.statuses.at(-1)).toBe('context 10% of 1M · 5h 50%, resets in 2h 14m')
  })
})

describe('the toasts', () => {
  test('the 5-hour window warns once at 80%, again at 95%, and afresh in the next window', async ($, on) => {
    mock.clock(on, { now: T0 })
    const seen = watch(on)
    await $.session.measure(reading(quiet, fiveHour(79)))
    expect(seen.toasts).toEqual([])
    await $.session.measure(reading(quiet, fiveHour(81)))
    expect(seen.toasts).toEqual(['5-hour usage at 81%, resets in 2h.'])
    await $.session.measure(reading(quiet, fiveHour(88)))
    expect(seen.toasts.length).toBe(1)
    await $.session.measure(reading(quiet, fiveHour(96)))
    expect(seen.toasts.at(-1)).toBe('5-hour usage at 96%, resets in 2h. Wrap up or commit before it runs out.')
    // The window reset and filled up again.
    await $.session.measure(reading(quiet, fiveHour(82, 4 * H + 30 * M)))
    expect(seen.toasts.at(-1)).toBe('5-hour usage at 82%, resets in 4h 30m.')
    expect(seen.toasts.length).toBe(3)
  })

  test('the context warns as it fills, and again after a compaction', async ($, on) => {
    mock.clock(on, { now: T0 })
    const seen = watch(on)
    await $.session.measure(reading({ tokens: 850_000, window: 1_000_000, percent: 85 }, []))
    expect(seen.toasts).toEqual(['Context 85% full (850k of 1M).'])
    await $.session.measure(reading({ tokens: 920_000, window: 1_000_000, percent: 92 }, []))
    expect(seen.toasts.at(-1)).toBe('Context 92% full (920k of 1M). It will be compacted soon.')
    await $.session.measure(reading({ tokens: 300_000, window: 1_000_000, percent: 30 }, []))
    expect(seen.toasts.length).toBe(2)
    await $.session.measure(reading({ tokens: 820_000, window: 1_000_000, percent: 82 }, []))
    expect(seen.toasts.at(-1)).toBe('Context 82% full (820k of 1M).')
  })
})
