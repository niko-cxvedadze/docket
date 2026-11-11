import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { Level, MergedStackPr, PrList, PrSummary, ReviewProgress } from '../../shared/types'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { ago } from './util'
import { ExternalLink, GitBranch, GitMerge, Image as ImageIcon, Layers, Link2, LoaderCircle, Pin, Video, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { preload, preloadTop } from './prCache'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { StatusIcons } from './StatusIcons'
import { Author } from './Author'
import { groupStacks, type Group } from './stacks'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cleanError } from './util'
import { applyFilters, FilterBar, isFiltering, loadFilters, saveFilters } from './Filters'

interface Props {
  list: PrList
  progress: Record<string, ReviewProgress>
  onOpen: (pr: PrSummary) => void
}

const EDGE: Record<Level, string> = {
  action: 'bg-action',
  ready: 'bg-ready',
  waiting: 'bg-transparent'
}
const REASON: Record<Level, string> = {
  action: 'text-action font-semibold',
  ready: 'text-ready font-semibold',
  waiting: 'text-muted-foreground font-medium'
}

/** A part of a stack that has already merged: shown quietly, for how far the stack has come. Opens on GitHub. */
function MergedRow({ pr, position }: { pr: MergedStackPr; position: number }) {
  const open = (): void => void window.api.openExternal(pr.url)
  return (
    <li className="min-w-0">
      <Card
        onClick={open}
        className="group relative cursor-pointer flex-row items-center gap-4 rounded-md bg-transparent py-2 pr-3.5 pl-5 opacity-75 shadow-none transition-colors hover:border-muted-foreground/60 hover:opacity-100"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-tint text-[11px] font-semibold text-primary tabular-nums">
              {position}
            </span>
          </TooltipTrigger>
          <TooltipContent>Number {position} in the stack, merged into {pr.baseRef}</TooltipContent>
        </Tooltip>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <Button
            variant="ghost"
            className="h-auto min-w-0 shrink justify-start rounded-none p-0 text-left text-sm font-medium text-muted-foreground hover:bg-transparent hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation()
              open()
            }}
          >
            <span className="min-w-0 truncate">{pr.title}</span>
          </Button>
          <div className="flex min-w-0 items-baseline gap-x-2.5 overflow-hidden text-xs text-muted-foreground">
            <span className="inline-flex shrink-0 items-center gap-1 self-center font-semibold text-primary">
              <GitMerge className="size-3" aria-hidden />
              Merged
            </span>
            <span className="shrink-0 font-mono" title={pr.key}>
              {pr.key.split('/')[1]}
            </span>
            <span className="shrink-0">{ago(pr.mergedAt)}</span>
            <span className="shrink-0">
              <span className="text-ready">+{pr.additions}</span> <span className="text-danger">−{pr.deletions}</span>
            </span>
          </div>
        </div>
        <ExternalLink className="size-4 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" aria-hidden />
      </Card>
    </li>
  )
}

/** Copy pull requests as titled links, or a pull request's branch name. `what` names them for the confirmation. */
type Copy = (prs: PrSummary[], what: 'link' | 'stack' | 'selection' | 'branch') => void

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Two versions for the clipboard. Slack and other rich editors take the HTML one and paste each
 * title as a link; plain-text fields get "Title: URL" lines. A stack is numbered in merge order.
 */
function linksFor(prs: PrSummary[], numbered: boolean): { text: string; html: string } {
  const anchor = (p: PrSummary): string => `<a href="${escapeHtml(p.url)}">${escapeHtml(p.title)}</a>`
  const text = prs.map((p, i) => `${numbered ? `${i + 1}. ` : ''}${p.title}: ${p.url}`).join('\n')
  if (prs.length === 1) return { text, html: anchor(prs[0]) }
  const tag = numbered ? 'ol' : 'ul'
  return { text, html: `<${tag}>${prs.map((p) => `<li>${anchor(p)}</li>`).join('')}</${tag}>` }
}

/** One of the small actions at the right of a row. Clicks stay on the button and do not open the row. */
function RowAction({
  Icon,
  label,
  tip,
  active,
  pressed,
  onClick
}: {
  Icon: LucideIcon
  label: string
  tip: string
  active?: boolean
  pressed?: boolean
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn('size-6 shrink-0 hover:text-foreground', active ? 'text-primary' : 'text-muted-foreground')}
          aria-label={label}
          aria-pressed={pressed}
          onClick={(e) => {
            e.stopPropagation()
            onClick()
          }}
        >
          <Icon className={active ? 'fill-current' : ''} aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  )
}

