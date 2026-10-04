import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Parked } from '../types'

// When a usage window is nearly spent, park: Claude stops at a safe point,
// commits and pushes, and leaves a note on where it was; once the window has
// reset, a row above the prompt offers to resume from that note in one tap.
// Before this, a session that ran out mid-change sat there until the person
// came back and wrote "I hit my usage limit… please continue from where you
// left off", and Claude had to work out from the transcript where that was.
//
// The instruction rides on what Claude reads next: the next tool's result in
// a running turn, or the next prompt when the session is idle (each carries
// `context`, text Claude reads after it and the person never sees). Never the
// system prompt: changing that part way through would throw away the prompt
// cache and re-read the whole conversation, at the moment there is least of
// the window left. The note is kept in the store as well, so a new session
// resumes it too. When no note was saved (the window ran out at the end of a
// turn), the last answer stands in for it.

const PARK_AT = 95
const STORE_KEY = 'parked'
const TOOL_NAME = 'save_note'
const TOOL_ID = 'mcp__limit-parking__save_note'
const TICK_MS = 60_000
const EXCERPT = 600
const NAMES: Record<string, string> = { five_hour: '5-hour', seven_day: '7-day', spend_limit: 'spend limit' }
// Prompts the person sent: typed in a terminal, from the phone or web app,
// or from the app hosting the session. Not a scheduled check-in, a task's
// notification or this plugin's own Resume.
const PERSON = new Set(['composer', 'bridge', 'sdk'])

const parked = atom({ plugin: 'limit-parking', key: 'parked' } as const, null)

type Seen = { lastAnswer?: string; isTicking: boolean }

/** Milliseconds left as "3d 4h", "1h 20m", "45m" or "<1m". */
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

function resetsAtMs(record: Parked): number | undefined {
  const at = record.window.resetsAt ? Date.parse(record.window.resetsAt) : NaN
  return Number.isNaN(at) ? undefined : at
}

function windowName(kind: string): string {
  return NAMES[kind] ?? kind
}

/** Whether the parked window has reset, by a measurement or by the clock. */
export function hasReset(record: Parked, now: number): boolean {
  const at = resetsAtMs(record)
  return record.isReset === true || (at !== undefined && now >= at)
}

/** What Claude reads when the session parks. */
export function parkingMessage(record: Parked, now: number): string {
  const at = resetsAtMs(record)
  const reset = at === undefined ? '' : ` and resets in ${countdown(at - now)}`
  return [
    `[limit-parking] The ${windowName(record.window.kind)} usage window is at ${Math.round(record.window.percent)}%${reset}. Park now:`,
    '1. Finish only the step in hand; start nothing new.',
    '2. Commit and push any work in progress to the branch you are on.',
    `3. Call ${TOOL_ID} with a note of at most three lines: what is done, what is next, and anything waiting on the person.`,
    '4. End your turn with one line saying you parked.',
  ].join('\n')
}

/** The prompt the Resume button sends. */
export function resumePrompt(record: Parked): string {
  const body = record.note
    ?? (record.lastAnswer
      ? `(No note was saved. The last answer before the limit was:)\n${record.lastAnswer.slice(0, EXCERPT)}`
      : '(No note was saved. Work out from the conversation where it stopped.)')
  return `The usage limit has reset. Pick up where you parked:\n\n${body}`
}

