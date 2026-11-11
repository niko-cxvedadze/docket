import { app } from 'electron'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { readdir, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from './env'

/**
 * Local code for reviews and questions. Each repository is cloned once, without file contents
 * (a blobless clone), and every pull request gets its own git worktree on top of it. A review and
 * a question about the same pull request share that worktree; different pull requests never touch
 * each other's files.
 *
 * Before each use the worktree is compared with the head commit GitHub reports, and fetched again
 * when they differ, so Claude always reads the code as it is on GitHub right now. The base branch
 * is fetched alongside, which tells how far the pull request has fallen behind it.
 */

const root = (): string => app.getPath('userData')
export const reposDir = (): string => join(root(), 'repos')
export const worktreesDir = (): string => join(root(), 'worktrees')
const cloneDir = (repo: string): string => join(reposDir(), repo.replace('/', '__'))
const worktreeName = (repo: string, number: number): string => `${repo.replace('/', '__')}__${number}`
const prRef = (number: number): string => `refs/docket/pr/${number}`

const git = (args: string[], cwd?: string, timeoutMs = 300_000): Promise<string> =>
  run(
    'git',
    // Credentials come from the gh CLI; hooks in someone else's repository never run.
    ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd, timeoutMs }
  )

// Git work on one repository goes one step at a time: two fetches into the same clone can collide.
const locks = new Map<string, Promise<unknown>>()
function locked<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(repo) ?? Promise.resolve()).then(fn, fn)
  locks.set(repo, next.catch(() => undefined))
  return next
}

// Worktrees a review or a question is reading right now; cleanup leaves them alone.
const inUse = new Map<string, number>()
const hold = (name: string): void => void inUse.set(name, (inUse.get(name) ?? 0) + 1)
const release = (name: string): void => {
  const n = (inUse.get(name) ?? 1) - 1
  if (n > 0) inUse.set(name, n)
  else inUse.delete(name)
}
export const checkoutsInUse = (): boolean => inUse.size > 0

/** How the pull request stands against its base branch, worked out from history alone. */
export interface BaseStatus {
  branch: string
  /** Commits on the base branch since the pull request branched off. */
  behind: number
  /** Files the pull request changes that also changed on the base branch since then. */
  overlap: string[]
}

export interface Checkout {
  dir: string
  head: string
  base: BaseStatus | null
  /** Call when done reading, so cleanup may remove the worktree later. */
  done: () => void
}

// The base branch is fetched again when its copy is older than this.
const BASE_FRESH_MS = 5 * 60_000
const baseFetchedAt = new Map<string, number>()

async function baseStatus(clone: string, branch: string, number: number): Promise<BaseStatus | null> {
  try {
    const base = `refs/remotes/origin/${branch}`
    const fork = (await git(['merge-base', base, prRef(number)], clone)).trim()
    const behind = Number((await git(['rev-list', '--count', `${fork}..${base}`], clone)).trim()) || 0
    if (!behind) return { branch, behind: 0, overlap: [] }
    // Names only: trees are in the blobless clone, so this downloads nothing.
    const names = async (to: string): Promise<Set<string>> =>
      new Set((await git(['diff', '--name-only', '--no-renames', fork, to], clone)).split('\n').filter(Boolean))
    const [ours, theirs] = await Promise.all([names(prRef(number)), names(base)])
    return { branch, behind, overlap: [...ours].filter((f) => theirs.has(f)).sort() }
  } catch (e) {
    console.error('could not compare the pull request with its base branch:', e)
    return null
  }
}

/**
 * The pull request's worktree at `head` (the commit GitHub reports now), fetched and checked out
 * when it is behind. Null when the code cannot be fetched; callers then work from the diff.
 */