function Row({
  pr,
  progress,
  onOpen,
  position,
  selected,
  onToggle,
  pinned,
  onPin,
  onCopy
}: {
  pr: PrSummary
  progress?: ReviewProgress
  onOpen: () => void
  pinned: boolean
  /** Pin this pull request to the top of its column, or unpin it. */
  onPin: () => void
  selected: boolean
  /** Add or remove this pull request from the selection (Cmd-click). */
  onToggle: () => void
  onCopy: Copy
  /** Place in its stack, counting from the pull request that merges first. */
  position?: number
}) {
  const [first, ...rest] = pr.reasons
  // Resting on a row for a moment starts loading its page, so the click opens it at once.
  const hover = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startPreload = (): void => {
    hover.current ??= setTimeout(() => preload(pr), 150)
  }
  const stopPreload = (): void => {
    if (hover.current) clearTimeout(hover.current)
    hover.current = null
  }
  return (
    <li className="min-w-0" onMouseEnter={startPreload} onMouseLeave={stopPreload} onFocus={() => preload(pr)}>
      {/*
        Title and why it is listed on the left; its standing as icons on the right. The whole card
        takes clicks, but the title is the real button, so the keyboard and screen readers land on
        one control and the small actions beside it are not nested inside another button.
      */}
      <Card
        data-pr-key={pr.key}
        data-selected={selected || undefined}
        onClick={(e) => (e.metaKey || e.ctrlKey ? onToggle() : onOpen())}
        className={cn(
          'group @container relative cursor-pointer flex-row items-center gap-4 rounded-md py-2.5 pr-3.5 pl-5 shadow-none transition-colors hover:border-muted-foreground/60',
          'has-[[data-slot=row-title]:focus-visible]:border-ring has-[[data-slot=row-title]:focus-visible]:ring-[3px] has-[[data-slot=row-title]:focus-visible]:ring-ring/50',
          pr.level === 'waiting' && 'bg-transparent',
          selected && 'border-primary bg-tint hover:border-primary'
        )}
      >
        {/* A slim bar inside the card says how urgent it is, without bending around the corners. */}
        <span
          aria-hidden
          className={cn(
            'absolute inset-y-2.5 left-2 w-[3px] rounded-full',
            pr.ciBlocksMerge && pr.role === 'mine' ? 'bg-danger' : EDGE[pr.level]
          )}
        />
        {position !== undefined && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold text-muted-foreground tabular-nums">
                {position}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              Number {position} in the stack, on top of {pr.baseRef}
            </TooltipContent>
          </Tooltip>
        )}
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
            <Button
              variant="ghost"
              data-slot="row-title"
              aria-pressed={selected}
              // buttonVariants says shrink-0; this one must shrink so a long title truncates before the badge does.
              className="h-auto min-w-0 shrink justify-start rounded-none p-0 text-left text-sm font-medium hover:bg-transparent hover:text-foreground focus-visible:border-transparent focus-visible:ring-0"
              onKeyDown={(e) => {
                if (e.key === 'x') onToggle()
                else if (e.key === 'p') onPin()
                else if (e.key === 'o') void window.api.openExternal(pr.url)
                else if (e.key === 'b') onCopy([pr], 'branch')
              }}
            >
              <span className="min-w-0 truncate">{pr.title}</span>
            </Button>
            {pr.preview && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-tint px-1.5 py-px text-[11px] font-semibold text-primary">
                    {pr.preview === 'video' ? <Video className="size-3" aria-hidden /> : <ImageIcon className="size-3" aria-hidden />}
                    {pr.preview === 'video' ? 'Video' : 'Images'}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {pr.preview === 'video' ? 'The description has a video of the change' : 'The description has screenshots'}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          <div className="flex min-w-0 items-baseline gap-x-2.5 overflow-hidden text-xs text-muted-foreground">
            {/* The reason is a few words and never cut short; what follows gives way first when the row is narrow. */}
            {first && (
              <span
                className={cn('shrink-0', first.failing ? 'font-semibold text-danger' : REASON[first.level])}
                title={pr.reasons.map((r) => r.text).join('\n')}
              >
                {first.short ?? first.text}
                {rest.length > 0 && ` +${rest.length}`}
              </span>
            )}
            {pr.role === 'review' && <Author author={pr.author} className="shrink-0 self-center" />}
            <span className="shrink-0 font-mono" title={`${pr.repo}#${pr.number}`}>
              {pr.repo.split('/')[1]}#{pr.number}
            </span>
            <span className="shrink-0">{ago(pr.updatedAt)}</span>
            <span className="shrink-0">
              <span className="text-ready">+{pr.additions}</span> <span className="text-danger">−{pr.deletions}</span>
            </span>
          </div>
        </div>
        <StatusIcons pr={pr} progress={progress} />
        <div className="-ml-2 flex shrink-0 items-center gap-0.5">
          <RowAction
            Icon={Pin}
            active={pinned}
            pressed={pinned}
            label={`${pinned ? 'Unpin' : 'Pin'} ${pr.title}`}
            tip={pinned ? 'Unpin (P)' : 'Pin to the top of this column (P)'}
            onClick={onPin}
          />
          <RowAction
            Icon={Link2}
            label={`Copy link to ${pr.title}`}
            tip="Copy link (⌘C). ⌘-click rows to select several."
            onClick={() => onCopy([pr], 'link')}
          />
          <RowAction
            Icon={GitBranch}
            label={`Copy branch name of ${pr.title}`}
            tip={`Copy branch ${pr.headRef} (B)`}
            onClick={() => onCopy([pr], 'branch')}
          />
          <RowAction
            Icon={ExternalLink}
            label={`Open ${pr.title} on GitHub`}
            tip="Open on GitHub (O)"
            onClick={() => void window.api.openExternal(pr.url)}
          />
        </div>
      </Card>
    </li>
  )
}

