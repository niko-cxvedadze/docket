import { readFileSync } from 'node:fs'
import { readStore, writeStore } from './persist'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { EFFORTS, SUMMARY_LENGTHS, VERBOSITIES, type Effort, type Settings, type SummaryLength, type Verbosity } from '../shared/types'

const MAX_GUIDE_CHARS = 8000
let settings: Settings | null = null

/** Fills in defaults and drops anything unexpected, for both the file on disk and what the window sends. */
const LOGIN = /^[\w-]{1,61}$/

function voiceOf(raw: unknown): Settings['voice'] {
  const voice = (raw ?? {}) as Partial<Settings['voice']>
  return {
    enabled: voice.enabled !== false,
    guide: typeof voice.guide === 'string' ? voice.guide.slice(0, MAX_GUIDE_CHARS) : '',
    learnedAt: typeof voice.learnedAt === 'string' ? voice.learnedAt : undefined,
    learnedFrom: typeof voice.learnedFrom === 'number' ? voice.learnedFrom : undefined,
    summaryLength: SUMMARY_LENGTHS.includes(voice.summaryLength as SummaryLength) ? (voice.summaryLength as SummaryLength) : 'concise'
  }
}

function normalise(raw: unknown): Settings {
  const given = (raw ?? {}) as Partial<Settings>
  const options = (o: unknown): Settings['review'] => {
    const r = (o ?? {}) as Partial<Settings['review']>
    return {
      // The model name goes on a command line, so only what a model name can contain is kept.
      model: typeof r.model === 'string' && /^[\w.[\]-]{1,80}$/.test(r.model) ? r.model : '',
      effort: EFFORTS.includes(r.effort as Effort) ? (r.effort as Effort) : '',
      verbosity: VERBOSITIES.includes(r.verbosity as Verbosity) ? (r.verbosity as Verbosity) : 'normal'
    }
  }
  const original = given.accounts?.original
  return {
    voice: voiceOf(given.voice),
    review: options(given.review),
    chat: options(given.chat),
    // A scan is many Claude runs, so until the user chooses it does not follow the CLI's default (often the largest model).
    map: given.map ? options(given.map) : { model: 'opus', effort: 'medium', verbosity: 'normal' },
    accounts: {
      disabled: logins(given.accounts?.disabled),
      original: typeof original === 'string' && LOGIN.test(original) ? original : undefined
    },
    voices: Object.fromEntries(
      Object.entries(given.voices && typeof given.voices === 'object' ? given.voices : {})
        .filter(([login]) => LOGIN.test(login))
        .map(([login, voice]) => [login, voiceOf(voice)])
    )
  }
}

const logins = (list: unknown): string[] =>
  Array.isArray(list) ? [...new Set(list.filter((l): l is string => typeof l === 'string' && LOGIN.test(l)))] : []

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

/** Tidies, keeps and saves the settings. */
function commit(next: unknown): Settings {
  settings = normalise(next)
  writeStore('settings.json', settings, true)
  return settings
}

const patchAccounts = (patch: Partial<Settings['accounts']>): void => {
  const current = getSettings()
  commit({ ...current, accounts: { ...current.accounts, ...patch } })
}

/** Saves what the window sends. Which accounts are switched off is not its to change: see setAccountDisabled. */
export const saveSettings = (next: Settings): Settings => commit({ ...next, accounts: getSettings().accounts })

export const disabledAccounts = (): string[] => getSettings().accounts.disabled

/** The voice reviews for one account are drafted in: its own, or the one from before accounts were kept apart. */
export const voiceFor = (account: string): Settings['voice'] => getSettings().voices[account] ?? getSettings().voice

/** The account everything saved before accounts were kept apart belongs to. Unknown until gh has been asked once. */
export const originalAccount = (): string | undefined => getSettings().accounts.original

/** Noted once, the first time gh says which account it is using, and never changed after. */
export function noteOriginalAccount(login: string): void {
  if (!originalAccount()) patchAccounts({ original: login })
}

export function setAccountDisabled(login: string, disabled: boolean): void {
  const rest = disabledAccounts().filter((l) => l !== login)
  patchAccounts({ disabled: disabled ? [...rest, login] : rest })
}
