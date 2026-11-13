import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { keyedQueue, shared } from './env'
import { graphql, searchCommits } from './github'
import { originalAccount } from './settings'
import { readStore, writeStore } from './persist'
import type { MergedPr, Performance, PrSummary, ReviewGiven, Snapshot, SnapshotCounts, StoredSnapshot } from '../shared/types'

const WEEKS = 52
const PAGE = 50
const MAX_PAGES = 8
const CHUNK_DAYS = 28
const DAY = 86_400_000
const FRESH_MS = 30 * 60_000

const path = (name: string): string => join(app.getPath('userData'), name)

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path(name), 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(name: string, value: unknown): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(`${path(name)}.tmp`, JSON.stringify(value))
  renameSync(`${path(name)}.tmp`, path(name))
}

// ---------- Daily snapshots of the dashboard ----------
// GitHub cannot tell us what the queue looked like last week, so Docket writes it down as it goes,
// each account's queue on its own.

const localDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function countsOf(prs: PrSummary[]): SnapshotCounts {
  const mine = prs.filter((p) => p.role === 'mine')
  const queue = prs.filter((p) => p.role === 'review' && p.level !== 'waiting')
  return {
    blocked: mine.filter((p) => p.level === 'action').length,
    ready: mine.filter((p) => p.level === 'ready').length,
    reviewQueue: queue.length,
    queueLines: queue.reduce((n, p) => n + p.additions + p.deletions, 0)
  }
}

/**
 * A stored day with each account's counts. A day from before accounts were kept apart has its
 * counts at the top level; they are the original account's. While that account is not known yet
 * the day is left exactly as it is, never dropped.
 */
function perAccount(day: StoredSnapshot): StoredSnapshot {
  if (day.byAccount) return { date: day.date, byAccount: day.byAccount }
  const original = originalAccount()
  if (!original) return day
  return {
    date: day.date,
    byAccount: {
      [original]: { blocked: day.blocked ?? 0, ready: day.ready ?? 0, reviewQueue: day.reviewQueue ?? 0, queueLines: day.queueLines ?? 0 }
    }
  }
}

const storedSnapshots = (): StoredSnapshot[] => readStore<StoredSnapshot[]>('snapshots.json', []).map(perAccount)

/** Writes down today's dashboard for each of these accounts. An account not among them keeps what today already has for it. */
export function recordSnapshot(prs: PrSummary[], accounts: string[]): void {
  const all = storedSnapshots()
  const date = localDate(new Date())
  const before = all.find((s) => s.date === date)?.byAccount ?? {}
  const today: StoredSnapshot = {
    date,
    byAccount: { ...before, ...Object.fromEntries(accounts.map((account) => [account, countsOf(prs.filter((p) => p.account === account))])) }
  }
  writeStore('snapshots.json', [...all.filter((s) => s.date !== date), today].slice(-730))
}

/** One account's days, oldest first. */
function snapshotsOf(account: string): Snapshot[] {
  return storedSnapshots().flatMap((s) => {
    const counts = s.byAccount?.[account]
    return counts ? [{ date: s.date, ...counts }] : []
  })
}

/** How much of the snapshots is one account's, for the storage page. */
export const snapshotBytes = (account: string): number => {
  const days = snapshotsOf(account)
  return days.length ? Buffer.byteLength(JSON.stringify(days)) : 0
}

// ---------- History from GitHub ----------
// Kept per account: each has its own year of history, fetched and refreshed on its own.

const QUERY = `
query($q: String!, $after: String) {
  viewer { login }
  search(query: $q, type: ISSUE, first: ${PAGE}, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title url createdAt mergedAt additions deletions
      repository { nameWithOwner }
      author { login }
      reviews(first: 60) { nodes { submittedAt state author { login } } }
      timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], first: 40) {
        nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } } } }
      }
    } }
  }
}`

interface Node {
  number: number
  title: string
  url: string
  createdAt: string
  mergedAt: string | null
  additions: number
  deletions: number
  repository: { nameWithOwner: string }
  author: { login: string } | null
  reviews: { nodes: { submittedAt: string | null; state: string; author: { login: string } | null }[] }
  timelineItems: { nodes: { createdAt?: string; requestedReviewer?: { login?: string } | null }[] }
}

