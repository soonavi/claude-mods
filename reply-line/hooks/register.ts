import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

// The usage line, the unpushed-work line and the session equalizer, as one
// line at the end of every reply. A cloud session watched from the Claude app
// or the web draws on no surface at all ($.session.surfaces() is empty), so
// status lines, rows above the prompt and toasts never reach the person; the
// reply itself always does.
//
// Claude writes the line, from figures this plugin hands it: with the prompt
// (the instruction and the line as the turn starts) and then after every tool
// call, so the line copied into the answer is as of the last thing the turn
// did. Each figure is the plugin's own: the context's fill and the usage
// windows from the engine's measurements, the repos from git, the turn's work
// counted call by call. Only the main conversation gets it, not a subagent.

type Repo = { name: string; dirty: number; ahead: number; hasUpstream: boolean }
type Seen = {
  cwd?: string
  context?: SessionContextUsage
  rateLimits: readonly SessionRateLimit[]
  repos?: string
  counts: Record<string, number>
  failed: number
}

const KINDS = ['read', 'find', 'edit', 'write', 'shell', 'test', 'git', 'github', 'web', 'other'] as const
type Kind = (typeof KINDS)[number]
const WINDOW_NAMES: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const WINDOW_ORDER = ['five_hour', 'seven_day', 'spend_limit']
const CHANGES_TREE = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
const TESTS = /\b(npm (run )?(test|lint|build)|npx (eslint|tsc|vitest|jest|playwright)|eslint|tsc|vitest|jest|pytest|cargo test|go test|node smoke\/|claude plugin (test|validate))\b/
const GITHUB = /\bgh (api|pr|run|release|repo)\b|api\.github\.com/
const GIT = /(^|[\s;&|(])git\s/
const GIT_MS = 10_000

export const INSTRUCTION = 'End your reply with the most recent [reply-line] status you were given, as its own last line, in italics, copied exactly.'

/** Which kind of work a call is, by its tool and, for Bash, its command. */
export function kindOf(tool: string, command?: string): Kind {
  if (tool === 'Read' || tool === 'NotebookRead') return 'read'
  if (tool === 'Grep' || tool === 'Glob' || tool === 'LS' || tool === 'ToolSearch') return 'find'
  if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') return 'edit'
  if (tool === 'Write') return 'write'
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'web'
  if (/^mcp__github__/i.test(tool)) return 'github'
  if (tool === 'Bash') {
    const text = command ?? ''
    if (TESTS.test(text)) return 'test'
    if (GITHUB.test(text)) return 'github'
    if (GIT.test(text)) return 'git'
    return 'shell'
  }
  if (tool.startsWith('mcp__')) return 'web'
  return 'other'
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

/** What `git status --porcelain=v2 --branch` says about the branch and the tree. */
export function parseStatus(out: string): { dirty: number; ahead?: number; hasUpstream: boolean } {
  let dirty = 0
  let ahead: number | undefined
  let hasUpstream = false
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.upstream ')) hasUpstream = true
    else if (line.startsWith('# branch.ab ')) ahead = Number(/\+(\d+)/.exec(line)?.[1] ?? 0)
    else if (/^[12u?] /.test(line)) dirty += 1
  }
  return { dirty, ahead, hasUpstream }
}

function repoText(repo: Repo): string {
  const parts: string[] = []
  if (repo.dirty) parts.push(`${repo.dirty} uncommitted`)
  if (repo.ahead) parts.push(`${repo.ahead} unpushed${repo.hasUpstream ? '' : ' (no upstream)'}`)
  return `${repo.name}: ${parts.length ? parts.join(', ') : 'all pushed'}`
}

/** The line, from what the plugin has seen; undefined when there is nothing to say. */
export function statusLine(seen: Seen, now: number): string | undefined {
  const parts: string[] = []
  const context = seen.context
  const filled = typeof context?.percent === 'number'
    ? context.percent
    : typeof context?.tokens === 'number' && context.window > 0 ? Math.round((context.tokens / context.window) * 100) : undefined
  if (filled !== undefined) parts.push(`ctx ${filled}%`)
  const rank = (w: SessionRateLimit) => (WINDOW_ORDER.includes(w.kind) ? WINDOW_ORDER.indexOf(w.kind) : WINDOW_ORDER.length)
  for (const window of [...seen.rateLimits].sort((a, b) => rank(a) - rank(b))) {
    const at = window.resetsAt ? Date.parse(window.resetsAt) : NaN
    const reset = Number.isNaN(at) ? '' : ` (resets ${countdown(at - now)})`
    parts.push(`${WINDOW_NAMES[window.kind] ?? window.kind} ${Math.round(window.percentUsed)}%${reset}`)
  }
  if (seen.repos) parts.push(seen.repos)
  const work = KINDS.filter(kind => (seen.counts[kind] ?? 0) > 0).map(kind => `${seen.counts[kind]} ${kind}`)
  if (work.length) parts.push(`this turn: ${work.join(', ')}${seen.failed ? ` (${seen.failed} failed)` : ''}`)
  return parts.length ? parts.join(' · ') : undefined
}

async function git($: EngineInterface, dir: string, args: readonly string[]) {
  return $.process.run(['git', '-C', dir, ...args], { timeoutMs: GIT_MS })
}

async function findRepos($: EngineInterface, cwd: string): Promise<string[]> {
  const top = await git($, cwd, ['rev-parse', '--show-toplevel'])
  if (top.exitCode === 0 && top.stdout.trim()) return [top.stdout.trim()]
  const found: string[] = []
  for (const entry of await $.fs.list(cwd)) {
    if (entry.kind !== 'dir' || entry.name.startsWith('.')) continue
    const dir = `${cwd.replace(/\/$/, '')}/${entry.name}`
    if (await $.fs.exists(`${dir}/.git`)) found.push(dir)
  }
  return found.sort()
}

async function describeRepo($: EngineInterface, dir: string): Promise<Repo | undefined> {
  const status = await git($, dir, ['status', '--porcelain=v2', '--branch'])
  if (status.exitCode !== 0) return undefined
  const parsed = parseStatus(status.stdout)
  let ahead = parsed.ahead
  if (ahead === undefined) {
    const count = await git($, dir, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])
    ahead = count.exitCode === 0 ? Number(count.stdout.trim()) || 0 : 0
  }
  return { name: dir.split('/').filter(Boolean).pop() ?? dir, dirty: parsed.dirty, ahead, hasUpstream: parsed.hasUpstream }
}

