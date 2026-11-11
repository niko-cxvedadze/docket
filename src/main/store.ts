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
