import { useState } from 'react'
import { ChevronDown, EyeOff, Keyboard, Video, MessageSquareCheck, NotebookPen, Search, Users, X } from 'lucide-react'
import type { CiState, Level, PrSummary, ReviewProgress } from '../../shared/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Toggle } from '@/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** The select needs a non-empty value for "every repository". */
const ALL_REPOS = '__all__'

export interface Filters {
  query: string
  repo: string // '' means every repository
  level: Level | 'all'
  ci: CiState | 'all'
  /** Logins to show in the review column; empty means everyone. Your own pull requests are not affected. */
  authors: string[]
  hideDrafts: boolean
  /** Only pull requests with a review of yours in the works. */
  drafting: boolean
  /** Only other people's pull requests you have already left a review on. */
  reviewed: boolean
  /** Only pull requests whose description has a video or screenshots. */
  media: boolean
}

export const NO_FILTERS: Filters = { query: '', repo: '', level: 'all', ci: 'all', authors: [], hideDrafts: false, drafting: false, reviewed: false, media: false }

const STORAGE_KEY = 'docket.filters'

export function loadFilters(): Filters {
  try {
    return { ...NO_FILTERS, ...(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Filters>) }
  } catch {
    return NO_FILTERS
  }
}

export function saveFilters(f: Filters): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(f))
  } catch {
    /* filters just will not be remembered */
  }
}

export const isFiltering = (f: Filters): boolean =>
  !!f.query.trim() || !!f.repo || f.level !== 'all' || f.ci !== 'all' || f.authors.length > 0 || f.hideDrafts || f.drafting || f.reviewed || f.media

type Progress = Record<string, ReviewProgress>

/** A review is in the works when Claude is drafting it right now or a draft is saved and not yet posted. */
export const isDrafting = (p: PrSummary, progress: Progress): boolean =>
  progress[p.key]?.state === 'running' || p.draftState === 'draft' || p.draftState === 'stale'

/** You already left a review: submitted on GitHub by any route, or posted from a Docket draft. */
export const isReviewed = (p: PrSummary): boolean => p.role === 'review' && (!!p.myReview || p.draftState === 'posted')

export function applyFilters(prs: PrSummary[], f: Filters, progress: Progress): PrSummary[] {
  const words = f.query.toLowerCase().split(/\s+/).filter(Boolean)
  return prs.filter((p) => {
    if (f.repo && p.repo !== f.repo) return false
    if (f.level !== 'all' && p.level !== f.level) return false
    if (f.ci !== 'all' && p.ci !== f.ci) return false
    // Authors only narrow the review column: your own pull requests are all by you.
    if (f.authors.length && p.role === 'review' && !f.authors.includes(p.author.login)) return false
    if (f.hideDrafts && p.isDraft) return false
    if (f.drafting && !isDrafting(p, progress)) return false
    if (f.reviewed && !isReviewed(p)) return false
    if (f.media && !p.preview) return false
    if (!words.length) return true
    const text = `${p.title} ${p.repo} #${p.number} ${p.author.login} ${p.headRef}`.toLowerCase()
    return words.every((w) => text.includes(w))
  })
}

const LEVELS: { value: Filters['level']; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'action', label: 'Needs you' },
  { value: 'ready', label: 'Ready to merge' },
  { value: 'waiting', label: 'Waiting' }
]

const CI: { value: Filters['ci']; label: string }[] = [
  { value: 'all', label: 'Any CI' },
  { value: 'failure', label: 'CI failing' },
  { value: 'success', label: 'CI passed' },
  { value: 'pending', label: 'CI running' },
  { value: 'none', label: 'No CI' }
]

