import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { FsEntry, On, ProcessRunResult } from 'claude-code'

type FakeRepo = { status: string; revList?: string }

const ran = (exitCode: number, stdout = ''): ProcessRunResult =>
  ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const dir = (name: string): FsEntry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })

const PUSHED = '# branch.oid 1a2b\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n'
const WORK_LEFT = '# branch.oid 1a2b\n# branch.head feature\n# branch.upstream origin/feature\n# branch.ab +1 -0\n'
  + '1 .M N... 100644 100644 100644 aaa bbb src/App.jsx\n'
  + '1 M. N... 100644 100644 100644 ccc ddd SMOKE.md\n'
  + '? notes.txt\n'
const NO_UPSTREAM = '# branch.oid 1a2b\n# branch.head claude/new-branch\n'

// A machine beneath the plugin: git answering for the repos given (and for
// `cwdRepo`, when the working directory is one itself), a working directory
// holding them, and what the plugin shows.
function machine(on: On, repos: Record<string, FakeRepo>, { cwd = '/home/user', cwdRepo }: { cwd?: string; cwdRepo?: string } = {}) {
  const statuses: (string | undefined)[] = []
  const listed: string[] = []
  on('ui.status', ($, e) => { statuses.push(e.text); return { value: undefined } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('process.run', ($, e) => {
    const [, , at, command] = e.argv
    if (command === 'rev-parse') return { value: cwdRepo && at === cwd ? ran(0, `${cwdRepo}\n`) : ran(128) }
    const repo = repos[at ?? '']
    if (!repo) return { value: ran(128) }
    if (command === 'status') return { value: ran(0, repo.status) }
    if (command === 'rev-list') return { value: ran(0, repo.revList ?? '0\n') }
    return { value: ran(1) }
  })
  on('fs.list', ($, e) => {
    listed.push(e.path)
    const names = Object.keys(repos).filter(path => path.startsWith(`${cwd}/`)).map(path => path.slice(cwd.length + 1))
    return { value: [...names, 'scratch', '.cache'].map(dir) }
  })
  on('fs.exists', ($, e) => ({ value: Object.keys(repos).some(path => e.path === `${path}/.git`) }))
  return { statuses, listed, start: ($: Engine) => $.session.start({ cwd, surface: 'terminal', isInteractive: true }) }
}

describe('the line', () => {
  test('a repo inside the working directory, with work left in it', async ($, on) => {
    const world = machine(on, { '/home/user/listenWell': { status: WORK_LEFT } })
    await world.start($)
    expect(world.statuses).toEqual(['listenWell: 3 uncommitted, 1 unpushed'])
  })

  test('everything committed and pushed', async ($, on) => {
    const world = machine(on, { '/home/user/listenWell': { status: PUSHED } })
    await world.start($)
    expect(world.statuses).toEqual(['listenWell: all pushed'])
  })

  test('a branch with no upstream counts the commits no remote has', async ($, on) => {
    const world = machine(on, { '/home/user/listenWell': { status: NO_UPSTREAM, revList: '2\n' } })
    await world.start($)
    expect(world.statuses).toEqual(['listenWell: 2 unpushed (no upstream)'])
  })

  test('every repo in sight, side by side', async ($, on) => {
    const world = machine(on, {
      '/home/user/listenWell': { status: PUSHED },
      '/home/user/listenwell-releases': { status: `${PUSHED}? draft.md\n` },
    })
    await world.start($)
    expect(world.statuses).toEqual(['listenWell: all pushed · listenwell-releases: 1 uncommitted'])
  })

  test('a working directory that is itself a repo is the one looked at', async ($, on) => {
    const world = machine(on, { '/work/app': { status: WORK_LEFT } }, { cwd: '/work/app', cwdRepo: '/work/app' })
    await world.start($)
    expect(world.statuses).toEqual(['app: 3 uncommitted, 1 unpushed'])
    expect(world.listed).toEqual([])
  })

  test('no repo in sight, no line', async ($, on) => {
    const world = machine(on, {})
    await world.start($)
    expect(world.statuses).toEqual([])
  })
})

describe('keeping up', () => {
  test('a turn that pushes clears the work from the line', async ($, on) => {
    const repo = { status: WORK_LEFT }
    const world = machine(on, { '/home/user/listenWell': repo })
    await world.start($)
    repo.status = PUSHED
    await $.turn.complete({ answer: 'pushed', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    expect(world.statuses).toEqual(['listenWell: 3 uncommitted, 1 unpushed', 'listenWell: all pushed'])
  })

  test('nothing redrawn when nothing changed', async ($, on) => {
    const world = machine(on, { '/home/user/listenWell': { status: PUSHED } })
    await world.start($)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
    expect(world.statuses).toEqual(['listenWell: all pushed'])
  })
})
