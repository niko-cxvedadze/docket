import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import type { Account, PrList } from '../../shared/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cleanError, recall, remember } from './util'

/** A GitHub account's profile picture, straight from its login. */
const accountAvatar = (login: string): string => `https://github.com/${encodeURIComponent(login)}.png?size=80`

const SCOPE_KEY = 'docket.account'

/** The account the app was last showing, if it was ever chosen. */
export const loadScope = (): string | null => recall(SCOPE_KEY) || null
export const saveScope = (account: string): void => remember(SCOPE_KEY, account)

/** One choice in the rail: a picture, a short name under it, and how many pull requests need the user there. */
function Tile({
  selected,
  onClick,
  label,
  tip,
  needs,
  children
}: {
  selected: boolean
  onClick: () => void
  label: string
  tip: string
  needs: number
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          aria-pressed={selected}
          onClick={onClick}
          className="group relative h-auto w-full flex-col gap-1 rounded-lg px-1 py-1.5 font-normal hover:bg-transparent"
        >
          <span
            className={cn(
              'relative flex size-9 items-center justify-center rounded-[10px] bg-secondary text-muted-foreground ring-2 ring-offset-2 ring-offset-card transition-shadow',
              selected ? 'text-foreground ring-primary' : 'ring-transparent group-hover:ring-border'
            )}
          >
            {children}
            {needs > 0 && (
              <span className="absolute -top-1.5 -right-1.5 min-w-[18px] rounded-full bg-action px-1 text-center text-[10px] leading-[18px] font-semibold text-white tabular-nums ring-2 ring-card dark:text-black">
                {needs > 99 ? '99+' : needs}
              </span>
            )}
          </span>
          <span className={cn('w-full truncate text-center text-[10px] leading-tight', selected ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
            {label}
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{tip}</TooltipContent>
    </Tooltip>
  )
}

/** Which accounts Docket shows at all, and how to add one. Signing in stays with the gh CLI. */
function ManageAccounts({ onChanged }: { onChanged: () => void }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = (): void => {
    setError(null)
    // Asking gh afresh, so an account signed in a moment ago in a terminal is here already.
    window.api.listAccounts(true).then(
      (found) => {
        setAccounts(found)
        onChanged()
      },
      (e) => setError(cleanError(e))
    )
  }
  const toggle = async (login: string, enabled: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setAccounts(await window.api.setAccountEnabled(login, enabled))
      onChanged()
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(false)
    }
  }
  const on = accounts?.filter((a) => a.enabled).length ?? 0

  return (
    <Popover onOpenChange={(open) => open && load()}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Add or hide GitHub accounts"
              className="size-9 rounded-[10px] border border-dashed text-muted-foreground hover:text-foreground"
            >
              <Plus aria-hidden />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">Add or hide accounts</TooltipContent>
      </Tooltip>
      <PopoverContent side="right" align="start" className="w-80 p-3">
        <p className="text-sm font-medium">GitHub accounts</p>
        <p className="mt-0.5 mb-2.5 text-xs text-muted-foreground">
          Every account that is switched on gets a place in the bar on the left, with its own pull requests, drafts,
          history, voice and storage. Nothing is shared between them.
        </p>
        {!accounts && !error && <p className="py-2 text-xs text-muted-foreground">Asking gh who is signed in…</p>}
        {accounts && (
          <ul className="grid gap-0.5" aria-label="GitHub accounts">
            {accounts.map((a) => (
              <li key={a.login}>
                <Label className="flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 font-normal hover:bg-accent">
                  <img src={accountAvatar(a.login)} alt="" className="size-6 shrink-0 rounded-full bg-secondary" />
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate text-[13px] font-medium">{a.login}</span>
                    <span className={a.problem ? 'text-xs text-danger' : 'text-xs text-muted-foreground'}>
                      {a.problem ?? (a.active ? 'The one gh uses in a terminal' : 'Signed in to gh')}
                    </span>
                  </span>
                  <Switch
                    checked={a.enabled}
                    // The last one stays on: with none there would be nothing to show.
                    disabled={busy || (a.enabled && on === 1)}
                    onCheckedChange={(v) => void toggle(a.login, v)}
                    aria-label={`Show ${a.login} in Docket`}
                  />
                </Label>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="mt-2 text-xs text-danger" role="alert">
            {error}
          </p>
        )}
        <p className="mt-2.5 border-t pt-2.5 text-xs text-muted-foreground">
          To add an account, run <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">gh auth login</code> in
          a terminal and open this menu again. Docket never changes which account your terminal uses.
        </p>
      </PopoverContent>
    </Popover>
  )
}

/**
 * The bar down the left edge that says which account the app is showing. It works like switching
 * workspaces: there is always exactly one account on screen, and everything follows it: the pull
 * requests, the notifications, My performance, the reviewer voice and storage.
 */
export function AccountRail({
  list,
  scope,
  onScope,
  onChanged
}: {
  /** Every account's pull requests, for the accounts and how many need the user in each. */
  list: PrList | null
  /** The account on screen; null until the first list has arrived. */
  scope: string | null
  onScope: (account: string) => void
  /** An account was added, hidden or shown again: the list needs fetching. */
  onChanged: () => void
}) {
  const accounts = list?.accounts ?? []
  const needs = (account: string): number => (list?.prs ?? []).filter((p) => p.level !== 'waiting' && p.account === account).length

  // Cmd-1, Cmd-2, … pick an account, as they pick a workspace elsewhere.
  useEffect(() => {
    if (accounts.length < 2) return
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey || !/^[1-9]$/.test(e.key)) return
      const account = accounts[Number(e.key) - 1]
      if (!account) return
      e.preventDefault()
      onScope(account)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.join('\n'), onScope])

  return (
    <nav
      aria-label="GitHub accounts"
      // It starts under the top bar, so it never meets the window's own buttons, whatever their size.
      className="flex w-[76px] flex-none flex-col items-center gap-1 overflow-y-auto border-r bg-card px-1.5 pt-3.5 pb-3"
    >
      {accounts.map((account, i) => {
        const waiting = needs(account)
        return (
          <Tile
            key={account}
            selected={scope === account}
            onClick={() => onScope(account)}
            label={account}
            tip={`${account}${waiting ? `, ${waiting} need you` : ''}${accounts.length > 1 && i < 9 ? ` (⌘${i + 1})` : ''}`}
            needs={waiting}
          >
            <img src={accountAvatar(account)} alt="" className="size-9 rounded-[10px]" draggable={false} />
          </Tile>
        )
      })}
      <span className="mt-1.5">
        <ManageAccounts onChanged={onChanged} />
      </span>
    </nav>
  )
}
