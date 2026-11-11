import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { graphql, searchCommits } from './github'
import type { MergedPr, Performance, PrSummary, ReviewGiven, Snapshot } from '../shared/types'

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
// GitHub cannot tell us what the queue looked like last week, so Docket writes it down as it goes.

const localDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function recordSnapshot(prs: PrSummary[]): void {
  const mine = prs.filter((p) => p.role === 'mine')
  const queue = prs.filter((p) => p.role === 'review' && p.level !== 'waiting')
  const today: Snapshot = {
    date: localDate(new Date()),
    blocked: mine.filter((p) => p.level === 'action').length,
    ready: mine.filter((p) => p.level === 'ready').length,
    reviewQueue: queue.length,
    queueLines: queue.reduce((n, p) => n + p.additions + p.deletions, 0)
  }
  const all = readJson<Snapshot[]>('snapshots.json', []).filter((s) => s.date !== today.date)
  all.push(today)
  writeJson('snapshots.json', all.slice(-730))
}

// ---------- History from GitHub ----------

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

async function searchAll(q: string): Promise<{ viewer: string; nodes: Node[]; truncated: boolean }> {
  const nodes: Node[] = []
  let after: string | null = null
  let viewer = ''
  for (let page = 0; page < MAX_PAGES; page++) {
    const data: {
      viewer: { login: string }
      search: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Node[] }
    } = await graphql(QUERY, { q, after }, { background: true })
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

/** Both kinds of history for one date range. */
async function searchRange(from: number, to: number): Promise<{ authored: Range; reviewed: Range }> {
  const range = `${new Date(from).toISOString().slice(0, 10)}..${new Date(to).toISOString().slice(0, 10)}`
  const [authored, reviewed] = await Promise.all([
    searchAll(`is:pr is:merged author:@me merged:${range}`),
    searchAll(`is:pr reviewed-by:@me -author:@me updated:${range}`)
  ])
  return { authored, reviewed }
}

const keyOf = (n: Node): string => `${n.repository.nameWithOwner}#${n.number}`

/** Fold one date range of GitHub history into what is already stored. */
async function mergeRange(state: Performance, from: number, to: number, horizonIso: string): Promise<Performance> {
  const { authored, reviewed } = await searchRange(from, to)
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

/** Fold one date range of the user's commits into what is already stored. */
async function mergeCommits(state: Performance, from: number, to: number, horizonIso: string): Promise<Performance> {
  const found = await searchCommits(from, to)
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
// History saved before commits were tracked has no commit list yet.
const stored = (): Performance | null => {
  const s = readJson<Performance | null>('performance.json', null)
  return s && { ...s, commits: s.commits ?? [] }
}
const save = (s: Performance): Performance => {
  writeJson('performance.json', { ...s, snapshots: [], partial: undefined })
  return s
}

// One GitHub history job at a time, so two of them never overwrite each other's saved result.
let chain: Promise<unknown> = Promise.resolve()
const serial = <T>(job: () => Promise<T>): Promise<T> => {
  const run = chain.then(job, job)
  chain = run.catch(() => undefined)
  return run
}

/** Bring the stored history up to date with what changed since the last fetch (or the last four weeks, the first time). */
function refreshRecent(): Promise<Performance> {
  return serial(async () => {
    const now = Date.now()
    const horizonIso = new Date(horizonOf(now)).toISOString()
    const cached = stored()
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
    const state = await mergeCommits(await mergeRange(base, from, now + DAY, horizonIso), commitsFrom, now + DAY, horizonIso)
    return save({
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
let backfilling = false
function startBackfill(): void {
  if (backfilling) return
  backfilling = true
  void (async () => {
    try {
      for (;;) {
        const done = await serial(async () => {
          const now = Date.now()
          const state = stored()
          if (!state || isComplete(state, now)) return true
          const horizonIso = new Date(horizonOf(now)).toISOString()
          if (!reaches(state.since, now)) {
            const since = new Date(state.since).getTime()
            const from = Math.max(horizonOf(now), since - CHUNK_DAYS * DAY)
            const next = await mergeRange(state, from, since + DAY, horizonIso)
            save({ ...next, since: new Date(from).toISOString() })
          } else {
            const since = new Date(state.commitsSince ?? now).getTime()
            const from = Math.max(horizonOf(now), since - CHUNK_DAYS * DAY)
            const next = await mergeCommits(state, from, since + DAY, horizonIso)
            save({ ...next, commitsSince: new Date(from).toISOString() })
          }
          return false
        })
        if (done) break
      }
    } catch (e) {
      console.error('history backfill interrupted, will continue next time:', e)
    } finally {
      backfilling = false
    }
  })()
}

let refreshing: Promise<Performance> | null = null

export async function getPerformance(force: boolean): Promise<Performance> {
  const snapshots = readJson<Snapshot[]>('snapshots.json', [])
  let state = stored()
  const fresh = !!state && Date.now() - new Date(state.fetchedAt).getTime() < FRESH_MS
  if (!state || force || !fresh) {
    refreshing ??= refreshRecent().finally(() => (refreshing = null))
    try {
      state = await refreshing
    } catch (e) {
      if (!state) throw e
      console.error('could not refresh recent history, showing what is stored:', e)
    }
  }
  const complete = isComplete(state, Date.now())
  if (!complete) startBackfill()
  return { ...state, snapshots, partial: !complete }
}

/** Delete stored history. Waits for any GitHub job in flight, so it cannot write the file back afterwards. */
export function clearHistory(name: 'performance.json' | 'snapshots.json'): Promise<void> {
  return serial(async () => rmSync(path(name), { force: true }))
}
