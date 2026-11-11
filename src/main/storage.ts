import { app, session, shell } from 'electron'
import { existsSync } from 'node:fs'
import { lstat, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { clearDrafts, draftStats } from './store'
import { clearHistory } from './performance'
import { runningReviews } from './review'
import { chatStats, clearChats } from './chat'
import { checkoutsInUse, worktreesDir } from './repo'
import type { StorageItem, StorageUsage } from '../shared/types'

const root = (): string => app.getPath('userData')
const reposDir = (): string => join(root(), 'repos')
// Chromium's caches that it rebuilds by itself; cleared through the session, never by deleting files under it.
const CACHE_DIRS = ['Cache', 'Code Cache']

async function sizeOf(path: string): Promise<number> {
  try {
    const s = await lstat(path)
    if (!s.isDirectory()) return s.size
    const sizes = await Promise.all((await readdir(path)).map((e) => sizeOf(join(path, e))))
    return sizes.reduce((a, b) => a + b, 0)
  } catch {
    return 0
  }
}

// GitHub owner names cannot contain underscores, so the first "__" is where owner and name meet.
const repoOf = (dir: string): string => dir.replace('__', '/')
const busyRepos = (): Set<string> => new Set(runningReviews().map((r) => r.key.replace(/#\d+$/, '')))

async function repoItems(): Promise<StorageItem[]> {
  let dirs: string[] = []
  try {
    dirs = (await readdir(reposDir(), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
  const busy = busyRepos()
  const items = await Promise.all(
    dirs.map(async (name): Promise<StorageItem> => {
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

export async function storageUsage(): Promise<StorageUsage> {
  const drafts = draftStats()
  const file = (name: string): Promise<number> => sizeOf(join(root(), name))
  const chats = chatStats()
  const [repos, checkouts, history, snapshots, list, settings, cache, total] = await Promise.all([
    repoItems(),
    sizeOf(worktreesDir()),
    file('performance.json'),
    file('snapshots.json'),
    file('prs.json'),
    Promise.all(['settings.json', 'theme.json'].map(file)).then(([a, b]) => a + b),
    Promise.all(CACHE_DIRS.map(file)).then((s) => s.reduce((a, b) => a + b, 0)),
    sizeOf(root())
  ])
  const items: StorageItem[] = [
    ...repos,
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
      id: 'checkouts',
      group: 'repos',
      label: 'Pull request checkouts',
      detail: checkoutsInUse()
        ? 'Claude is reading one of them right now.'
        : 'The code of each pull request you reviewed or asked about. Removed by themselves 3 days after the pull request leaves your dashboard; fetched again when needed.',
      bytes: checkouts,
      clearable: checkouts > 0 && !checkoutsInUse()
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
      bytes: list,
      clearable: false
    },
    {
      id: 'settings',
      group: 'data',
      label: 'Settings',
      detail: 'Your reviewer voice, review options and appearance.',
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
    }
  ]
  // The draft rows are estimates of their share of drafts.json, so count the real file instead.
  const counted =
    items.reduce((n, i) => n + i.bytes, 0) - drafts.open.bytes - drafts.posted.bytes - chats.bytes +
    (await file('drafts.json')) + (await file('chats.json'))
  items.push({
    id: 'other',
    group: 'app',
    label: 'Other app data',
    detail: 'Electron’s own files: GPU caches, cookies, window and interface state.',
    bytes: Math.max(0, total - counted),
    clearable: false
  })
  return { path: root(), total, items }
}

export async function clearStorage(id: string): Promise<void> {
  if (typeof id !== 'string') throw new Error('Not a storage item.')
  if (id.startsWith('repo:')) {
    const name = id.slice('repo:'.length)
    if (!/^[\w.-]+$/.test(name) || name.startsWith('.')) throw new Error('Not a repository clone.')
    if (busyRepos().has(repoOf(name)) || checkoutsInUse())
      throw new Error('Claude is reading code from this repository. Try again when it finishes.')
    const dir = join(reposDir(), name)
    if (!existsSync(dir)) return
    await rm(dir, { recursive: true, force: true })
    return
  }
  switch (id) {
    case 'drafts:open':
      return clearDrafts(false)
    case 'drafts:posted':
      return clearDrafts(true)
    case 'chats':
      clearChats()
      return
    case 'checkouts':
      if (checkoutsInUse()) throw new Error('Claude is reading one of them. Try again when it finishes.')
      await rm(worktreesDir(), { recursive: true, force: true })
      return
    case 'history':
      return clearHistory('performance.json')
    case 'snapshots':
      return clearHistory('snapshots.json')
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
