import type { PrDetail, PrSummary } from '../../shared/types'

/**
 * Pull request pages, kept while the app runs so opening one again is instant. A cached page is
 * shown straight away and refreshed in the background when it is old or the pull request moved.
 * The dashboard preloads pages: the row under the mouse, and the top few that need the user.
 */

interface Entry {
  detail: PrDetail
  at: number
}

/** A page this recent is shown without asking GitHub again. */
const FRESH_MS = 30_000
/** Preloading skips pages fetched this recently, to stay well inside GitHub's limits. */
const PRELOAD_FRESH_MS = 5 * 60_000
const MAX_ENTRIES = 40
const PRELOAD_COUNT = 6

const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<PrDetail>>()

function remember(key: string, detail: PrDetail): void {
  cache.delete(key)
  cache.set(key, { detail, at: Date.now() })
  // Oldest out first: a Map keeps insertion order.
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!)
}

/** What is cached for a pull request, without fetching. */
export const peekDetail = (key: string): PrDetail | null => cache.get(key)?.detail ?? null

/** Whether the cached page is recent and still for the commit GitHub last reported. */
export function isFresh(pr: PrSummary, maxAge = FRESH_MS): boolean {
  const hit = cache.get(pr.key)
  return !!hit && Date.now() - hit.at < maxAge && (!pr.headSha || hit.detail.headSha === pr.headSha)
}

/** Fetches the page (sharing a fetch already under way) and caches it. */
export function fetchDetail(pr: PrSummary): Promise<PrDetail> {
  const running = inflight.get(pr.key)
  if (running) return running
  const p = window.api
    .prDetail(pr.account, pr.repo, pr.number)
    .then((d) => {
      remember(pr.key, d)
      return d
    })
    .finally(() => inflight.delete(pr.key))
  inflight.set(pr.key, p)
  return p
}

/** Starts loading a page in the background unless it is already fresh. Errors are ignored here. */
export function preload(pr: PrSummary, maxAge = PRELOAD_FRESH_MS): void {
  if (isFresh(pr, maxAge) || inflight.has(pr.key)) return
  fetchDetail(pr).catch(() => undefined)
}

let queue: Promise<void> = Promise.resolve()

/** Preloads the most urgent pull requests one after another, so the first clicks open instantly. */
export function preloadTop(prs: PrSummary[]): void {
  const order = { action: 0, ready: 1, waiting: 2 }
  const top = prs
    .filter((p) => p.level !== 'waiting')
    .sort((a, b) => order[a.level] - order[b.level] || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, PRELOAD_COUNT)
  for (const pr of top)
    queue = queue.then(() => (isFresh(pr, PRELOAD_FRESH_MS) ? undefined : fetchDetail(pr).then(() => undefined, () => undefined)))
}

// ---------- Highlighted diffs ----------
// Colouring a large diff is the slow part of drawing a page, so the result is kept per file version.

const highlighted = new Map<string, string[]>()
const MAX_HIGHLIGHTED = 400

export function cachedHighlight(key: string, make: () => string[]): string[] {
  const hit = highlighted.get(key)
  if (hit) return hit
  const html = make()
  highlighted.set(key, html)
  while (highlighted.size > MAX_HIGHLIGHTED) highlighted.delete(highlighted.keys().next().value!)
  return html
}
