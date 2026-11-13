import { app, session, shell } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { lstat, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { clearDrafts, draftStats } from './store'
import { clearHistory, historyBytes, snapshotBytes } from './performance'
import { runningReviews } from './review'
import { chatStats, clearChats } from './chat'
import { checkoutsInUse, listCheckouts, removeCheckouts, reposDir } from './repo'
import { knownAccountForRepo, legacyOwner } from './accounts'
import { originalAccount } from './settings'
import type { PrList, StorageItem, StorageUsage } from '../shared/types'

/**
 * What Docket keeps on disk, one account at a time. Each account's drafts, conversations, history
 * and code are measured and cleared on their own; clearing one account never touches another's.
 * Only what cannot belong to an account (settings, Chromium's caches) is shared, and shown as such.
 */

const root = (): string => app.getPath('userData')
// Chromium's caches that it rebuilds by itself; cleared through the session, never by deleting files under it.
const CACHE_DIRS = ['Cache', 'Code Cache']

async function sizeOf(path: string): Promise<number> {
  try {
    const s = await lstat(path)
    if (!s.isDirectory()) return s.size
    return sizeOfAll((await readdir(path)).map((e) => join(path, e)))
  } catch {
    return 0
  }
}

const sizeOfAll = async (paths: string[]): Promise<number> => (await Promise.all(paths.map(sizeOf))).reduce((a, b) => a + b, 0)

// GitHub owner names cannot contain underscores, so the first "__" is where owner and name meet.
const repoOf = (dir: string): string => dir.replace('__', '/')
const busyRepos = (): Set<string> => new Set(runningReviews().map((r) => r.key.replace(/#\d+$/, '')))

/** A clone belongs to the account whose pull requests are in that repository; one nobody lists now, to the original account. */
const repoOwner = (repo: string): string | undefined => knownAccountForRepo(repo) ?? originalAccount()
const checkoutOwner = (repo: string, number: number): string | undefined => legacyOwner(`${repo}#${number}`)

async function repoItems(account: string): Promise<StorageItem[]> {
  let dirs: string[] = []
  try {
    dirs = (await readdir(reposDir(), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
  const busy = busyRepos()
  const items = await Promise.all(
    dirs
      .filter((name) => repoOwner(repoOf(name)) === account)
      .map(async (name): Promise<StorageItem> => {
        const dir = join(reposDir(), name)
        // Every review fetches into the clone, so FETCH_HEAD tells when it was last used.
        const used = await stat(join(dir, '.git', 'FETCH_HEAD')).catch(() => stat(dir).catch(() => null))
        const inUse = busy.has(repoOf(name))
        return {
          id: `repo:${name}`,
          group: 'repos',
          label: repoOf(name),
          detail: inUse
            ? 'A review is running in it right now.'
            : 'Cloned again, without your history, the next time you review a pull request here.',
          bytes: await sizeOf(dir),
          lastUsed: used?.mtime.toISOString(),
          clearable: !inUse
        }
      })
  )
  return items.sort((a, b) => b.bytes - a.bytes)
}

/** The size of this account's part of the saved pull request list. */
function listBytes(account: string): number {
  try {
    const list = JSON.parse(readFileSync(join(root(), 'prs.json'), 'utf8')) as PrList
    const theirs = list.prs.filter((p) => p.account === account)
    return theirs.length ? Buffer.byteLength(JSON.stringify(theirs)) : 0
  } catch {
    return 0
  }
}

export async function storageUsage(account: string): Promise<StorageUsage> {
  if (typeof account !== 'string' || !account) throw new Error('Not a GitHub account.')
  const drafts = draftStats(account)
  const files = (names: string[]): Promise<number> => sizeOfAll(names.map((name) => join(root(), name)))
  const chats = chatStats(account)
  const checkoutDirs = (await listCheckouts()).filter((c) => checkoutOwner(c.repo, c.number) === account)
  const [repos, checkouts, settings, cache, folder, everyAccount] = await Promise.all([
    repoItems(account),
    sizeOfAll(checkoutDirs.map((c) => c.dir)),
    files(['settings.json', 'theme.json']),
    files(CACHE_DIRS),
    sizeOf(root()),
    // Everything that belongs to some account, to tell what is left over as Electron's own.
    files(['repos', 'worktrees', 'drafts.json', 'chats.json', 'performance.json', 'snapshots.json', 'prs.json'])
  ])
  const history = historyBytes(account)
  const snapshots = snapshotBytes(account)
  const items: StorageItem[] = [
    ...repos,
    {
      id: 'checkouts',
      group: 'repos',
      label: 'Pull request checkouts',
      detail: checkoutsInUse()
        ? 'Claude is reading one of them right now.'
        : `The code of ${checkoutDirs.length} pull ${checkoutDirs.length === 1 ? 'request' : 'requests'} you reviewed or asked about. Removed by themselves 3 days after the pull request leaves your dashboard; fetched again when needed.`,
      bytes: checkouts,
      clearable: checkouts > 0 && !checkoutsInUse()
    },
    {
      id: 'drafts:open',
      group: 'data',
      label: 'Unposted review drafts',
      detail: `${drafts.open.count} ${drafts.open.count === 1 ? 'draft' : 'drafts'} not posted to GitHub yet. Clearing them loses that work.`,
      bytes: drafts.open.bytes,
      clearable: drafts.open.count > 0
    },
    {
      id: 'drafts:posted',
      group: 'data',
      label: 'Posted reviews',
      detail: `${drafts.posted.count} ${drafts.posted.count === 1 ? 'review' : 'reviews'} already on GitHub, kept so the dashboard can mark them as posted.`,
      bytes: drafts.posted.bytes,
      clearable: drafts.posted.count > 0
    },
    {
      id: 'chats',
      group: 'data',
      label: 'Conversations with Claude',
      detail: `${chats.count} ${chats.count === 1 ? 'conversation' : 'conversations'} about pull requests. Clearing them loses the conversations.`,
      bytes: chats.bytes,
      clearable: chats.count > 0
    },
    {
      id: 'history',
      group: 'data',
      label: 'Performance history',
      detail: 'Your merged pull requests, reviews and commits from the last year. Fetched again from GitHub over a few minutes.',
      bytes: history,
      clearable: history > 0
    },
    {
      id: 'snapshots',
      group: 'data',
      label: 'Daily queue snapshots',
      detail: 'What your dashboard looked like each day. GitHub does not keep this, so it cannot be fetched again.',
      bytes: snapshots,
      clearable: snapshots > 0
    },
    {
      id: 'list',
      group: 'data',
      label: 'Last pull request list',
      detail: 'Shown when GitHub cannot be reached. Written again on every refresh.',
      bytes: listBytes(account),
      clearable: false
    },
    {
      id: 'settings',
      group: 'app',
      label: 'Settings',
      detail: 'The reviewer voice of each account, the review options and the appearance.',
      bytes: settings,
      clearable: false
    },
    {
      id: 'cache',
      group: 'app',
      label: 'Web cache',
      detail: 'Avatars and compiled scripts. Rebuilt as you use the app.',
      bytes: cache,
      clearable: cache > 0
    },
    {
      id: 'other',
      group: 'app',
      label: 'Other app data',
      detail: 'Electron’s own files: GPU caches, cookies, window and interface state.',
      bytes: Math.max(0, folder - everyAccount - settings - cache),
      clearable: false
    }
  ]
  return { path: root(), total: items.reduce((n, i) => n + (i.group === 'app' ? 0 : i.bytes), 0), items }
}

/** Clears one item of one account. Only the web cache, which has no owner, is cleared for everyone. */
export async function clearStorage(account: string, id: string): Promise<void> {
  if (typeof id !== 'string' || typeof account !== 'string' || !account) throw new Error('Not a storage item.')
  if (id.startsWith('repo:')) {
    const name = id.slice('repo:'.length)
    if (!/^[\w.-]+$/.test(name) || name.startsWith('.')) throw new Error('Not a repository clone.')
    if (repoOwner(repoOf(name)) !== account) throw new Error('That clone belongs to another account.')
    if (busyRepos().has(repoOf(name)) || checkoutsInUse())
      throw new Error('Claude is reading code from this repository. Try again when it finishes.')
    const dir = join(reposDir(), name)
    if (!existsSync(dir)) return
    await rm(dir, { recursive: true, force: true })
    return
  }
  switch (id) {
    case 'drafts:open':
      return clearDrafts(account, false)
    case 'drafts:posted':
      return clearDrafts(account, true)
    case 'chats':
      clearChats(account)
      return
    case 'checkouts':
      if (checkoutsInUse()) throw new Error('Claude is reading one of them. Try again when it finishes.')
      await removeCheckouts((repo, number) => checkoutOwner(repo, number) === account)
      return
    case 'history':
      return clearHistory(account, 'performance.json')
    case 'snapshots':
      return clearHistory(account, 'snapshots.json')
    case 'cache':
      await session.defaultSession.clearCache()
      await session.defaultSession.clearCodeCaches({})
      return
    default:
      throw new Error('This cannot be cleared.')
  }
}

export const revealStorage = async (): Promise<void> => {
  const err = await shell.openPath(root())
  if (err) throw new Error(err)
}
