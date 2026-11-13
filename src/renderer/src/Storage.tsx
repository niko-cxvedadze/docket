import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderOpen, RefreshCw } from 'lucide-react'
import type { PrSummary, StorageItem, StorageUsage } from '../../shared/types'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ago, cleanError, VIEWED_PREFIX } from './util'
import { toast } from 'sonner'

// Files marked as viewed are kept in the window's localStorage, one entry per pull request ever opened (see viewedKey).
const VIEWED_ID = 'local:viewed'

/** Which account's pull requests are whose, to tell marks made before accounts were kept apart. */
interface Owners {
  account: string
  /** Every account's pull requests. */
  prs: PrSummary[]
  /** The account that owns what no list shows any more: the first one. */
  first: string
}

/**
 * The storage keys holding one account's marks. A mark is saved as "<account>|<pull request>".
 * One from before accounts were kept apart names only the pull request: it is the account's that
 * lists that pull request, or the first account's when none does.
 */
function viewedKeys({ account, prs, first }: Owners): string[] {
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key?.startsWith(VIEWED_PREFIX)) continue
    const name = key.slice(VIEWED_PREFIX.length)
    const cut = name.indexOf('|')
    const owner = cut >= 0 ? name.slice(0, cut) : (prs.find((p) => p.key === name)?.account ?? first)
    if (owner === account) keys.push(key)
  }
  return keys
}

function viewedItem(owners: Owners): StorageItem {
  const keys = viewedKeys(owners)
  const count = keys.length
  const bytes = keys.reduce((n, key) => n + (key.length + (localStorage.getItem(key)?.length ?? 0)) * 2, 0) // stored as UTF-16
  return {
    id: VIEWED_ID,
    group: 'data',
    label: 'Viewed file marks',
    detail: `Which files you marked as viewed, in ${count} pull ${count === 1 ? 'request' : 'requests'}.`,
    bytes,
    clearable: count > 0
  }
}