async function searchAll(account: string, q: string): Promise<{ viewer: string; nodes: Node[]; truncated: boolean }> {
  const nodes: Node[] = []
  let after: string | null = null
  let viewer = ''
  for (let page = 0; page < MAX_PAGES; page++) {
    const data: {
      viewer: { login: string }
      search: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Node[] }
    } = await graphql(account, QUERY, { q, after }, { background: true })
    viewer = data.viewer.login
    nodes.push(...data.search.nodes.filter((n) => n?.repository))
    if (!data.search.pageInfo.hasNextPage) return { viewer, nodes, truncated: false }
    after = data.search.pageInfo.endCursor
  }
  return { viewer, nodes, truncated: true }
}

interface Range {
  nodes: Node[]
  viewer: string
  truncated: boolean
}

/** Both kinds of history for one account and one date range. */
async function searchRange(account: string, from: number, to: number): Promise<{ authored: Range; reviewed: Range }> {
  const range = `${new Date(from).toISOString().slice(0, 10)}..${new Date(to).toISOString().slice(0, 10)}`
  const [authored, reviewed] = await Promise.all([
    searchAll(account, `is:pr is:merged author:@me merged:${range}`),
    searchAll(account, `is:pr reviewed-by:@me -author:@me updated:${range}`)
  ])
  return { authored, reviewed }
}

const keyOf = (n: Node): string => `${n.repository.nameWithOwner}#${n.number}`

/** Fold one date range of an account's GitHub history into what is already stored for it. */
async function mergeRange(account: string, state: Performance, from: number, to: number, horizonIso: string): Promise<Performance> {
  const { authored, reviewed } = await searchRange(account, from, to)
  const me = authored.viewer || reviewed.viewer

  const merged = new Map<string, MergedPr>(state.merged.map((m) => [m.key, m]))
  for (const n of authored.nodes) {
    if (!n.mergedAt) continue
    merged.set(keyOf(n), {
      key: keyOf(n),
      title: n.title,
      url: n.url,
      createdAt: n.createdAt,
      mergedAt: n.mergedAt,
      additions: n.additions,
      deletions: n.deletions,
      firstReviewAt:
        n.reviews.nodes
          .filter((r) => r.submittedAt && r.author && r.author.login !== me)
          .map((r) => r.submittedAt!)
          .sort()[0] ?? null
    })
  }

  // A refetched pull request replaces everything we had recorded for it.
  const refetched = new Set(reviewed.nodes.map(keyOf))
  const reviews: ReviewGiven[] = state.reviews.filter((r) => !refetched.has(r.key))
  for (const n of reviewed.nodes) {
    const mine = n.reviews.nodes
      .filter((r) => r.submittedAt && r.author?.login === me)
      .sort((a, b) => a.submittedAt!.localeCompare(b.submittedAt!))
    mine.forEach((r, i) => {
      let responseHours: number | null = null
      if (i === 0) {
        // Clock starts when you were asked; if you were never explicitly asked, when the PR opened.
        const asked = n.timelineItems.nodes
          .filter((t) => t.createdAt && t.requestedReviewer?.login === me && t.createdAt <= r.submittedAt!)
          .map((t) => t.createdAt!)
          .sort()
          .pop()
        responseHours = (new Date(r.submittedAt!).getTime() - new Date(asked ?? n.createdAt).getTime()) / 3_600_000
      }
      reviews.push({
        key: keyOf(n),
        title: n.title,
        url: n.url,
        author: n.author?.login ?? 'ghost',
        submittedAt: r.submittedAt!,
        state: r.state,
        responseHours
      })
    })
  }

  return {
    ...state,
    merged: [...merged.values()].filter((m) => m.mergedAt >= horizonIso),
    reviews: reviews.filter((r) => r.submittedAt >= horizonIso),
    truncated: state.truncated || authored.truncated || reviewed.truncated
  }
}

