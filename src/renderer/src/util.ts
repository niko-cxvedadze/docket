export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  const d = Math.floor(s / 86400)
  return d < 30 ? `${d}d ago` : `${Math.floor(d / 30)}mo ago`
}

export const cleanError = (e: unknown): string =>
  (e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, '')

// ---------- What the window remembers between launches (localStorage) ----------
// It can be unavailable or full. Reading then finds nothing and writing fails quietly, so a choice
// lasts for this session only.

/** A remembered value. `oldKey` is where it was kept before, read until something is saved under `key`. */
export function recall(key: string, oldKey?: string): string | null {
  try {
    return localStorage.getItem(key) ?? (oldKey ? localStorage.getItem(oldKey) : null)
  } catch {
    return null
  }
}

/** A remembered value that was saved as JSON; `fallback` when there is none or it is not of the same kind. */
export function recallJson<T extends object>(key: string, fallback: T, oldKey?: string): T {
  try {
    const value: unknown = JSON.parse(recall(key, oldKey) ?? 'null')
    return value && typeof value === 'object' && Array.isArray(value) === Array.isArray(fallback) ? (value as T) : fallback
  } catch {
    return fallback
  }
}

export function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* remembered for this session only */
  }
}

// Files marked as viewed are remembered per pull request, under "docket.viewed.<account>|<pull request>".
// Marks from before accounts were kept apart name only the pull request.
export const VIEWED_PREFIX = 'docket.viewed.'
export const viewedKey = (account: string, key: string): string => `${VIEWED_PREFIX}${account}|${key}`

// ---------- Selecting things to copy ----------

/** The set with `key` added, or taken out when it was in it. */
export function toggled<T>(set: ReadonlySet<T>, key: T): Set<T> {
  const next = new Set(set)
  if (!next.delete(key)) next.add(key)
  return next
}

/** Whether a key press is Cmd-C meant for the page: not in a field, and with no text selected that should copy as text. */
export function isCopyKey(e: KeyboardEvent): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'c') return false
  const el = document.activeElement
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return false
  return !window.getSelection()?.toString()
}
