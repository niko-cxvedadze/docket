import { useState } from 'react'
import { Popover } from 'radix-ui'
import { ChevronDown, EyeOff, Video, MessageSquareCheck, NotebookPen, Search, Users, X } from 'lucide-react'
import type { CiState, Level, PrSummary, ReviewProgress } from '../../shared/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

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
    <Popover.Root onOpenChange={(open) => !open && setQuery('')}>
      <Popover.Trigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Authors: ${label}`}
          className={cn('h-8 max-w-48 gap-1.5 bg-background text-[13px] font-normal', selected.length > 0 && 'border-primary font-medium')}
        >
          <Users aria-hidden />
          <span className="truncate">{label}</span>
          <ChevronDown className="opacity-50" aria-hidden />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 w-64 rounded-md border bg-popover p-1.5 text-popover-foreground shadow-md"
        >
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
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
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
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-ring [&>svg]:size-3.5',
        on
          ? 'border-primary bg-primary font-medium text-primary-foreground'
          : 'border-input bg-background text-muted-foreground hover:border-muted-foreground/60 hover:text-foreground'
      )}
    >
      <Icon aria-hidden />
      {children}
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
    </button>
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
    <div className="grid gap-2.5 rounded-lg border bg-card p-2.5" role="search" aria-label="Filter pull requests">
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

      {/* Second row: narrowing dropdowns on the left, one-click toggles next, the tally on the right. */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filters.ci} onValueChange={(v) => set({ ci: v as Filters['ci'] })}>
          <SelectTrigger
            size="sm"
            aria-label="CI status"
            className={cn('bg-background text-[13px]', filters.ci !== 'all' && 'border-primary font-medium')}
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
              className={cn('max-w-56 bg-background text-[13px]', filters.repo && 'border-primary font-medium')}
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

        <span className="mx-1 h-5 w-px bg-border" aria-hidden />

        {(drafting > 0 || filters.drafting) && (
          <Chip
            on={filters.drafting}
            onClick={() => set({ drafting: !filters.drafting })}
            title="Show only pull requests where Claude is reviewing or you have an unposted review draft"
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
            title="Show only other people's pull requests you have already reviewed"
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
            title="Show only pull requests whose description has a video or screenshots"
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

        <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
          {active ? (
            <>
              <span className="tabular-nums">
                {shown} of {prs.length} shown
              </span>
              <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => onChange(NO_FILTERS)}>
                <X aria-hidden />
                Clear filters
              </Button>
            </>
          ) : (
            <span className="tabular-nums">{prs.length} pull requests</span>
          )}
        </span>
      </div>
    </div>
  )
}