/** Grey stand-ins shaped like rows, while more pull requests load. */
function RowSkeletons({ count = 4 }: { count?: number }) {
  return (
    <ul className="mt-1.5 grid grid-cols-1 gap-1.5" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="flex items-center gap-4 rounded-md border px-5 py-3" style={{ opacity: 1 - i * 0.18 }}>
          <div className="grid flex-1 gap-2">
            <Skeleton className="h-3.5" style={{ width: `${70 - i * 9}%` }} />
            <Skeleton className="h-3 w-2/5" />
          </div>
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-20" />
        </li>
      ))}
    </ul>
  )
}

function Column({
  title,
  prs,
  emptyText,
  quietTitle = 'Waiting on someone else',
  controls,
  progress,
  onOpen,
  selection,
  onToggle,
  pins,
  onPin,
  onCopy,
  hiddenNeeds = 0,
  loading
}: {
  pins: Set<string>
  onPin: (pr: PrSummary) => void
  title: string
  prs: PrSummary[]
  emptyText: string
  quietTitle?: string
  /** Shown at the right of the heading, e.g. a switch between views of this column. */
  controls?: React.ReactNode
  progress: Props['progress']
  onOpen: Props['onOpen']
  selection: Set<string>
  onToggle: (pr: PrSummary) => void
  onCopy: Copy
  /** Pull requests that need you but are hidden by the filters. */
  hiddenNeeds?: number
  /** More pull requests are on their way: say so, and hold their place with placeholder rows. */
  loading?: string
}) {
  const needs = prs.filter((p) => p.level !== 'waiting')
  // Stacked pull requests are kept together; a stack sits with whichever of its members is most urgent.
  const groups = useMemo(() => groupStacks(prs), [prs])
  // Pinning any pull request of a stack pins the stack, so a stack is never torn apart.
  const isPinned = (g: Group): boolean => g.prs.some((p) => pins.has(p.key))
  const pinned = groups.filter(isPinned)
  const active = groups.filter((g) => !isPinned(g) && g.level !== 'waiting')
  const quiet = groups.filter((g) => !isPinned(g) && g.level === 'waiting')
  const row = (pr: PrSummary, position?: number) => (
    <Row key={pr.key} pr={pr} position={position} progress={progress[pr.key]}
      onOpen={() => onOpen(pr)}
      selected={selection.has(pr.key)}
      onToggle={() => onToggle(pr)}
      pinned={pins.has(pr.key)}
      onPin={() => onPin(pr)}
      onCopy={onCopy}
    />
  )
  const rows = (items: Group[]) => (
    <ul className="grid grid-cols-1 gap-1.5">
      {items.map((g) =>
        g.prs.length === 1 && g.merged.length === 0 ? (
          row(g.prs[0])
        ) : (
          <li key={g.key} className="min-w-0 rounded-lg border border-dashed p-1.5">
            <p className="flex items-center gap-1.5 px-1.5 pt-0.5 pb-1.5 text-xs text-muted-foreground">
              <Layers className="size-3.5" aria-hidden />
              <span className="font-semibold text-foreground">Stack of {g.merged.length + g.prs.length}</span>
              {g.merged.length > 0 && (
                <span className="shrink-0 font-medium text-primary">
                  {g.merged.length} merged
                </span>
              )}
              <span className="truncate">
                on <span className="font-mono">{g.base}</span>, merges from the bottom up
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" className="ml-auto h-6 gap-1 px-2 text-xs" onClick={() => onCopy(g.prs, 'stack')}>
                    <Link2 aria-hidden />
                    Copy stack links
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Every open pull request in this stack as titled links, in merge order (⌘⇧C on a row)</TooltipContent>
              </Tooltip>
            </p>
            {/* Shown the way GitHub shows a stack: the newest on top, the one that merges first at the bottom. */}
            <ul className="grid grid-cols-1 gap-1.5">
              {[
                ...g.merged.map((m, i) => <MergedRow key={m.key} pr={m} position={i + 1} />),
                ...g.prs.map((pr, i) => row(pr, g.merged.length + i + 1))
              ].reverse()}
            </ul>
          </li>
        )
      )}
    </ul>
  )
  return (
    <section className="min-w-0">
      <h2 className="mb-3 flex min-h-9 items-center gap-2.5 text-xl font-semibold tracking-tight">
        {title}
        <Badge variant="secondary" className={cn('rounded-full', needs.length > 0 && 'bg-action-bg text-action')}>
          {needs.length ? `${needs.length} need you` : 'nothing needs you'}
        </Badge>
        {hiddenNeeds > 0 && (
          <span className="text-xs font-normal tracking-normal text-muted-foreground">
            {hiddenNeeds} more hidden by filters
          </span>
        )}
        {loading && (
          <span className="inline-flex items-center gap-1.5 text-xs font-normal tracking-normal text-muted-foreground" role="status">
            <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
            {loading}
          </span>
        )}
        {controls && <span className="ml-auto text-sm font-normal tracking-normal">{controls}</span>}
      </h2>
      {prs.length === 0 && !loading && <p className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">{emptyText}</p>}
      {pinned.length > 0 && (
        <div className="mb-5">
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <Pin className="size-3.5" aria-hidden />
            Pinned
          </h3>
          {rows(pinned)}
        </div>
      )}
      {active.length > 0 && rows(active)}
      {quiet.length > 0 && (
        <>
          <h3 className="mt-6 mb-2 text-xs font-semibold text-muted-foreground">{quietTitle}</h3>
          {rows(quiet)}
        </>
      )}
      {loading && <RowSkeletons />}
    </section>
  )
}

const PINS_KEY = 'docket.pins'
const loadPins = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(PINS_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

type Scope = 'mine' | 'all'
const SCOPE_KEY = 'docket-review-scope'
const OPEN_STALE_MS = 5 * 60_000
// Kept outside the component so coming back from a pull request does not refetch.
let openCache: { repos: string; at: number; prs: PrSummary[]; truncated: boolean } | null = null

/** Every open pull request in the repositories you work in, fetched only while "All open" is selected. */
function useOpenPrs(list: PrList, enabled: boolean) {
  const repos = useMemo(() => [...new Set(list.prs.map((p) => p.repo))].sort(), [list.prs])
  const [state, setState] = useState<{ prs: PrSummary[]; truncated: boolean; loading: boolean; error: string | null }>({
    prs: openCache?.prs ?? [],
    truncated: openCache?.truncated ?? false,
    loading: false,
    error: null
  })
  useEffect(() => {
    if (!enabled || !repos.length) return
    const key = repos.join(',')
    // The main process keeps the list from GitHub for a few minutes and marks drafts on every answer,
    // so asking again is cheap. Asking after every dashboard refresh (which follows a finished review,
    // a post or a discard) keeps "Review drafts" right for pull requests that are only in this list.
    const fresh = openCache?.repos === key && Date.now() - openCache.at < OPEN_STALE_MS
    let cancelled = false
    if (!fresh) setState((s) => ({ ...s, loading: true, error: null }))
    window.api.listOpenPrs(repos).then(
      (r) => {
        openCache = { repos: key, at: fresh ? openCache!.at : Date.now(), ...r }
        if (!cancelled) setState({ ...r, loading: false, error: null })
      },
      (e) => !cancelled && setState((s) => ({ ...s, loading: false, error: cleanError(e) }))
    )
    return () => {
      cancelled = true
    }
    // list: a new object after every dashboard refresh, even one answered from the cache.
  }, [enabled, repos, list])
  return state
}

export function Dashboard({ list, progress, onOpen }: Props) {
  // After each refresh, quietly load the pages of the few pull requests most likely to be opened next.
  useEffect(() => {
    const t = setTimeout(() => preloadTop(list.prs), 1500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.fetchedAt])
  const [scope, setScope] = useState<Scope>(() => {
    try {
      return localStorage.getItem(SCOPE_KEY) === 'all' ? 'all' : 'mine'
    } catch {
      return 'mine'
    }
  })
  const open = useOpenPrs(list, scope === 'all')
  const [filters, setFilters] = useState(loadFilters)
  useEffect(() => saveFilters(filters), [filters])

  // "All open" adds everyone else's open pull requests to the review column; the ones that
  // involve you keep the fuller status from the main list.
  const source = useMemo(() => {
    if (scope === 'mine') return list.prs
    const known = new Map(list.prs.map((p) => [p.key, p]))
    const fetched = new Set(open.prs.map((p) => p.key))
    const order = { action: 0, ready: 1, waiting: 2 }
    const review = [
      ...open.prs.filter((p) => known.get(p.key)?.role !== 'mine').map((p) => known.get(p.key) ?? p),
      ...list.prs.filter((p) => p.role === 'review' && !fetched.has(p.key))
    ].sort((a, b) => order[a.level] - order[b.level] || b.updatedAt.localeCompare(a.updatedAt))
    return [...list.prs.filter((p) => p.role === 'mine'), ...review]
  }, [scope, list.prs, open.prs])
  const prs = useMemo(() => applyFilters(source, filters, progress), [source, filters, progress])
  const hiddenNeeds = (role: PrSummary['role']): number => {
    const count = (items: PrSummary[]): number => items.filter((p) => p.role === role && p.level !== 'waiting').length
    return count(source) - count(prs)
  }

  const [pins, setPins] = useState(loadPins)
  const togglePin = useCallback((pr: PrSummary) => {
    setPins((prev) => {
      const next = new Set(prev)
      if (!next.delete(pr.key)) next.add(pr.key)
      try {
        localStorage.setItem(PINS_KEY, JSON.stringify([...next]))
      } catch {
        /* pinned for this session only */
      }
      return next
    })
  }, [])

  const [selection, setSelection] = useState<Set<string>>(() => new Set())
  const copy = useCallback<Copy>((items, what) => {
    if (!items.length) return
    if (what === 'branch') {
      const branch = items[0].headRef
      void window.api.copyText(branch).then(
        () => toast.success('Copied branch name', { description: branch }),
        (e) => toast.error('Could not copy', { description: cleanError(e) })
      )
      return
    }
    const { text, html } = linksFor(items, what === 'stack')
    void window.api.copyText(text, html).then(
      () => {
        toast.success(
          what === 'stack'
            ? `Copied ${items.length} stack links`
            : items.length === 1
              ? 'Copied link'
              : `Copied ${items.length} links`,
          { description: items.length === 1 ? items[0].title : 'Paste into Slack or a document as titled links.' }
        )
        // The selection was only made to copy it, so it is done once the links are on the clipboard.
        if (what === 'selection') setSelection(new Set())
      },
      (e) => toast.error('Could not copy', { description: cleanError(e) })
    )
  }, [])
  const toggle = useCallback((pr: PrSummary) => {
    setSelection((prev) => {
      const next = new Set(prev)
      if (!next.delete(pr.key)) next.add(pr.key)
      return next
    })
  }, [])
  const selectedPrs = useMemo(() => prs.filter((p) => selection.has(p.key)), [prs, selection])
  // The stack each pull request belongs to, worked out per column the same way the columns draw them.
  const stackOf = useMemo(() => {
    const map = new Map<string, PrSummary[]>()
    for (const role of ['mine', 'review'] as const)
      for (const g of groupStacks(prs.filter((p) => p.role === role)))
        if (g.prs.length > 1) for (const p of g.prs) map.set(p.key, g.prs)
    return map
  }, [prs])

  // Cmd-C copies the selected links (or the focused row's); Cmd-Shift-C copies the focused row's whole stack.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && selection.size) return setSelection(new Set())
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'c') return
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return
      if (window.getSelection()?.toString()) return // let ordinary text copying through
      const focused = el?.closest<HTMLElement>('[data-pr-key]')?.dataset.prKey
      if (e.shiftKey) {
        const key = focused ?? selectedPrs[0]?.key
        const stack = key ? stackOf.get(key) : undefined
        if (!stack) return
        e.preventDefault()
        copy(stack, 'stack')
      } else if (selectedPrs.length) {
        e.preventDefault()
        copy(selectedPrs, 'selection')
      } else if (focused) {
        const pr = prs.find((p) => p.key === focused)
        if (!pr) return
        e.preventDefault()
        copy([pr], 'link')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selection, selectedPrs, stackOf, prs, copy])
  const filtering = isFiltering(filters)
  const changeScope = (next: string): void => {
    const value: Scope = next === 'all' ? 'all' : 'mine'
    setScope(value)
    try {
      localStorage.setItem(SCOPE_KEY, value)
    } catch {
      /* remembered for this session only */
    }
  }
  return (
    <main className="flex-1 overflow-x-hidden overflow-y-auto px-7 pb-10">
      {/* Stays at the top while the lists scroll underneath; opaque so rows do not show through. */}
      <div className="sticky top-0 z-10 -mx-7 border-b border-border/60 bg-background px-7 pt-3 pb-3 shadow-[0_6px_10px_-8px_rgb(0_0_0/0.15)] dark:shadow-[0_6px_10px_-8px_rgb(0_0_0/0.6)]">
        <FilterBar prs={source} filters={filters} progress={progress} shown={prs.length} onChange={setFilters} />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-7 min-[1050px]:grid-cols-2">
        <Column
          title="Your pull requests"
          prs={prs.filter((p) => p.role === 'mine')}
          emptyText={filtering ? 'None of your pull requests match the filters.' : 'You have no open pull requests.'}
          hiddenNeeds={hiddenNeeds('mine')}
          progress={progress}
          onOpen={onOpen}
          selection={selection}
          onToggle={toggle}
          pins={pins}
          onPin={togglePin}
          onCopy={copy}
        />
        <div className="min-w-0">
          <Column
            title="Pull requests to review"
            prs={prs.filter((p) => p.role === 'review')}
            emptyText={
              filtering
                ? 'No pull requests to review match the filters.'
                : scope === 'all'
                  ? 'There are no other open pull requests in your repositories.'
                  : 'Nobody is waiting on a review from you.'
            }
            loading={scope === 'all' && open.loading ? 'Loading all open…' : undefined}
            quietTitle={scope === 'all' ? 'Not waiting on you' : undefined}
            hiddenNeeds={hiddenNeeds('review')}
            controls={
              <Tabs value={scope} onValueChange={changeScope}>
                <TabsList>
                  <TabsTrigger value="mine">Waiting on you</TabsTrigger>
                  <TabsTrigger value="all">All open</TabsTrigger>
                </TabsList>
              </Tabs>
            }
            progress={progress}
            onOpen={onOpen}
            selection={selection}
            onToggle={toggle}
            pins={pins}
            onPin={togglePin}
            onCopy={copy}
          />
          {scope === 'all' && (
            <div className="mt-3 text-xs text-muted-foreground">
              {open.error && <p className="text-danger">Could not load all open pull requests. {open.error}</p>}
              {open.truncated && !open.loading && (
                <p>Showing the {open.prs.length} most recently updated. Older open pull requests are on GitHub.</p>
              )}
            </div>
          )}
        </div>
      </div>

      {selectedPrs.length > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-5 z-20 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm shadow-lg" role="status">
            <span className="font-medium tabular-nums">{selectedPrs.length} selected</span>
            <Button size="sm" className="h-7 gap-1" onClick={() => copy(selectedPrs, 'selection')}>
              <Link2 aria-hidden />
              Copy links
              <kbd className="ml-1 text-[11px] opacity-70">⌘C</kbd>
            </Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setSelection(new Set())}>
              Clear
            </Button>
          </div>
        </div>
      )}
    </main>
  )
}