export async function prCheckout(
  pr: { repo: string; number: number; baseRef: string },
  head: string,
  step: (s: string) => void = () => {}
): Promise<Checkout | null> {
  const clone = cloneDir(pr.repo)
  const name = worktreeName(pr.repo, pr.number)
  const dir = join(worktreesDir(), name)
  hold(name)
  try {
    const result = await locked(pr.repo, async () => {
      if (!existsSync(join(clone, '.git'))) {
        step('Cloning the repository (first time only)')
        mkdirSync(reposDir(), { recursive: true })
        await git(['clone', '--filter=blob:none', '--no-checkout', `https://github.com/${pr.repo}.git`, clone])
      }
      // A worktree whose clone was cleared no longer works; it is made again below.
      let current = ''
      if (existsSync(dir)) {
        try {
          current = (await git(['rev-parse', 'HEAD'], dir, 30_000)).trim()
        } catch {
          rmSync(dir, { recursive: true, force: true })
        }
      }
      const baseStale = Date.now() - (baseFetchedAt.get(pr.repo + pr.baseRef) ?? 0) > BASE_FRESH_MS
      if (current !== head || baseStale) {
        step(current && current !== head ? 'Fetching the new commits' : 'Fetching the latest code')
        // Named refs, never FETCH_HEAD: nothing else depends on what this fetch leaves behind.
        const refspecs = [`+pull/${pr.number}/head:${prRef(pr.number)}`, `+refs/heads/${pr.baseRef}:refs/remotes/origin/${pr.baseRef}`]
        try {
          await git(['fetch', '--quiet', '--no-write-fetch-head', 'origin', ...refspecs], clone)
          baseFetchedAt.set(pr.repo + pr.baseRef, Date.now())
        } catch (e) {
          // The base branch may be gone; the pull request itself is what matters.
          console.error('fetch with the base branch failed, fetching the pull request alone:', e)
          await git(['fetch', '--quiet', '--no-write-fetch-head', 'origin', refspecs[0]], clone)
        }
      }
      const fetched = (await git(['rev-parse', prRef(pr.number)], clone)).trim()
      if (fetched !== head) console.warn(`GitHub reported ${head} for ${pr.repo}#${pr.number}, fetched ${fetched}`)
      if (!existsSync(dir)) {
        step('Checking out the pull request')
        await git(['worktree', 'prune'], clone)
        mkdirSync(worktreesDir(), { recursive: true })
        await git(['worktree', 'add', '--force', '--detach', dir, prRef(pr.number)], clone)
      } else if (current !== fetched) {
        step('Checking out the new commits')
        await git(['checkout', '--quiet', '--force', '--detach', prRef(pr.number)], dir)
      }
      // Cleanup goes by when a worktree was last used.
      await utimes(dir, new Date(), new Date()).catch(() => undefined)
      return { dir, head: fetched, base: await baseStatus(clone, pr.baseRef, pr.number) }
    })
    let released = false
    return {
      ...result,
      done: () => {
        if (!released) release(name)
        released = true
      }
    }
  } catch (e) {
    release(name)
    console.error(`could not check out ${pr.repo}#${pr.number}:`, e)
    return null
  }
}

/** A few lines for Claude about where the pull request stands against its base branch. */
export function describeBase(base: BaseStatus | null): string {
  if (!base) return ''
  if (!base.behind) return `The pull request is up to date with ${base.branch}.`
  const files = base.overlap.slice(0, 30)
  return `${base.branch} has ${base.behind} ${base.behind === 1 ? 'commit' : 'commits'} the pull request does not include yet.${
    files.length
      ? ` These files changed both in the pull request and on ${base.branch} since it branched off, so they may conflict or the change may need updating: ${files.join(', ')}${base.overlap.length > files.length ? ', …' : ''}.`
      : ` None of them touch the files this pull request changes.`
  }`
}

const UNUSED_MS = 3 * 24 * 60 * 60_000

/** Removes worktrees of pull requests not in `keep` (keys like "owner/name#12") that nobody used for days. */
export async function pruneCheckouts(keep: Set<string>): Promise<void> {
  let names: string[]
  try {
    names = await readdir(worktreesDir())
  } catch {
    return
  }
  for (const name of names) {
    const m = name.match(/^(.+?)__(.+)__(\d+)$/)
    if (!m || inUse.has(name)) continue
    const [, owner, repoName, number] = m
    const repo = `${owner}/${repoName}`
    if (keep.has(`${repo}#${number}`)) continue
    const dir = join(worktreesDir(), name)
    const used = await stat(dir).catch(() => null)
    if (used && Date.now() - used.mtimeMs < UNUSED_MS) continue
    await locked(repo, async () => {
      if (inUse.has(name)) return
      rmSync(dir, { recursive: true, force: true })
      const clone = cloneDir(repo)
      if (existsSync(join(clone, '.git'))) {
        await git(['worktree', 'prune'], clone).catch(() => undefined)
        await git(['update-ref', '-d', prRef(Number(number))], clone).catch(() => undefined)
      }
    }).catch((e) => console.error('could not remove an old checkout:', e))
  }
}
