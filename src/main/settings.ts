import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { EFFORTS, VERBOSITIES, type Effort, type Settings, type Verbosity } from '../shared/types'

const MAX_GUIDE_CHARS = 8000
const file = (): string => join(app.getPath('userData'), 'settings.json')
let settings: Settings | null = null

/** Fills in defaults and drops anything unexpected, for both the file on disk and what the window sends. */
function normalise(raw: unknown): Settings {
  const voice = ((raw as Partial<Settings> | null)?.voice ?? {}) as Partial<Settings['voice']>
  const review = ((raw as Partial<Settings> | null)?.review ?? {}) as Partial<Settings['review']>
  return {
    voice: {
      enabled: voice.enabled !== false,
      guide: typeof voice.guide === 'string' ? voice.guide.slice(0, MAX_GUIDE_CHARS) : '',
      learnedAt: typeof voice.learnedAt === 'string' ? voice.learnedAt : undefined,
      learnedFrom: typeof voice.learnedFrom === 'number' ? voice.learnedFrom : undefined
    },
    review: {
      // The model name goes on a command line, so only what a model name can contain is kept.
      model: typeof review.model === 'string' && /^[\w.[\]-]{1,80}$/.test(review.model) ? review.model : '',
      effort: EFFORTS.includes(review.effort as Effort) ? (review.effort as Effort) : '',
      verbosity: VERBOSITIES.includes(review.verbosity as Verbosity) ? (review.verbosity as Verbosity) : 'normal'
    }
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
  try {
    settings = normalise(JSON.parse(readFileSync(file(), 'utf8')))
  } catch {
    settings = normalise(null)
  }
  return settings
}

export function saveSettings(next: Settings): Settings {
  settings = normalise(next)
  mkdirSync(app.getPath('userData'), { recursive: true })
  const tmp = `${file()}.tmp`
  writeFileSync(tmp, JSON.stringify(settings, null, 2))
  renameSync(tmp, file())
  return settings
}
