import { readStore, writeStore } from './persist'
import { adoptOld, ownerOf } from './accounts'
import { prId, type PostedReview, type ReviewDraft } from '../shared/types'

// Review drafts are the user's own work: see persist.ts for how they are kept safe.
//
// Each account has its own drafts. A draft is stored under "<account> <pull request key>". Drafts
// from before accounts were kept apart are stored under the pull request key alone and name no
// account; they belong to the account that lists that pull request (see legacyOwner), and move to
// the new form the first time that account's list shows the pull request, or they are saved again.
let drafts: Record<string, ReviewDraft> | null = null

function load(): Record<string, ReviewDraft> {
  drafts ??= readStore<Record<string, ReviewDraft>>('drafts.json', {})
  return drafts
}

const persist = (): void => writeStore('drafts.json', drafts, true)

/** Where an account's draft for a pull request is stored, if it has one. */
function find(account: string, key: string): string | null {
  const all = load()
  if (all[prId(account, key)]) return prId(account, key)
  const old = all[key]
  return old && !old.account && ownerOf(old) === account ? key : null
}

export function getDraft(account: string, key: string): ReviewDraft | null {
  const id = find(account, key)
  return id ? load()[id] : null
}

export function saveDraft(draft: ReviewDraft): void {
  const account = ownerOf(draft)
  // Without any account to file it under (gh never answered), it stays where old drafts are.
  if (!account) {
    load()[draft.key] = draft
    return persist()
  }
  const was = find(account, draft.key)
  if (was && was !== prId(account, draft.key)) delete load()[was]
  load()[prId(account, draft.key)] = { ...draft, account }
  persist()
}

export function discardDraft(account: string, key: string, why = 'unknown'): void {
  const id = find(account, key)
  const had = id ? load()[id] : null
  if (!id || !had) return
  // Logged, so a draft that disappears can be traced to what removed it.
  console.warn(`draft discarded: ${account} ${key} (${why}; ${had.posted ? 'posted' : 'not posted'}, ${had.comments.length} comments)`)
  delete load()[id]
  persist()
}

/**
 * Files what was saved before accounts were kept apart under the account whose list now shows its
 * pull request (`listed`: account by pull request key). Nothing is dropped: what no list shows stays
 * as it is, and counts as the original account's.
 */
export function adoptOldWork(listed: Map<string, string>): void {
  const all = load()
  let moved = false
  for (const [id, d] of Object.entries(all)) {
    const account = d.account ? undefined : listed.get(d.key)
    if (!account || id !== d.key || all[prId(account, d.key)]) continue
    delete all[id]
    all[prId(account, d.key)] = { ...d, account }
    moved = true
  }
  if (moved) persist()
  if (adoptOld(loadReviews(), listed)) writeStore('reviews.json', reviews, true)
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

export const listReviews = (account: string, key: string): PostedReview[] =>
  loadReviews().filter((r) => r.key === key && ownerOf(r) === account)

const isPosted = (d: ReviewDraft): boolean => !!d.posted

/** How many drafts one account keeps, and roughly how much of drafts.json each kind takes. */
export function draftStats(account: string): Record<'open' | 'posted', { count: number; bytes: number }> {
  const stats = { open: { count: 0, bytes: 0 }, posted: { count: 0, bytes: 0 } }
  for (const d of Object.values(load())) {
    if (ownerOf(d) !== account) continue
    const s = isPosted(d) ? stats.posted : stats.open
    s.count++
    s.bytes += Buffer.byteLength(JSON.stringify(d, null, 2))
  }
  return stats
}

/** Removes one account's drafts of one kind. Other accounts' drafts are not touched. */
export function clearDrafts(account: string, posted: boolean): void {
  const all = load()
  for (const [id, d] of Object.entries(all)) if (ownerOf(d) === account && isPosted(d) === posted) delete all[id]
  persist()
}
