import { app } from 'electron'
import { closeSync, copyFileSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Files holding the user's own work: review drafts, conversations, settings, daily snapshots.
 * None of them can be fetched again from GitHub, so they are written carefully and backed up.
 *
 * - Writes are atomic: a temporary file is flushed to disk and renamed over the old one, so a
 *   crash or a killed dev process never leaves half a file.
 * - Every write that changes the file also lands in a backup under ~/.docket/backups/<file>/,
 *   outside the app's data folder, so an app cleaner or a deleted data folder does not take the
 *   backups with it. The last 50 versions are kept, and one per hour for two days before that, so
 *   a deletion never overwrites the only copy of what it removed.
 * - Reading a file that is missing or unreadable restores the newest backup that parses.
 *
 * Clearing data on purpose writes an empty value; it never deletes the file. A missing file only
 * ever means data was lost, which is why it is safe to restore one.
 */

export type StoreName = 'drafts.json' | 'reviews.json' | 'chats.json' | 'settings.json' | 'theme.json' | 'snapshots.json' | 'sysmaps.json' | 'sysmap-chats.json'

/** Every recent version is kept; older ones thin out to one per hour. */
const KEEP_RECENT = 50
const KEEP_HOURLY_MS = 48 * 60 * 60_000

const dataPath = (name: StoreName): string => join(app.getPath('userData'), name)
export const backupsRoot = (): string => join(homedir(), '.docket', 'backups')
const backupDir = (name: StoreName): string => join(backupsRoot(), name.replace(/\.json$/, ''))

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

/** Newest first. Backups are named by the moment they were taken, so names sort by time. */
function backups(name: StoreName): string[] {
  try {
    return readdirSync(backupDir(name))
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .map((f) => join(backupDir(name), f))
  } catch {
    return []
  }
}

const lastBackup = new Map<StoreName, string>()

function backUp(name: StoreName, text: string): void {
  try {
    // Saving the same content again (an autosave with no change) adds nothing.
    if (lastBackup.get(name) === text) return
    const existing = backups(name)
    if (!lastBackup.has(name) && existing[0] && readFileSync(existing[0], 'utf8') === text) return void lastBackup.set(name, text)
    const dir = backupDir(name)
    mkdirSync(dir, { recursive: true })
    // 2026-11-11T16-04-05-123Z: sorts by time, and two saves in one second do not collide.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    atomicWrite(join(dir, `${stamp}.json`), text)
    lastBackup.set(name, text)
    prune([join(dir, `${stamp}.json`), ...existing])
  } catch (e) {
    console.error(`could not back up ${name}:`, e)
  }
}

/** Keeps the newest versions, then the newest of each hour for two days; drops the rest. */
function prune(newestFirst: string[]): void {
  const hours = new Set<string>()
  const now = Date.now()
  newestFirst.forEach((path, i) => {
    if (i < KEEP_RECENT) return
    const stamp = path.split('/').pop()!.replace(/\.json$/, '')
    // Back to an ISO time: 2026-11-11T16-04-05-123Z -> 2026-11-11T16:04:05.123Z
    const time = Date.parse(stamp.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/, 'T$1:$2:$3.$4Z'))
    const hour = stamp.slice(0, 13)
    const keep = Number.isFinite(time) && now - time < KEEP_HOURLY_MS && !hours.has(hour)
    hours.add(hour)
    if (!keep) rmSync(path, { force: true })
  })
}

/** Reads a store, restoring the newest good backup when the file is missing or damaged. */
export function readStore<T>(name: StoreName, fallback: T): T {
  const path = dataPath(name)
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT'
    for (const backup of backups(name)) {
      try {
        const value = JSON.parse(readFileSync(backup, 'utf8')) as T
        // Keep the damaged file for a look later, then put the backup in its place.
        if (!missing) copyFileSync(path, `${path}.damaged-${Date.now()}`)
        mkdirSync(app.getPath('userData'), { recursive: true })
        copyFileSync(backup, path)
        console.warn(`${name} was ${missing ? 'missing' : 'unreadable'}; restored it from ${backup}`)
        return value
      } catch {
        /* try the next one */
      }
    }
    if (!missing) console.error(`${name} is unreadable and no backup could be read:`, e)
    return fallback
  }
}

/** Writes a store atomically and keeps an hourly backup of it. */
export function writeStore(name: StoreName, value: unknown, pretty = false): void {
  const text = JSON.stringify(value, null, pretty ? 2 : undefined)
  mkdirSync(app.getPath('userData'), { recursive: true })
  atomicWrite(dataPath(name), text)
  backUp(name, text)
}
