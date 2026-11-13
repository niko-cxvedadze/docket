import { app } from 'electron'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { readdir, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { keyedQueue, run } from './env'
import { tokenFor } from './accounts'

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
const worktreesDir = (): string => join(root(), 'worktrees')
const cloneDir = (repo: string): string => join(reposDir(), repo.replace('/', '__'))
const worktreeName = (repo: string, number: number): string => `${repo.replace('/', '__')}__${number}`
const prRef = (number: number): string => `refs/docket/pr/${number}`

// Hands git the token of one account. The token travels in the environment of that one git
// command, never on a command line (where other programs could read it) and never into the clone.
const TOKEN_HELPER = `!f() { test "$1" = get && printf 'username=x-access-token\\npassword=%s\\n' "$DOCKET_GIT_TOKEN"; }; f`

/**
 * Runs git as one GitHub account, so a repository only that account can see is fetched with its
 * token whichever account gh uses in a terminal. With no account (`null`) git gets no credentials
 * at all: that is for commands that only touch the clone on disk. It never borrows another
 * account's sign-in; if the account's token cannot be had, the command fails. Hooks in someone
 * else's repository never run.
 */
async function git(account: string | null, args: string[], cwd?: string, timeoutMs = 300_000): Promise<string> {
  const token = account ? await tokenFor(account) : null
  return run(
    'git',
    ['-c', 'credential.helper=', ...(token ? ['-c', `credential.helper=${TOKEN_HELPER}`] : []), '-c', 'core.hooksPath=/dev/null', ...args],
    // Never stop to ask for a password: without the right token the command should simply fail.
    { cwd, timeoutMs, env: { GIT_TERMINAL_PROMPT: '0', ...(token ? { DOCKET_GIT_TOKEN: token } : {}) } }
  )
}

// Git work on one repository goes one step at a time: two fetches into the same clone can collide.
const locked = keyedQueue()

// Worktrees a review or a question is reading right now; cleanup leaves them alone.
const inUse = new Map<string, number>()
const hold = (name: string): void => void inUse.set(name, (inUse.get(name) ?? 0) + 1)
const release = (name: string): void => {
  const n = (inUse.get(name) ?? 1) - 1
  if (n > 0) inUse.set(name, n)
  else inUse.delete(name)
}
export const checkoutsInUse = (): boolean => inUse.size > 0

/** Keeps worktree `name` from being cleaned up while `work` makes it and until the caller says it is `done` reading. */
async function held<T extends object>(name: string, work: () => Promise<T>): Promise<T & { done: () => void }> {
  hold(name)
  try {
    const result = await work()
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
    throw e
  }
}

/**
 * Worktree `name` of a repository, made or moved to where `ref` points. Call it inside the
 * repository's lock. `fetch` brings `ref` up to date in the clone first; it is told the commit the
 * worktree is at now, '' when there is none. `what` names it in the progress line.
 */
async function worktreeAt(
  o: { repo: string; name: string; account: string; ref: string; what: string; timeoutMs?: number },
  step: (s: string) => void,
  fetch: (clone: string, current: string) => Promise<void>
): Promise<{ clone: string; dir: string; head: string }> {
  const clone = cloneDir(o.repo)
  const dir = join(worktreesDir(), o.name)
  if (!existsSync(join(clone, '.git'))) {
    step('Cloning the repository (first time only)')
    mkdirSync(reposDir(), { recursive: true })
    await git(o.account, ['clone', '--filter=blob:none', '--no-checkout', `https://github.com/${o.repo}.git`, clone])
  }
  // A worktree whose clone was cleared no longer works; it is made again below.
  let current = ''
  if (existsSync(dir)) {
    try {
      current = (await git(null, ['rev-parse', 'HEAD'], dir, 30_000)).trim()
    } catch {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  await fetch(clone, current)
  const head = (await git(null, ['rev-parse', o.ref], clone)).trim()
  if (!existsSync(dir)) {
    step(`Checking out ${o.what}`)
    await git(null, ['worktree', 'prune'], clone)
    mkdirSync(worktreesDir(), { recursive: true })
    // Checking out downloads the files themselves (the clone holds none), so it needs the account too.
    await git(o.account, ['worktree', 'add', '--force', '--detach', dir, o.ref], clone, o.timeoutMs)
  } else if (current !== head) {
    step('Checking out the new commits')
    await git(o.account, ['checkout', '--quiet', '--force', '--detach', o.ref], dir, o.timeoutMs)
  }
  // Cleanup goes by when a worktree was last used.
  await utimes(dir, new Date(), new Date()).catch(() => undefined)
  return { clone, dir, head }
}

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

async function baseStatus(account: string | null, clone: string, branch: string, number: number): Promise<BaseStatus | null> {
  try {
    const base = `refs/remotes/origin/${branch}`
    const fork = (await git(account, ['merge-base', base, prRef(number)], clone)).trim()
    const behind = Number((await git(account, ['rev-list', '--count', `${fork}..${base}`], clone)).trim()) || 0
    if (!behind) return { branch, behind: 0, overlap: [] }
    // Names only: trees are in the blobless clone, so this downloads nothing.
    const names = async (to: string): Promise<Set<string>> =>
      new Set((await git(account, ['diff', '--name-only', '--no-renames', fork, to], clone)).split('\n').filter(Boolean))
    const [ours, theirs] = await Promise.all([names(prRef(number)), names(base)])
    return { branch, behind, overlap: [...ours].filter((f) => theirs.has(f)).sort() }
  } catch (e) {
    console.error('could not compare the pull request with its base branch:', e)
    return null
  }
}

/**
 * The pull request's worktree at `head` (the commit GitHub reports now), fetched and checked out
 * when it is behind, as the GitHub account the pull request belongs to. Null when the code cannot
 * be fetched; callers then work from the diff.
 */
export async function prCheckout(
  pr: { repo: string; number: number; baseRef: string },
  account: string,
  head: string,
  step: (s: string) => void = () => {}
): Promise<Checkout | null> {
  const name = worktreeName(pr.repo, pr.number)
  const ref = prRef(pr.number)
  try {
    return await held(name, () =>
      locked(pr.repo, async () => {
        const at = await worktreeAt({ repo: pr.repo, name, account, ref, what: 'the pull request' }, step, async (clone, current) => {
          const baseStale = Date.now() - (baseFetchedAt.get(pr.repo + pr.baseRef) ?? 0) > BASE_FRESH_MS
          if (current === head && !baseStale) return
          step(current && current !== head ? 'Fetching the new commits' : 'Fetching the latest code')
          // Named refs, never FETCH_HEAD: nothing else depends on what this fetch leaves behind.
          const refspecs = [`+pull/${pr.number}/head:${ref}`, `+refs/heads/${pr.baseRef}:refs/remotes/origin/${pr.baseRef}`]
          try {
            await git(account, ['fetch', '--quiet', '--no-write-fetch-head', 'origin', ...refspecs], clone)
            baseFetchedAt.set(pr.repo + pr.baseRef, Date.now())
          } catch (e) {
            // The base branch may be gone; the pull request itself is what matters.
            console.error('fetch with the base branch failed, fetching the pull request alone:', e)
            await git(account, ['fetch', '--quiet', '--no-write-fetch-head', 'origin', refspecs[0]], clone)
          }
        })
        if (at.head !== head) console.warn(`GitHub reported ${head} for ${pr.repo}#${pr.number}, fetched ${at.head}`)
        return { dir: at.dir, head: at.head, base: await baseStatus(account, at.clone, pr.baseRef, pr.number) }
      })
    )
  } catch (e) {
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

/** Every pull request checkout on disk, with the pull request it is of. */
export async function listCheckouts(): Promise<{ name: string; dir: string; repo: string; number: number }[]> {
  let names: string[]
  try {
    names = await readdir(worktreesDir())
  } catch {
    return []
  }
  return names.flatMap((name) => {
    const m = name.match(/^(.+?)__(.+)__(\d+)$/)
    return m ? [{ name, dir: join(worktreesDir(), name), repo: `${m[1]}/${m[2]}`, number: Number(m[3]) }] : []
  })
}

/** Removes one checkout and what its clone keeps of it, unless Claude is reading it. */
const removeCheckout = (c: { name: string; dir: string; repo: string; number: number }): Promise<void> =>
  locked(c.repo, async () => {
    if (inUse.has(c.name)) return
    rmSync(c.dir, { recursive: true, force: true })
    const clone = cloneDir(c.repo)
    if (existsSync(join(clone, '.git'))) {
      await git(null, ['worktree', 'prune'], clone).catch(() => undefined)
      await git(null, ['update-ref', '-d', prRef(c.number)], clone).catch(() => undefined)
    }
  })

/** Removes the checkouts `mine` picks, leaving any that Claude is reading. They are fetched again when needed. */
export async function removeCheckouts(mine: (repo: string, number: number) => boolean): Promise<void> {
  for (const c of await listCheckouts()) if (mine(c.repo, c.number) && !inUse.has(c.name)) await removeCheckout(c)
}

const UNUSED_MS = 3 * 24 * 60 * 60_000

/** Removes worktrees of pull requests not in `keep` (keys like "owner/name#12") that nobody used for days. */
export async function pruneCheckouts(keep: Set<string>): Promise<void> {
  for (const c of await listCheckouts()) {
    if (inUse.has(c.name) || keep.has(`${c.repo}#${c.number}`)) continue
    const used = await stat(c.dir).catch(() => null)
    if (used && Date.now() - used.mtimeMs < UNUSED_MS) continue
    await removeCheckout(c).catch((e) => console.error('could not remove an old checkout:', e))
  }
}

// ---------- Branches, for system maps ----------
// A system map is drawn from one branch. Each mapped branch gets its own worktree on the same
// clone, kept between scans so an update only has to fetch the new commits. Its name never ends
// in a pull request number, so pruneCheckouts leaves it alone.

/** Whether a branch name is safe to hand to git and can exist on GitHub. */
export const validBranch = (branch: unknown): branch is string =>
  typeof branch === 'string' &&
  branch.length > 0 &&
  branch.length <= 250 &&
  !branch.startsWith('-') &&
  !branch.includes('..') &&
  // eslint-disable-next-line no-control-regex
  !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(branch)

const validSha = (sha: string): boolean => /^[0-9a-f]{7,40}$/.test(sha)

// Branch names hold slashes and worse; a short hash of the name is safe as a folder and as a ref.
const branchTag = (branch: string): string => createHash('sha1').update(branch).digest('hex').slice(0, 12)
const mapRef = (branch: string): string => `refs/docket/map/${branchTag(branch)}`
const mapWorktree = (repo: string, branch: string): string => `${repo.replace('/', '__')}__map-${branchTag(branch)}`

/** The repository's branches on GitHub and which of them is the default, without needing a clone. */
export async function remoteBranches(repo: string, account: string): Promise<{ defaultBranch: string | null; branches: { name: string; sha: string }[] }> {
  const out = await git(account, ['ls-remote', '--symref', `https://github.com/${repo}.git`, 'HEAD', 'refs/heads/*'], undefined, 60_000)
  let defaultBranch: string | null = null
  const branches: { name: string; sha: string }[] = []
  for (const line of out.split('\n')) {
    const [left, right] = line.split('\t')
    if (!right) continue
    if (left.startsWith('ref: refs/heads/') && right === 'HEAD') defaultBranch = left.slice('ref: refs/heads/'.length)
    else if (right.startsWith('refs/heads/')) branches.push({ name: right.slice('refs/heads/'.length), sha: left })
  }
  return { defaultBranch, branches }
}

/** The commit a branch is at on GitHub right now; null when the branch is gone. */
export async function remoteHead(repo: string, branch: string, account: string): Promise<string | null> {
  const out = await git(account, ['ls-remote', `https://github.com/${repo}.git`, `refs/heads/${branch}`], undefined, 60_000)
  return out.split('\t')[0]?.trim() || null
}

/**
 * A worktree of the branch as it is on GitHub now, fetched and checked out when it moved.
 * Unlike prCheckout this throws when the code cannot be fetched: a map cannot be drawn without it.
 * `asIs` reads the worktree where it stands when there is one, without asking GitHub: a question
 * about a map is about the commit the map describes, and must not move the code under a scan.
 */
export function branchCheckout(
  repo: string,
  branch: string,
  account: string,
  step: (s: string) => void = () => {},
  asIs = false
): Promise<{ dir: string; head: string; done: () => void }> {
  const name = mapWorktree(repo, branch)
  const ref = mapRef(branch)
  return held(name, () =>
    locked(repo, async () => {
      const { dir, head } = await worktreeAt({ repo, name, account, ref, what: 'the branch', timeoutMs: 900_000 }, step, async (clone, current) => {
        if (asIs && current) return
        step('Fetching the branch')
        await git(account, ['fetch', '--quiet', '--no-write-fetch-head', 'origin', `+refs/heads/${branch}:${ref}`], clone)
      })
      return { dir, head }
    })
  )
}

/** Removes a mapped branch's worktree once its map is deleted, unless something is reading it. The clone stays. */
export async function dropBranchCheckout(repo: string, branch: string): Promise<void> {
  const name = mapWorktree(repo, branch)
  await locked(repo, async () => {
    if (inUse.has(name)) return
    rmSync(join(worktreesDir(), name), { recursive: true, force: true })
    const clone = cloneDir(repo)
    if (!existsSync(join(clone, '.git'))) return
    await git(null, ['worktree', 'prune'], clone).catch(() => undefined)
    await git(null, ['update-ref', '-d', mapRef(branch)], clone).catch(() => undefined)
  }).catch((e) => console.error('could not remove the checkout of a deleted map:', e))
}

export interface CommitRange {
  /** How many commits `to` has that `from` does not. */
  total: number
  /** The newest of them, newest first. */
  commits: { sha: string; subject: string; author: string; date: string }[]
  /** `git diff --name-status` between the two commits. */
  files: string
  diff: string
  diffClipped: boolean
}

// Generated files that swell a diff without saying anything about how the system works.
const NOISE = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'Cargo.lock', 'go.sum', 'poetry.lock', 'composer.lock', 'Gemfile.lock', '*.min.js', '*.min.css', '*.map', '*.snap']

/**
 * What changed between two commits of a repository's clone: the commits, the files and the diff.
 * Null when `from` is no longer in the clone (the branch was rewritten, or the clone was cleared),
 * in which case there is nothing to update from.
 */
export async function commitRange(repo: string, account: string, from: string, to: string, maxDiffChars = 200_000): Promise<CommitRange | null> {
  if (!validSha(from) || !validSha(to)) return null
  const clone = cloneDir(repo)
  return locked(repo, async () => {
    try {
      await git(null, ['cat-file', '-e', `${from}^{commit}`], clone, 30_000)
    } catch {
      return null
    }
    const total = Number((await git(null, ['rev-list', '--count', `${from}..${to}`], clone)).trim()) || 0
    const log = await git(null, ['log', '--max-count=200', '--format=%H%x1f%an%x1f%cI%x1f%s', `${from}..${to}`], clone)
    const commits = log
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, author, date, ...subject] = line.split('\x1f')
        return { sha, author, date, subject: subject.join(' ') }
      })
    // Names come from the trees, which the clone already holds. The diff itself downloads the
    // changed files, so it runs as the account; when it cannot be made, Claude reads the checkout.
    // Finding renames compares file contents, which a clone without them has to download: as the account.
    const files = await git(account, ['diff', '--name-status', '-M', from, to], clone)
    let diff = ''
    try {
      diff = await git(
        account,
        ['diff', '--no-color', '-M', '--unified=2', from, to, '--', '.', ...NOISE.map((n) => `:(exclude,glob)**/${n}`)],
        clone,
        600_000
      )
    } catch (e) {
      console.error('could not diff the new commits:', e)
    }
    return { total, commits, files, diff: diff.slice(0, maxDiffChars), diffClipped: diff.length > maxDiffChars }
  })
}