/** Pick any number of authors for the review column. Lists everyone whose pull requests are there, busiest first. */
function AuthorFilter({ prs, selected, onChange }: { prs: PrSummary[]; selected: string[]; onChange: (a: string[]) => void }) {
  const [query, setQuery] = useState('')
  const counts = new Map<string, { count: number; avatarUrl: string }>()
  for (const p of prs) {
    if (p.role !== 'review') continue
    const a = counts.get(p.author.login) ?? { count: 0, avatarUrl: p.author.avatarUrl }
    a.count++
    counts.set(p.author.login, a)
  }
  // A remembered author may have nothing open right now; keep them listed so they can be unticked.
  for (const login of selected) if (!counts.has(login)) counts.set(login, { count: 0, avatarUrl: '' })
  const authors = [...counts].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
  const shown = authors.filter(([login]) => login.toLowerCase().includes(query.trim().toLowerCase()))
  const toggle = (login: string): void =>
    onChange(selected.includes(login) ? selected.filter((l) => l !== login) : [...selected, login])
  const label = selected.length === 0 ? 'All authors' : selected.length === 1 ? selected[0] : `${selected.length} authors`

  return (
    <Popover onOpenChange={(open) => !open && setQuery('')}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Authors: ${label}`}
          className={cn(
            'h-8 min-w-0 max-w-48 shrink gap-1.5 bg-background text-[13px] font-normal',
            selected.length > 0 && 'border-primary font-medium'
          )}
        >
          <Users aria-hidden />
          <span className="truncate">{label}</span>
          <ChevronDown className="opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1.5">
        {authors.length > 8 && (
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find an author"
            aria-label="Find an author"
            className="mb-1.5 h-7 text-[13px] md:text-[13px]"
          />
        )}
        <ul className="max-h-72 overflow-auto" aria-label="Authors">
          {shown.map(([login, a]) => (
            <li key={login}>
              <Label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] font-normal hover:bg-accent">
                <Checkbox checked={selected.includes(login)} onCheckedChange={() => toggle(login)} />
                {a.avatarUrl ? (
                  <img src={a.avatarUrl} alt="" className="size-4 rounded-full" />
                ) : (
                  <span className="size-4 rounded-full bg-secondary" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate">{login}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{a.count}</span>
              </Label>
            </li>
          ))}
          {shown.length === 0 && <li className="px-2 py-1.5 text-xs text-muted-foreground">No author matches.</li>}
        </ul>
        {selected.length > 0 && (
          <Button variant="ghost" size="sm" className="mt-1 h-7 w-full justify-start px-2 text-xs" onClick={() => onChange([])}>
            <X aria-hidden />
            Show all authors
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** A one-click filter that is either on or off. All of them look alike so the row reads as one set. */
function Chip({
  on,
  onClick,
  title,
  Icon,
  count,
  children
}: {
  on: boolean
  onClick: () => void
  title: string
  Icon: typeof Search
  count?: number
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Toggle
          pressed={on}
          onPressedChange={onClick}
          variant="outline"
          size="sm"
          className={cn(
            'h-8 shrink-0 gap-1.5 rounded-full bg-background px-3 text-[13px] font-normal text-muted-foreground shadow-none',
            'hover:border-muted-foreground/60 hover:bg-background hover:text-foreground',
            // The tooltip around it sets its own data-state, so the pressed look keys on aria-pressed instead.
            'aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:font-medium aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/90 aria-pressed:hover:text-primary-foreground',
            '[&>svg]:size-3.5'
          )}
        >
          <Icon aria-hidden />
          <span className="@max-6xl:sr-only">{children}</span>
          {count !== undefined && (
            <span
              className={cn(
                'rounded-full px-1.5 text-[11px] font-semibold tabular-nums',
                on ? 'bg-primary-foreground/20' : 'bg-secondary text-foreground'
              )}
            >
              {count}
            </span>
          )}
        </Toggle>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  )
}

const SHORTCUTS: { keys: string[]; what: string }[] = [
  { keys: ['↩'], what: 'Open the focused pull request' },
  { keys: ['⌘', 'click'], what: 'Select several pull requests' },
  { keys: ['X'], what: 'Select or deselect the focused one' },
  { keys: ['⌘', 'C'], what: 'Copy links to the selection, or the focused one' },
  { keys: ['⌘', '⇧', 'C'], what: 'Copy every link in the focused stack' },
  { keys: ['P'], what: 'Pin to the top of its column' },
  { keys: ['B'], what: 'Copy the branch name' },
  { keys: ['O'], what: 'Open on GitHub' },
  { keys: ['Esc'], what: 'Clear the selection' }
]

/** What the keyboard does on the dashboard, since none of it is written on the rows. */
function ShortcutsHelp() {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="Keyboard shortcuts">
              <Keyboard aria-hidden />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Keyboard shortcuts</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 p-3">
        <p className="mb-2 text-sm font-medium">Keyboard shortcuts</p>
        <p className="mb-2.5 text-xs text-muted-foreground">Tab to a pull request first, or click one.</p>
        <ul className="grid gap-1.5 text-xs">
          {SHORTCUTS.map((s) => (
            <li key={s.what} className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">{s.what}</span>
              <span className="flex shrink-0 gap-1">
                {s.keys.map((k) => (
                  <kbd key={k} className="rounded border bg-muted px-1.5 py-0.5 font-sans text-[11px] text-foreground">
                    {k}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

export function FilterBar({
  prs,
  filters,
  progress,
  shown,
  onChange
}: {
  progress: Progress
  /** Every pull request, unfiltered: the source of the repository choices. */
  prs: PrSummary[]
  filters: Filters
  shown: number
  onChange: (f: Filters) => void
}) {
  const set = (patch: Partial<Filters>): void => onChange({ ...filters, ...patch })
  const repos = [...new Set(prs.map((p) => p.repo))].sort()
  // A remembered repository may have no open pull requests any more; keep it selectable so it can be cleared.
  if (filters.repo && !repos.includes(filters.repo)) repos.push(filters.repo)
  const active = isFiltering(filters)
  const drafting = prs.filter((p) => isDrafting(p, progress)).length
  const reviewed = prs.filter(isReviewed).length
  const media = prs.filter((p) => p.preview).length

  return (
    <div className="@container grid gap-2.5 rounded-lg border bg-card p-2.5" role="search" aria-label="Filter pull requests">
      {/* First row: what to look for and how urgent. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            value={filters.query}
            onChange={(e) => set({ query: e.target.value })}
            placeholder="Filter by title, number, author or branch"
            aria-label="Filter by title, number, author or branch"
            className="h-8 bg-background pl-8 text-[13px] md:text-[13px]"
          />
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={filters.level}
          // Clicking the selected item again would clear it; "All" is the way to do that.
          onValueChange={(v) => v && set({ level: v as Filters['level'] })}
          aria-label="Status"
          className="bg-background"
        >
          {LEVELS.map((l) => (
            <ToggleGroupItem
              key={l.value}
              value={l.value}
              className="h-8 px-3 text-[13px] font-normal data-[state=on]:bg-primary data-[state=on]:font-medium data-[state=on]:text-primary-foreground"
            >
              {l.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {/* Second row: narrowing dropdowns on the left, one-click toggles next, the tally on the right.
          It stays on one line: below @6xl the chips show only their icon and count, and the dropdowns truncate. */}
      <div className="flex flex-nowrap items-center gap-2">
        <Select value={filters.ci} onValueChange={(v) => set({ ci: v as Filters['ci'] })}>
          <SelectTrigger
            size="sm"
            aria-label="CI status"
            className={cn('shrink-0 bg-background text-[13px]', filters.ci !== 'all' && 'border-primary font-medium')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            {CI.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {repos.length > 1 && (
          <Select value={filters.repo || ALL_REPOS} onValueChange={(v) => set({ repo: v === ALL_REPOS ? '' : v })}>
            <SelectTrigger
              size="sm"
              aria-label="Repository"
              className={cn('min-w-0 max-w-56 shrink bg-background text-[13px]', filters.repo && 'border-primary font-medium')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              <SelectItem value={ALL_REPOS}>All repositories</SelectItem>
              {repos.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <AuthorFilter prs={prs} selected={filters.authors} onChange={(authors) => set({ authors })} />

        <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />

        {(drafting > 0 || filters.drafting) && (
          <Chip
            on={filters.drafting}
            onClick={() => set({ drafting: !filters.drafting })}
            title="Only pull requests where Claude is reviewing or you have an unposted review draft"
            Icon={NotebookPen}
            count={drafting}
          >
            Review drafts
          </Chip>
        )}
        {(reviewed > 0 || filters.reviewed) && (
          <Chip
            on={filters.reviewed}
            onClick={() => set({ reviewed: !filters.reviewed })}
            title="Only other people's pull requests you have already reviewed"
            Icon={MessageSquareCheck}
            count={reviewed}
          >
            Reviewed by me
          </Chip>
        )}
        {(media > 0 || filters.media) && (
          <Chip
            on={filters.media}
            onClick={() => set({ media: !filters.media })}
            title="Only pull requests whose description has a video or screenshots"
            Icon={Video}
            count={media}
          >
            Has media
          </Chip>
        )}
        <Chip
          on={filters.hideDrafts}
          onClick={() => set({ hideDrafts: !filters.hideDrafts })}
          title="Leave out pull requests that are still drafts on GitHub"
          Icon={EyeOff}
        >
          Hide draft PRs
        </Chip>

        <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <span aria-live="polite" className="flex items-center gap-1">
            {active ? (
              <>
                <span className="tabular-nums">
                  {shown} of {prs.length} shown
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  title="Clear filters"
                  onClick={() => onChange(NO_FILTERS)}
                >
                  <X aria-hidden />
                  <span className="@max-6xl:sr-only">Clear filters</span>
                </Button>
              </>
            ) : (
              <span className="tabular-nums">{prs.length} pull requests</span>
            )}
          </span>
          <ShortcutsHelp />
        </span>
      </div>
    </div>
  )
}
