import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { ReviewDraft } from '../shared/types'

const file = (): string => join(app.getPath('userData'), 'drafts.json')
let drafts: Record<string, ReviewDraft> | null = null

function load(): Record<string, ReviewDraft> {
  if (drafts) return drafts
  try {
    drafts = JSON.parse(readFileSync(file(), 'utf8')) as Record<string, ReviewDraft>
  } catch {
    drafts = {}
  }
  return drafts
}

function persist(): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  const tmp = `${file()}.tmp`
  writeFileSync(tmp, JSON.stringify(drafts, null, 2))
  renameSync(tmp, file())
}

export const getDraft = (key: string): ReviewDraft | null => load()[key] ?? null

export function saveDraft(draft: ReviewDraft): void {
  load()[draft.key] = draft
  persist()
}

export function discardDraft(key: string): void {
  delete load()[key]
  persist()
}

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
