import { readStore, writeStore } from './persist'
import type { PostedReview, ReviewDraft } from '../shared/types'

// Review drafts are the user's own work: see persist.ts for how they are kept safe.
let drafts: Record<string, ReviewDraft> | null = null

function load(): Record<string, ReviewDraft> {
  drafts ??= readStore<Record<string, ReviewDraft>>('drafts.json', {})
  return drafts
}

const persist = (): void => writeStore('drafts.json', drafts, true)

export const getDraft = (key: string): ReviewDraft | null => load()[key] ?? null

export function saveDraft(draft: ReviewDraft): void {
  load()[draft.key] = draft
  persist()
}

export function discardDraft(key: string, why = 'unknown'): void {
  const had = load()[key]
  if (!had) return
  // Logged, so a draft that disappears can be traced to what removed it.
  console.warn(`draft discarded: ${key} (${why}; ${had.posted ? 'posted' : 'not posted'}, ${had.comments.length} comments)`)
  delete load()[key]
  persist()
}

// ---------- Posted reviews ----------
// Written once when a review is posted and never removed with the draft, so the history survives
// "Discard draft", "Start a new review" and a new Claude run.

let reviews: PostedReview[] | null = null
const loadReviews = (): PostedReview[] => (reviews ??= readStore<PostedReview[]>('reviews.json', []))

export function recordPostedReview(review: PostedReview): void {
  loadReviews().unshift(review)
  writeStore('reviews.json', reviews, true)
}

export const listReviews = (key: string): PostedReview[] => loadReviews().filter((r) => r.key === key)

const isPosted = (d: ReviewDraft): boolean => !!d.posted

/** How many drafts are kept, and roughly how much of drafts.json each kind takes. */
export function draftStats(): Record<'open' | 'posted', { count: number; bytes: number }> {
  const stats = { open: { count: 0, bytes: 0 }, posted: { count: 0, bytes: 0 } }
  for (const d of Object.values(load())) {
    const s = isPosted(d) ? stats.posted : stats.open
    s.count++
    s.bytes += Buffer.byteLength(JSON.stringify(d, null, 2))
  }
  return stats
}

export function clearDrafts(posted: boolean): void {
  const all = load()
  for (const [key, d] of Object.entries(all)) if (isPosted(d) === posted) delete all[key]
  persist()
}
