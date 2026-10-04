import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity } from '../types'

// The session as an equalizer, in ListenWell's colours: ten bands above the
// prompt, one per kind of work, each as tall as that kind of work has been
// busy over the last minute. A band turns red for a few seconds when a call
// in it fails, and the whole thing lies flat while Claude is waiting on you.
// From a phone, a glance answers "is it stuck, is it testing, did something
// break?" without reading the transcript. /eq hides it, and shows it again.
//
// It draws above whatever else sits in that row (limit-parking's Resume, the
// engine's own) instead of replacing it.

export const BANDS = [
  { id: 'read', label: 'read' },
  { id: 'find', label: 'find' },
  { id: 'edit', label: 'edit' },
  { id: 'write', label: 'write' },
  { id: 'shell', label: 'shell' },
  { id: 'test', label: 'test' },
  { id: 'git', label: 'git' },
  { id: 'hub', label: 'github' },
  { id: 'web', label: 'web' },
  { id: 'other', label: 'other' },
] as const
export type BandId = (typeof BANDS)[number]['id']

const WINDOW_MS = 60_000
const TAU_MS = 15_000
const FAIL_MS = 6_000
const FRAME_MS = 200
const CHARS = ['▁', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
// From ListenWell's own palette: the accent's lighter tint, the accent, the
// pink preset for a peak, and the red preset for a failure.
const COLOURS = { soft: '#c4b5fd', accent: '#8b5cf6', peak: '#db2777', failed: '#dc2626' }
const TESTS = /\b(npm (run )?(test|lint|build)|npx (eslint|tsc|vitest|jest|playwright)|eslint|tsc|vitest|jest|pytest|cargo test|go test|node smoke\/|claude plugin (test|validate))\b/
const GITHUB = /\bgh (api|pr|run|release|repo)\b|api\.github\.com/
const GIT = /(^|[\s;&|(])git\s/

const activity = atom({ plugin: 'session-equalizer', key: 'activity' } as const, { hits: {}, failedAt: {} })
const isHidden = atom({ plugin: 'session-equalizer', key: 'isHidden' } as const, false)

type Seen = { isWorking: boolean; lastHit: number; isTicking: boolean }

/** Which band a call belongs to, by its tool and, for Bash, its command. */
export function bandOf(tool: string, command?: string): BandId {
  if (tool === 'Read' || tool === 'NotebookRead') return 'read'
  if (tool === 'Grep' || tool === 'Glob' || tool === 'LS' || tool === 'ToolSearch') return 'find'
  if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') return 'edit'
  if (tool === 'Write') return 'write'
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'web'
  if (/^mcp__github__/i.test(tool)) return 'hub'
  if (tool === 'Bash') {
    const text = command ?? ''
    if (TESTS.test(text)) return 'test'
    if (GITHUB.test(text)) return 'hub'
    if (GIT.test(text)) return 'git'
    return 'shell'
  }
  if (tool.startsWith('mcp__')) return 'web'
  return 'other'
}

/** 0 (the floor) to 8, from how busy a band has been: each call counts 1, fading over ~15 s. */
export function levelOf(hits: readonly number[] | undefined, now: number): number {
  let energy = 0
  for (const at of hits ?? []) if (now - at < WINDOW_MS && now >= at) energy += Math.exp(-(now - at) / TAU_MS)
  return energy < 0.05 ? 0 : Math.min(8, Math.ceil(energy * 2))
}

function colourOf(level: number, hasFailed: boolean): { color: string; dimColor?: boolean; bold?: boolean } {
  if (hasFailed) return { color: COLOURS.failed, bold: true }
  if (level === 0) return { color: COLOURS.accent, dimColor: true }
  if (level <= 3) return { color: COLOURS.soft }
  if (level <= 6) return { color: COLOURS.accent }
  return { color: COLOURS.peak }
}

async function record($: EngineInterface, seen: Seen, band: BandId, hasFailed: boolean): Promise<void> {
  const now = await $.clock.now()
  seen.lastHit = now
  await update($, activity, current => {
    const base: Activity = current ?? { hits: {}, failedAt: {} }
    const recent = (base.hits[band] ?? []).filter(at => now - at < WINDOW_MS)
    return {
      hits: { ...base.hits, [band]: [...recent, now] },
      failedAt: hasFailed ? { ...base.failedAt, [band]: now } : base.failedAt,
    }
  })
}

async function toggle($: EngineInterface): Promise<boolean> {
  const hidden = !(await read($, isHidden))
  await update($, isHidden, () => hidden)
  await $.store.set('isHidden', hidden)
  return hidden
}

async function frame($: EngineInterface, seen: Seen): Promise<void> {
  if (seen.isWorking || (await $.clock.now()) - seen.lastHit < WINDOW_MS) $.ui.invalidate('ui.render')
}

export const register: Register = on => {
  const seen: Seen = { isWorking: false, lastHit: 0, isTicking: false }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if ((await $.store.get('isHidden')) === true) await update($, isHidden, () => true)
    await $.command.register({ name: 'eq', description: 'Hide or show the session equalizer above the prompt' })
    if (!seen.isTicking) {
      seen.isTicking = true
      $.clock.every(FRAME_MS, () => { void frame($, seen) })
    }
    return started
  })

  on('command.run', { command: 'eq' }, async $ => {
    const hidden = await toggle($)
    return { text: hidden ? 'Session equalizer hidden. /eq shows it again.' : 'Session equalizer shown.' }
  })

  on('turn.start', async ($, e, next) => {
    seen.isWorking = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    seen.isWorking = false
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined) return result
    const command = (e as { command?: unknown }).command
    await record($, seen, bandOf(String(e.tool), typeof command === 'string' ? command : undefined), result.isError === true)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey || (await read($, isHidden))) return below
    const now = await $.clock.now()
    const recent = (await read($, activity)) ?? { hits: {}, failedAt: {} }
    const columns = e.props.bodyColumns
    const isFull = columns >= 70 && e.props.maxRows >= 2
    const width = isFull ? 6 : columns >= 30 ? 2 : 1
    const { Box, Text } = $.ui.resolve(e)
    const bars = BANDS.map((band, i) => {
      // Lying flat while Claude waits on you; otherwise a little movement on
      // the bands in use, so a busy session reads as one.
      const base = e.props.isWorking ? levelOf(recent.hits[band.id], now) : 0
      const sway = base > 0 && Math.sin(now / 160 + i * 1.7) > 0.55 ? 1 : 0
      const level = Math.min(8, base + sway)
      const hasFailed = e.props.isWorking && now - (recent.failedAt[band.id] ?? -Infinity) < FAIL_MS
      return (
        <Box key={`bar-${band.id}`}>
          <Text {...colourOf(level, hasFailed)}>{(CHARS[level] ?? '▁').repeat(width)}{' '}</Text>
        </Box>
      )
    })
    const equalizer = isFull
      ? (
        <Box flexDirection="column">
          <Box flexDirection="row">{bars}</Box>
          <Box flexDirection="row">
            {BANDS.map(band => <Box key={`label-${band.id}`}><Text dimColor>{band.label.padEnd(width)}{' '}</Text></Box>)}
          </Box>
        </Box>
      )
      : <Box flexDirection="row">{bars}</Box>
    return (
      <Box flexDirection="column">
        {equalizer}
        {below}
      </Box>
    )
  })
}