// The repos' part of the line, looked up again; on any failure (no git, no
// process to run it in) the part is left out rather than wrong.
async function refreshRepos($: EngineInterface, seen: Seen): Promise<void> {
  if (!seen.cwd) return
  try {
    const repos: Repo[] = []
    for (const dir of await findRepos($, seen.cwd)) {
      const repo = await describeRepo($, dir)
      if (repo) repos.push(repo)
    }
    seen.repos = repos.length ? repos.map(repoText).join(', ') : undefined
  } catch {
    seen.repos = undefined
  }
}

async function lineNow($: EngineInterface, seen: Seen): Promise<string | undefined> {
  const line = statusLine(seen, await $.clock.now())
  return line ? `[reply-line] ${line}` : undefined
}

export const register: Register = on => {
  const seen: Seen = { rateLimits: [], counts: {}, failed: 0 }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    seen.cwd = started.cwd
    try {
      const usage = await $.session.usage()
      seen.context = usage.context
      seen.rateLimits = usage.rateLimits
    } catch {
      // No figures yet: the first measurement brings them.
    }
    await refreshRepos($, seen)
    return started
  })

  on('session.measure', async ($, e, next) => {
    seen.context = e.context
    seen.rateLimits = e.rateLimits
    return next(e)
  })

  // A new turn: its work counted from nothing, the repos looked at afresh,
  // and the instruction and the line as it stands go with the prompt.
  on('prompt.submit', async ($, e, next) => {
    seen.counts = {}
    seen.failed = 0
    await refreshRepos($, seen)
    const line = await lineNow($, seen)
    return next(line ? { ...e, context: [...(e.context ?? []), `${INSTRUCTION}\n${line}`] } : e)
  })

  // After each of the main conversation's calls, the line as of that call.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined || (e as { agentId?: string }).agentId) return result
    const tool = String(e.tool)
    const command = (e as { command?: unknown }).command
    const kind = kindOf(tool, typeof command === 'string' ? command : undefined)
    seen.counts = { ...seen.counts, [kind]: (seen.counts[kind] ?? 0) + 1 }
    if (result.isError === true) seen.failed += 1
    if (CHANGES_TREE.has(tool)) await refreshRepos($, seen)
    const line = await lineNow($, seen)
    return line ? { ...result, context: [...(result.context ?? []), line] } : result
  })
}