/** Fold one date range of an account's commits into what is already stored for it. */
async function mergeCommits(account: string, state: Performance, from: number, to: number, horizonIso: string): Promise<Performance> {
  const found = await searchCommits(account, from, to)
  const bySha = new Map(state.commits.map((c) => [c.sha, c]))
  for (const c of found.commits) bySha.set(c.sha, c)
  return {
    ...state,
    commits: [...bySha.values()].filter((c) => c.committedAt >= horizonIso),
    truncated: state.truncated || found.truncated
  }
}

const horizonOf = (now: number): number => now - WEEKS * 7 * DAY
const reaches = (since: string | undefined, now: number): boolean =>
  !!since && new Date(since).getTime() <= horizonOf(now) + 2 * DAY
const isComplete = (s: Performance, now: number): boolean => reaches(s.since, now) && reaches(s.commitsSince, now)

/** performance.json: every account's history, by login. */
interface HistoryFile {
  version: 2
  accounts: Record<string, Performance>
}

/**
 * The file as it is now, whatever shape it was saved in. Before accounts were kept apart it held
 * one history: the original account's, or for a short while two accounts' mixed together with
 * each entry saying whose it was. Either way each account ends up with its own.
 */
function readHistory(): HistoryFile {
  const raw = readJson<(Partial<HistoryFile> & Partial<Performance> & { accounts?: unknown }) | null>('performance.json', null)
  if (!raw) return { version: 2, accounts: {} }
  if (raw.version === 2 && raw.accounts && !Array.isArray(raw.accounts)) return { version: 2, accounts: raw.accounts as Record<string, Performance> }
  if (!raw.fetchedAt || !Array.isArray(raw.merged)) return { version: 2, accounts: {} }
  const old = raw as Performance
  type Tagged = { account?: string }
  const logins = Array.isArray(raw.accounts) ? (raw.accounts as string[]) : []
  const original = originalAccount()
  const owners = logins.length ? logins : original ? [original] : []
  // Two accounts mixed together without saying whose each entry is cannot be told apart; GitHub has it all, so it is fetched again.
  if (owners.length > 1 && [...old.merged, ...(old.reviews ?? []), ...(old.commits ?? [])].some((x) => !(x as Tagged).account))
    return { version: 2, accounts: {} }
  const whose = (x: Tagged): string | undefined => x.account ?? (owners.length === 1 ? owners[0] : original)
  const strip = <T extends Tagged>(x: T): T => {
    const { account: _owner, ...rest } = x
    return rest as T
  }
  return {
    version: 2,
    accounts: Object.fromEntries(
      owners.map((login) => [
        login,
        {
          ...old,
          merged: (old.merged as (MergedPr & Tagged)[]).filter((x) => whose(x) === login).map(strip),
          reviews: ((old.reviews ?? []) as (ReviewGiven & Tagged)[]).filter((x) => whose(x) === login).map(strip),
          commits: ((old.commits ?? []) as (Performance['commits'][number] & Tagged)[]).filter((x) => whose(x) === login).map(strip),
          snapshots: []
        }
      ])
    )
  }
}

// History saved before commits were tracked has no commit list yet.
const stored = (account: string): Performance | null => {
  const s = readHistory().accounts[account]
  return s ? { ...s, commits: s.commits ?? [] } : null
}
/** Reads and writes in one step, so two accounts saving at once never lose each other's history. */
const save = (account: string, s: Performance): Performance => {
  const file = readHistory()
  file.accounts[account] = { ...s, snapshots: [], partial: undefined }
  writeJson('performance.json', file)
  return s
}

/** How much of the saved history is one account's, for the storage page. */
export const historyBytes = (account: string): number => {
  const s = readHistory().accounts[account]
  return s ? Buffer.byteLength(JSON.stringify(s)) : 0
}

// One GitHub history job at a time per account, so two of them never overwrite each other's saved result.
const serial = keyedQueue()

