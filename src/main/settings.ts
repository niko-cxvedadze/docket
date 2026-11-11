import { readFileSync } from 'node:fs'
import { readStore, writeStore } from './persist'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { EFFORTS, SUMMARY_LENGTHS, VERBOSITIES, type Effort, type Settings, type SummaryLength, type Verbosity } from '../shared/types'

const MAX_GUIDE_CHARS = 8000
let settings: Settings | null = null

/** Fills in defaults and drops anything unexpected, for both the file on disk and what the window sends. */
function normalise(raw: unknown): Settings {
  const voice = ((raw as Partial<Settings> | null)?.voice ?? {}) as Partial<Settings['voice']>
  const options = (o: unknown): Settings['review'] => {
    const r = (o ?? {}) as Partial<Settings['review']>
    return {
      // The model name goes on a command line, so only what a model name can contain is kept.
      model: typeof r.model === 'string' && /^[\w.[\]-]{1,80}$/.test(r.model) ? r.model : '',
      effort: EFFORTS.includes(r.effort as Effort) ? (r.effort as Effort) : '',
      verbosity: VERBOSITIES.includes(r.verbosity as Verbosity) ? (r.verbosity as Verbosity) : 'normal'
    }
  }
  return {
    voice: {
      enabled: voice.enabled !== false,
      guide: typeof voice.guide === 'string' ? voice.guide.slice(0, MAX_GUIDE_CHARS) : '',
      learnedAt: typeof voice.learnedAt === 'string' ? voice.learnedAt : undefined,
      learnedFrom: typeof voice.learnedFrom === 'number' ? voice.learnedFrom : undefined,
      summaryLength: SUMMARY_LENGTHS.includes(voice.summaryLength as SummaryLength) ? (voice.summaryLength as SummaryLength) : 'concise'
    },
    review: options((raw as Partial<Settings> | null)?.review),
    chat: options((raw as Partial<Settings> | null)?.chat)
  }
}

/**
 * What a review runs with when nothing is chosen here: the model and effort set in the user's own
 * Claude Code settings, which is the only settings file reviews load. Empty when it does not say.
 */
export function reviewDefaults(): { model: string; effort: string } {
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    const raw = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as { model?: unknown; effortLevel?: unknown }
    return {
      model: typeof raw.model === 'string' ? raw.model : '',
      effort: typeof raw.effortLevel === 'string' ? raw.effortLevel : ''
    }
  } catch {
    return { model: '', effort: '' }
  }
}

export function getSettings(): Settings {
  if (settings) return settings
  settings = normalise(readStore<unknown>('settings.json', null))
  return settings
}

export function saveSettings(next: Settings): Settings {
  settings = normalise(next)
  writeStore('settings.json', settings, true)
  return settings
}
