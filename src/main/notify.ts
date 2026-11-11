import { app, BrowserWindow, Notification } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Notice, NoticeKind, PrSummary } from '../shared/types'

/**
 * Everything Docket tells the user about: shown as a macOS notification while the window is in the
 * background, as a toast while it is in front, and kept in the bell's list either way.
 */

const MAX_NOTICES = 100
const file = (): string => join(app.getPath('userData'), 'notices.json')
let notices: Notice[] | null = null
let getWindow: () => BrowserWindow | null = () => null

function load(): Notice[] {
  if (notices) return notices
  try {
    notices = JSON.parse(readFileSync(file(), 'utf8')) as Notice[]
  } catch {
    notices = []
  }
  return notices
}

function persist(): void {
  try {
    writeFileSync(`${file()}.tmp`, JSON.stringify(load()))
    renameSync(`${file()}.tmp`, file())
  } catch (e) {
    console.error('could not save notifications:', e)
  }
}

export function setNoticeWindow(get: () => BrowserWindow | null): void {
  getWindow = get
}

export const listNotices = (): Notice[] => load()

export function markNoticesRead(): void {
  let changed = false
  for (const n of load()) if (!n.read) (n.read = true), (changed = true)
  if (changed) persist()
}

export function notify(kind: NoticeKind, title: string, body: string, prKey?: string, prUrl?: string): void {
  const notice: Notice = { id: randomUUID(), at: new Date().toISOString(), kind, title, body, prKey, prUrl, read: false }
  const all = load()
  all.unshift(notice)
  all.splice(MAX_NOTICES)
  persist()
  const win = getWindow()
  win?.webContents.send('notice', notice)
  // In front, the window shows a toast; behind, macOS shows the notification.
  if (win?.isFocused() || !Notification.isSupported()) return
  const n = new Notification({ title, body })
  n.on('click', () => {
    const w = getWindow()
    if (!w) return
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
    w.webContents.send('notice:open', notice)
  })
  n.show()
}

// ---------- Changes between two dashboard refreshes ----------

let previous: Map<string, PrSummary> | null = null
const short = (pr: PrSummary): string => `${pr.repo.split('/')[1]}#${pr.number} ${pr.title}`
const list = (names: string[]): string => (names.length ? names.join(', ') : 'a reviewer')

/** Compares the new list with the last one and tells the user what changed for them. */
export function noticeChanges(prs: PrSummary[]): void {
  const before = previous
  previous = new Map(prs.map((p) => [p.key, p]))
  if (!before) return // the first list after launch is the starting point, not news

  const fresh: PrSummary[] = []
  for (const pr of prs) {
    const was = before.get(pr.key)
    let told = false
    const say = (kind: NoticeKind, title: string): void => {
      notify(kind, title, short(pr), pr.key, pr.url)
      told = true
    }
    if (pr.role === 'mine' && was) {
      if (pr.ci === 'failure' && was.ci !== 'failure')
        say('ci-failed', pr.ciBlocksMerge ? 'CI is failing on your pull request' : 'Checks failing (none required)')
      else if (pr.ci === 'success' && was.ci === 'failure') say('ci-passed', 'Checks are passing again')
      if (pr.approval === 'approved' && was.approval !== 'approved') say('approved', `Approved by ${list(pr.approvedBy)}`)
      else if (pr.approval === 'changes_requested' && was.approval !== 'changes_requested')
        say('changes-requested', `Changes requested by ${list(pr.changesRequestedBy)}`)
      if (pr.merge === 'mergeable' && was.merge !== 'mergeable' && !told) say('ready', 'Ready to merge')
    }
    // Anything else that newly needs the user, unless a more specific notice above already said so.
    const needsNow = pr.level !== 'waiting'
    const neededBefore = !!was && was.level !== 'waiting'
    if (needsNow && !neededBefore && !told) fresh.push(pr)
  }
  if (fresh.length === 1) {
    const pr = fresh[0]
    notify('needs-you', pr.reasons[0]?.text ?? 'Needs you', short(pr), pr.key, pr.url)
  } else if (fresh.length > 1) {
    notify('needs-you', `${fresh.length} pull requests need you`, fresh.map(short).join('\n'))
  }
}
