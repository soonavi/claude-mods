import type { EngineInterface, Register } from 'claude-code'

// One status line for work that would be lost with the container: each repo's
// uncommitted files and the commits no remote has yet. The stop hook asks for
// a commit and push only once the turn is over (twice in one session so far);
// this shows the same thing while the work is going on.
//
// It looks at the working directory when that is a repo, and otherwise at the
// repos directly inside it (a cloud session's checkouts sit one level down).
// Refreshed when the session starts, after every Bash, Edit, Write or
// NotebookEdit call, and when a turn ends. Without git, or with no repo in
// sight, there is no line.

type Repo = { name: string; dirty: number; ahead: number; hasUpstream: boolean }
type Seen = { cwd?: string; shown?: string; isRunning: boolean; isAgain: boolean }

const WRITERS = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit'])
const GIT_MS = 10_000

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

/** "listenWell: 3 uncommitted, 1 unpushed", or "listenWell: all pushed". */
export function repoLine(repo: Repo): string {
  const parts: string[] = []
  if (repo.dirty) parts.push(`${repo.dirty} uncommitted`)
  if (repo.ahead) parts.push(`${repo.ahead} unpushed${repo.hasUpstream ? '' : ' (no upstream)'}`)
  return `${repo.name}: ${parts.length ? parts.join(', ') : 'all pushed'}`
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
  // No upstream, or one whose branch is gone: count what no remote has.
  if (ahead === undefined) {
    const count = await git($, dir, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])
    ahead = count.exitCode === 0 ? Number(count.stdout.trim()) || 0 : 0
  }
  return { name: dir.split('/').filter(Boolean).pop() ?? dir, dirty: parsed.dirty, ahead, hasUpstream: parsed.hasUpstream }
}

async function statusLine($: EngineInterface, cwd: string): Promise<string | undefined> {
  const repos: Repo[] = []
  for (const dir of await findRepos($, cwd)) {
    const repo = await describeRepo($, dir)
    if (repo) repos.push(repo)
  }
  return repos.length ? repos.map(repoLine).join(' · ') : undefined
}

// One look at a time; a request made during one runs once more after it.
async function refresh($: EngineInterface, seen: Seen): Promise<void> {
  if (!seen.cwd) return
  if (seen.isRunning) {
    seen.isAgain = true
    return
  }
  seen.isRunning = true
  try {
    do {
      seen.isAgain = false
      const text = await statusLine($, seen.cwd)
      if (text !== seen.shown) {
        seen.shown = text
        $.ui.status(text)
      }
    } while (seen.isAgain)
  } catch {
    // No git, or no process to run it in: no line rather than a wrong one.
    if (seen.shown !== undefined) {
      seen.shown = undefined
      $.ui.status(undefined)
    }
  } finally {
    seen.isRunning = false
  }
}

export const register: Register = on => {
  const seen: Seen = { isRunning: false, isAgain: false }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    seen.cwd = started.cwd
    await refresh($, seen)
    return started
  })

  // After the call, unawaited, so a tool's result is not held up by git.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (WRITERS.has(String(e.tool))) void refresh($, seen)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refresh($, seen)
    return result
  })
}
