import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

// One status line for what runs out: how full this session's context is, and
// how much of each usage window is gone and when it resets. Four of the last
// fifteen hands-on sessions stopped on "You've hit your session limit", one of
// them half way through a change; this puts the window where it can be seen
// before that happens, and says so in a toast at 80% and 95%. The context's
// fill sits beside it, with a toast at 80% and 90%, for a session that is
// about to be compacted.
//
// Reset times are a countdown ("resets in 2h 15m"), not a time of day: the
// session may run on a machine in another time zone than the person reading
// it, and a countdown is right everywhere. It is redrawn every minute so it
// does not stand still between turns.

type Figures = { context?: SessionContextUsage; rateLimits: readonly SessionRateLimit[] }

const SHORT: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const LONG: Record<string, string> = { five_hour: '5-hour', seven_day: '7-day', spend_limit: 'Spend limit' }
const ORDER = ['five_hour', 'seven_day', 'spend_limit']
const WINDOW_URGENT = 95
const CONTEXT_URGENT = 90
const WINDOW_WARN = [80, WINDOW_URGENT]
const CONTEXT_WARN = [80, CONTEXT_URGENT]
const TOAST_MS = 8000
const TICK_MS = 60_000

/** 640000 → "640k", 1000000 → "1M", 1500 → "1.5k". */
export function tokens(n: number): string {
  const short = (x: number) => String(Number(x.toFixed(1)))
  if (n >= 1_000_000) return `${short(n / 1_000_000)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${short(n / 1000)}k`
  return String(n)
}

/** Milliseconds left as "3d 4h", "2h 15m", "45m" or "<1m". */
export function countdown(ms: number): string {
  if (ms < 60_000) return ms <= 0 ? 'now' : '<1m'
  const minutes = Math.floor(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return rest ? `${hours}h ${rest}m` : `${hours}h`
  return `${rest}m`
}

function resetIn(window: SessionRateLimit, now: number): string | undefined {
  const at = window.resetsAt ? Date.parse(window.resetsAt) : NaN
  return Number.isNaN(at) ? undefined : countdown(at - now)
}

function contextPercent(context?: SessionContextUsage): number | undefined {
  if (!context) return undefined
  if (typeof context.percent === 'number') return context.percent
  if (typeof context.tokens === 'number' && context.window > 0) return Math.round((context.tokens / context.window) * 100)
  return undefined
}

function ordered(windows: readonly SessionRateLimit[]): SessionRateLimit[] {
  const rank = (w: SessionRateLimit) => (ORDER.includes(w.kind) ? ORDER.indexOf(w.kind) : ORDER.length)
  return [...windows].sort((a, b) => rank(a) - rank(b))
}

/** The line, or undefined when there is nothing to show yet. */
export function statusLine(figures: Figures, now: number): string | undefined {
  const parts: string[] = []
  const filled = contextPercent(figures.context)
  if (filled !== undefined && figures.context) parts.push(`context ${filled}% of ${tokens(figures.context.window)}`)
  for (const window of ordered(figures.rateLimits)) {
    const reset = resetIn(window, now)
    parts.push(`${SHORT[window.kind] ?? window.kind} ${Math.round(window.percentUsed)}%${reset ? `, resets in ${reset}` : ''}`)
  }
  return parts.length ? parts.join(' · ') : undefined
}

// What one load of the module keeps: the last figures, the line on screen,
// and the highest threshold already toasted, per window (keyed with its reset
// time, so a new window warns afresh) and for the context (cleared when it
// drops below the lowest, as after a compaction).
type Seen = { last?: Figures; shown?: string; ticking: boolean; warned: Map<string, number> }

function crossed(seen: Seen, key: string, value: number, thresholds: readonly number[]): number | undefined {
  const top = thresholds.filter(t => value >= t).pop()
  if (top === undefined) {
    seen.warned.delete(key)
    return undefined
  }
  if (top <= (seen.warned.get(key) ?? 0)) return undefined
  seen.warned.set(key, top)
  return top
}

function warnings(seen: Seen, figures: Figures, now: number): string[] {
  const out: string[] = []
  for (const window of ordered(figures.rateLimits)) {
    const key = `${window.kind}@${window.resetsAt ?? ''}`
    for (const old of [...seen.warned.keys()]) if (old.startsWith(`${window.kind}@`) && old !== key) seen.warned.delete(old)
    const top = crossed(seen, key, window.percentUsed, WINDOW_WARN)
    if (top === undefined) continue
    const reset = resetIn(window, now)
    out.push(`${LONG[window.kind] ?? window.kind} usage at ${Math.round(window.percentUsed)}%${reset ? `, resets in ${reset}` : ''}.`
      + (top >= WINDOW_URGENT ? ' Wrap up or commit before it runs out.' : ''))
  }
  const filled = contextPercent(figures.context)
  if (filled !== undefined && figures.context) {
    const top = crossed(seen, 'context', filled, CONTEXT_WARN)
    if (top !== undefined) {
      const used = typeof figures.context.tokens === 'number'
        ? `${tokens(figures.context.tokens)} of ${tokens(figures.context.window)}`
        : `of ${tokens(figures.context.window)}`
      out.push(`Context ${filled}% full (${used}).` + (top >= CONTEXT_URGENT ? ' It will be compacted soon.' : ''))
    }
  }
  return out
}

async function show($: EngineInterface, seen: Seen, warn: boolean): Promise<void> {
  if (!seen.last) return
  const now = await $.clock.now()
  const text = statusLine(seen.last, now)
  if (text !== seen.shown) {
    seen.shown = text
    $.ui.status(text)
  }
  if (warn) for (const message of warnings(seen, seen.last, now)) $.ui.toast(message, { timeoutMs: TOAST_MS })
}

export const register: Register = on => {
  const seen: Seen = { ticking: false, warned: new Map() }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      const usage = await $.session.usage()
      seen.last = { context: usage.context, rateLimits: usage.rateLimits }
    } catch {
      // A host with no figures yet: the first measurement fills the line.
    }
    await show($, seen, true)
    if (!seen.ticking) {
      seen.ticking = true
      $.clock.every(TICK_MS, () => { void show($, seen, false) })
    }
    return started
  })

  on('session.measure', async ($, e, next) => {
    seen.last = { context: e.context, rateLimits: e.rateLimits }
    await show($, seen, true)
    return next(e)
  })
}