const clearViewed = (owners: Owners): void => viewedKeys(owners).forEach((k) => localStorage.removeItem(k))

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`
}

function ClearButton({ item, busy, onClear }: { item: StorageItem; busy: boolean; onClear: () => void }) {
  const [confirming, setConfirming] = useState(false)
  if (!item.clearable) return null
  if (!confirming)
    return (
      <Button variant="outline" size="xs" disabled={busy} onClick={() => setConfirming(true)}>
        {item.group === 'repos' ? 'Delete' : 'Clear'}
      </Button>
    )
  return (
    <span className="inline-flex gap-1">
      <Button
        variant="destructive"
        size="xs"
        disabled={busy}
        onClick={() => {
          setConfirming(false)
          onClear()
        }}
      >
        {item.group === 'repos' ? 'Delete clone' : 'Clear it'}
      </Button>
      <Button variant="ghost" size="xs" disabled={busy} onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </span>
  )
}

function Section({
  title,
  note,
  items,
  busy,
  onClear,
  repos
}: {
  title: string
  note?: string
  items: StorageItem[]
  busy: string | null
  onClear: (item: StorageItem) => void
  repos?: boolean
}) {
  const sum = items.reduce((n, i) => n + i.bytes, 0)
  return (
    <section className="grid gap-2">
      <div className="flex items-baseline gap-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">{formatBytes(sum)}</span>
      </div>
      {note && <p className="max-w-[75ch] text-xs text-muted-foreground">{note}</p>}
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing here yet.</p>
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{repos ? 'Repository' : 'What'}</TableHead>
                {repos && <TableHead className="w-28">Last review</TableHead>}
                <TableHead className="w-24 text-right">Size</TableHead>
                <TableHead className="w-44" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="whitespace-normal">
                    <div className="font-medium">{item.label}</div>
                    <div className="text-xs text-muted-foreground">{item.detail}</div>
                  </TableCell>
                  {repos && (
                    <TableCell className="text-muted-foreground">{item.lastUsed ? ago(item.lastUsed) : '—'}</TableCell>
                  )}
                  <TableCell className="text-right tabular-nums">{formatBytes(item.bytes)}</TableCell>
                  <TableCell className="text-right">
                    {busy === item.id ? (
                      <span className="text-xs text-muted-foreground">Clearing…</span>
                    ) : (
                      <ClearButton item={item} busy={busy !== null} onClear={() => onClear(item)} />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}

/** What one account keeps on this computer, and below it what every account shares. */
export function Storage({
  account,
  prs,
  first,
  onChanged
}: {
  account: string
  /** Every account's pull requests, to tell whose the older viewed marks are. */
  prs: PrSummary[]
  first: string
  onChanged: () => void
}) {
  const owners = useRef<Owners>({ account, prs, first })
  owners.current = { account, prs, first }
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const u = await window.api.storageUsage(account)
      const viewed = viewedItem(owners.current)
      // localStorage lives inside Electron's own files, so take it out of that row rather than count it twice.
      const items = u.items.map((i) => (i.id === 'other' ? { ...i, bytes: Math.max(0, i.bytes - viewed.bytes) } : i))
      const at = items.findIndex((i) => i.group === 'app')
      items.splice(at < 0 ? items.length : at, 0, viewed)
      // The headline is the account's own; what every account shares is totalled in its section.
      setUsage({ ...u, total: items.reduce((n, i) => n + (i.group === 'app' ? 0 : i.bytes), 0), items })
      setError(null)
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setLoading(false)
    }
  }, [account])

  useEffect(() => void load(), [load])

  const clear = async (item: StorageItem): Promise<void> => {
    setBusy(item.id)
    setError(null)
    try {
      if (item.id === VIEWED_ID) clearViewed(owners.current)
      else await window.api.clearStorage(account, item.id)
      toast.success(`Cleared ${item.label.toLowerCase()}`, { description: `Freed ${formatBytes(item.bytes)}.` })
      if (item.id.startsWith('drafts:')) onChanged()
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(null)
      void load()
    }
  }

  const reveal = async (): Promise<void> => {
    try {
      await window.api.revealStorage()
    } catch (e) {
      setError(cleanError(e))
    }
  }

  if (!usage)
    return <main className="flex-1 px-7 pt-5 text-muted-foreground">{error ?? 'Measuring storage…'}</main>

  const of = (group: StorageItem['group']): StorageItem[] => usage.items.filter((i) => i.group === group)

  return (
    <main className="flex-1 overflow-auto px-7 pt-5 pb-10">
      <div className="mb-5 flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="mr-auto min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">
            Storage <span className="ml-2 text-base font-normal text-muted-foreground tabular-nums">{formatBytes(usage.total)}</span>
          </h1>
          <p className="mt-1 max-w-[75ch] text-sm text-muted-foreground">
            What Docket keeps on this computer for <span className="font-medium text-foreground">{account}</span>, in{' '}
            <span className="font-mono text-xs">{usage.path}</span>. Other accounts have their own, and clearing here
            never touches theirs.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void reveal()}>
            <FolderOpen aria-hidden /> Show in Finder
          </Button>
          <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load()}>
            <RefreshCw className={loading ? 'animate-spin' : ''} aria-hidden /> Measure again
          </Button>
        </div>
      </div>

      {error && (
        <div className="banner error !mx-0 !mt-0 mb-4" role="alert">
          {error}
        </div>
      )}

      <div className="grid gap-7">
        <Section
          title="Repository clones"
          note="Reviews read the code around a change from a local clone of the repository. Deleting one is safe; it is cloned again the next time you review there."
          items={of('repos')}
          busy={busy}
          onClear={(i) => void clear(i)}
          repos
        />
        <Section title="Docket data" items={of('data')} busy={busy} onClear={(i) => void clear(i)} />
        <Section
          title="Shared by every account"
          note="Not tied to an account: the settings file, and what Electron and its browser engine keep for the app itself."
          items={of('app')}
          busy={busy}
          onClear={(i) => void clear(i)}
        />
      </div>
    </main>
  )
}
