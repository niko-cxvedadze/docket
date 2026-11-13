import { app, BrowserWindow, Notification } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { enabledAccountsIfKnown, legacyOwner } from './accounts'
import { prId, shortName, type Notice, type NoticeKind, type PrSummary } from '../shared/types'

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

/** One account's notices: each account has its own bell. One from before accounts were kept apart goes by the pull request it is about. */
export const listNotices = (account: string): Notice[] => load().filter((n) => (n.account ?? legacyOwner(n.prKey)) === account)

export function markNoticesRead(account: string): void {
  let changed = false
  for (const n of listNotices(account)) if (!n.read) (n.read = true), (changed = true)
  if (changed) persist()
}

export function notify(kind: NoticeKind, title: string, body: string, account: string | undefined, prKey?: string, prUrl?: string): void {
  const notice: Notice = { id: randomUUID(), at: new Date().toISOString(), kind, title, body, account, prKey, prUrl, read: false }
  const all = load()
  all.unshift(notice)
  all.splice(MAX_NOTICES)
  persist()
  getWindow()?.webContents.send('notice', notice)
  notifyMacOS(title, body, account, (w) => w.webContents.send('notice:open', notice))
}

/**
 * A macOS notification, shown only while the window is behind: in front, the window says so itself.
 * Clicking it brings the window forward, then runs `onClick`.
 */
export function notifyMacOS(title: string, body: string, account: string | undefined, onClick?: (win: BrowserWindow) => void): void {
  if (getWindow()?.isFocused() || !Notification.isSupported()) return
  // With several accounts, macOS says which one it is about; the window may be showing another.
  const several = (enabledAccountsIfKnown()?.length ?? 1) > 1
  const n = new Notification({ title, body, subtitle: several ? account : undefined })
  n.on('click', () => {
    const w = getWindow()
    if (!w) return
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
    onClick?.(w)
  })
  n.show()
}

// ---------- Changes between two dashboard refreshes ----------

let previous: Map<string, PrSummary> | null = null
// Two accounts can each list the same pull request; each copy is followed on its own.
const copyOf = (pr: PrSummary): string => prId(pr.account, pr.key)
const short = (pr: PrSummary): string => `${shortName(pr)} ${pr.title}`
const list = (names: string[]): string => (names.length ? names.join(', ') : 'a reviewer')

/**
 * Compares the new list with the last one and tells the user what changed for them. `restart` makes
 * this list the new starting point: after an account is switched on, its pull requests are not news.
 */
export function noticeChanges(prs: PrSummary[], restart = false): void {
  const before = restart ? null : previous
  previous = new Map(prs.map((p) => [copyOf(p), p]))
  if (!before) return // the first list after launch is the starting point, not news

  const fresh: PrSummary[] = []
  for (const pr of prs) {
    const was = before.get(copyOf(pr))
    let told = false
    const say = (kind: NoticeKind, title: string): void => {
      notify(kind, title, short(pr), pr.account, pr.key, pr.url)
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
  // Told per account, so each account's bell holds only its own.
  for (const account of new Set(fresh.map((p) => p.account))) {
    const theirs = fresh.filter((p) => p.account === account)
    if (theirs.length === 1) {
      const pr = theirs[0]
      notify('needs-you', pr.reasons[0]?.text ?? 'Needs you', short(pr), account, pr.key, pr.url)
    } else {
      notify('needs-you', `${theirs.length} pull requests need you`, theirs.map(short).join('\n'), account)
    }
  }
}