/** Bring an account's stored history up to date with what changed since the last fetch (or the last four weeks, the first time). */
function refreshRecent(account: string): Promise<Performance> {
  return serial(account, async () => {
    const now = Date.now()
    const horizonIso = new Date(horizonOf(now)).toISOString()
    const cached = stored(account)
    const from = cached
      ? Math.max(horizonOf(now), new Date(cached.fetchedAt).getTime() - 2 * DAY)
      : now - CHUNK_DAYS * DAY
    const base: Performance = cached ?? {
      fetchedAt: new Date(now).toISOString(),
      since: new Date(from).toISOString(),
      merged: [],
      reviews: [],
      commits: [],
      snapshots: [],
      truncated: false
    }
    // Commits joined the history later, so they may start from nothing while the rest is a year deep.
    const commitsFrom = base.commitsSince ? from : now - CHUNK_DAYS * DAY
    const state = await mergeCommits(account, await mergeRange(account, base, from, now + DAY, horizonIso), commitsFrom, now + DAY, horizonIso)
    return save(account, {
      ...state,
      commitsSince: base.commitsSince ?? new Date(commitsFrom).toISOString(),
      fetchedAt: new Date(now).toISOString(),
      since: state.since < horizonIso ? horizonIso : state.since
    })
  })
}

/**
 * Older months are fetched in the background, newest first, saving after each one. An interruption
 * (a rate limit, quitting the app) loses nothing: the next run continues from the last saved month.
 */
const backfilling = new Set<string>()
function startBackfill(account: string): void {
  if (backfilling.has(account)) return
  backfilling.add(account)
  void (async () => {
    try {
      for (;;) {
        const done = await serial(account, async () => {
          const now = Date.now()
          const state = stored(account)
          if (!state || isComplete(state, now)) return true
          const horizonIso = new Date(horizonOf(now)).toISOString()
          if (!reaches(state.since, now)) {
            const since = new Date(state.since).getTime()
            const from = Math.max(horizonOf(now), since - CHUNK_DAYS * DAY)
            const next = await mergeRange(account, state, from, since + DAY, horizonIso)
            save(account, { ...next, since: new Date(from).toISOString() })
          } else {
            const since = new Date(state.commitsSince ?? now).getTime()
            const from = Math.max(horizonOf(now), since - CHUNK_DAYS * DAY)
            const next = await mergeCommits(account, state, from, since + DAY, horizonIso)
            save(account, { ...next, commitsSince: new Date(from).toISOString() })
          }
          return false
        })
        if (done) break
      }
    } catch (e) {
      console.error(`history backfill for ${account} interrupted, will continue next time:`, e)
    } finally {
      backfilling.delete(account)
    }
  })()
}

const refreshing = new Map<string, Promise<Performance>>()

/** One account's history: its merged pull requests, reviews and commits, and its daily snapshots. */
export async function getPerformance(account: string, force: boolean): Promise<Performance> {
  const snapshots = snapshotsOf(account)
  let state = stored(account)
  const fresh = !!state && Date.now() - new Date(state.fetchedAt).getTime() < FRESH_MS
  if (!state || force || !fresh) {
    try {
      state = await shared(refreshing, account, () => refreshRecent(account))
    } catch (e) {
      if (!state) throw e
      console.error('could not refresh recent history, showing what is stored:', e)
    }
  }
  const complete = isComplete(state, Date.now())
  if (!complete) startBackfill(account)
  return { ...state, snapshots, partial: !complete }
}

/**
 * Clears one account's stored history; other accounts keep theirs. Waits for any GitHub job of that
 * account in flight, so it cannot write the history back afterwards.
 */
export function clearHistory(account: string, name: 'performance.json' | 'snapshots.json'): Promise<void> {
  return serial(account, async () => {
    if (name === 'performance.json') {
      const file = readHistory()
      delete file.accounts[account]
      return writeJson('performance.json', file)
    }
    // Snapshots cannot be fetched again: the account's counts are taken out of each day, the file
    // is written (never deleted), and what was there stays in the backups.
    const days = storedSnapshots()
      .map((s) => {
        if (!s.byAccount?.[account]) return s
        const { [account]: _gone, ...rest } = s.byAccount
        return { ...s, byAccount: rest }
      })
      .filter((s) => !s.byAccount || Object.keys(s.byAccount).length > 0)
    writeStore('snapshots.json', days)
  })
}