function firstLine(text: string | undefined): string {
  return (text ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? ''
}

function isParked(value: unknown): value is Parked {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<Parked>
  return typeof record.parkedAt === 'number' && typeof record.window?.kind === 'string' && typeof record.window.percent === 'number'
}

async function keep($: EngineInterface, record: Parked | null): Promise<void> {
  await update($, parked, () => record)
  if (record) await $.store.set(STORE_KEY, record)
  else await $.store.delete(STORE_KEY)
}

async function park($: EngineInterface, seen: Seen, window: SessionRateLimit): Promise<void> {
  await keep($, {
    window: { kind: window.kind, percent: window.percentUsed, resetsAt: window.resetsAt },
    parkedAt: await $.clock.now(),
    lastAnswer: seen.lastAnswer,
  })
  $.ui.toast(`Parking: the ${windowName(window.kind)} window is at ${Math.round(window.percentUsed)}%. Claude is wrapping up.`, { timeoutMs: 8000 })
}

async function measured($: EngineInterface, seen: Seen, windows: readonly SessionRateLimit[]): Promise<void> {
  const record = await read($, parked)
  if (record && !record.isReset) {
    const same = windows.find(w => w.kind === record.window.kind)
    if (same && (same.resetsAt !== record.window.resetsAt || same.percentUsed < PARK_AT)) {
      await keep($, { ...record, isReset: true })
      return
    }
    // Still parked on this window: once is enough.
    return
  }
  const spent = windows.find(w => w.percentUsed >= PARK_AT && !(record && record.window.kind === w.kind && record.window.resetsAt === w.resetsAt))
  if (spent) await park($, seen, spent)
}

/** The instruction, once: undefined when there is nothing (more) to say. */
async function instruction($: EngineInterface): Promise<string | undefined> {
  const record = await read($, parked)
  if (!record || record.isDelivered) return undefined
  const now = await $.clock.now()
  if (hasReset(record, now)) return undefined
  await keep($, { ...record, isDelivered: true })
  return parkingMessage(record, now)
}

async function saveNote($: EngineInterface, note: string): Promise<string> {
  const record = await read($, parked)
  if (!record) return 'Nothing is parked, so the note was not saved. Carry on.'
  await keep($, { ...record, note: note.trim() })
  return 'Saved. It will be offered as the place to resume once the window resets. End your turn now.'
}

async function resume($: EngineInterface): Promise<void> {
  const record = await read($, parked)
  if (!record) return
  await keep($, null)
  await $.prompt.submit({ text: resumePrompt(record) })
}

async function dismiss($: EngineInterface): Promise<void> {
  await keep($, null)
}

async function tick($: EngineInterface): Promise<void> {
  if (await read($, parked)) $.ui.invalidate('ui.render')
}

export const register: Register = on => {
  const seen: Seen = { isTicking: false }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const stored = await $.store.get(STORE_KEY)
    if (isParked(stored)) await update($, parked, () => stored)
    await $.tool.register({
      name: TOOL_NAME,
      description: 'Saves where you stopped when a [limit-parking] message says a usage window is nearly spent, so the work can be resumed after it resets. Call it only when such a message asks you to.',
      inputSchema: {
        type: 'object',
        properties: { note: { type: 'string', description: 'At most three lines: what is done, what is next, and anything waiting on the person.' } },
        required: ['note'],
      },
    })
    if (!seen.isTicking) {
      seen.isTicking = true
      // The countdown in the row moves without a turn to redraw it.
      $.clock.every(TICK_MS, () => { void tick($) })
    }
    return started
  })

  on('session.measure', async ($, e, next) => {
    await measured($, seen, e.rateLimits)
    return next(e)
  })

  on('tool.call', { tool: TOOL_ID }, async ($, e) => {
    const note = (e as { note?: unknown }).note
    return { result: await saveNote($, typeof note === 'string' ? note : '') }
  })

  // In a running turn, the instruction follows the next tool's result.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined || String(e.tool) === TOOL_ID) return result
    const text = await instruction($)
    return text ? { ...result, context: [...(result.context ?? []), text] } : result
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    seen.lastAnswer = done.text
    // Parked with no note yet: the answer just given is the best account of
    // where things stand.
    const record = await read($, parked)
    if (record && !record.note) await keep($, { ...record, lastAnswer: done.text })
    return done
  })

  // Idle when it parked: the instruction goes with the next prompt. And once
  // the window has reset, a prompt of the person's own means they have picked
  // things up themselves.
  on('prompt.submit', async ($, e, next) => {
    const record = await read($, parked)
    if (record && hasReset(record, await $.clock.now()) && PERSON.has(e.origin.kind)) await keep($, null)
    const text = await instruction($)
    return next(text ? { ...e, context: [...(e.context ?? []), text] } : e)
  })

  // Stacked on whatever else draws in this row (the session equalizer, the
  // engine's own), never in place of it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const record = await read($, parked)
    if (!record || e.props.hasSurvey) return below
    const now = await $.clock.now()
    const { Box, Button, Text } = $.ui.resolve(e)
    const at = resetsAtMs(record)
    const row = hasReset(record, now)
      ? (
        <Box>
          <Text>▶ Resume: {firstLine(record.note ?? record.lastAnswer) || 'where the session stopped'} </Text>
          <Button key="resume" label="Resume" onPress={() => resume($)} />
          <Button key="dismiss" label="Dismiss" onPress={() => dismiss($)} />
        </Box>
      )
      : (
        <Box>
          <Text dimColor>
            ⏸ Parked · {windowName(record.window.kind)} window at {Math.round(record.window.percent)}%
            {at !== undefined ? `, resets in ${countdown(at - now)}` : ''}
            {record.note ? ' · note saved' : ''}
          </Text>
        </Box>
      )
    return (
      <Box flexDirection="column">
        {row}
        {below}
      </Box>
    )
  })
}
