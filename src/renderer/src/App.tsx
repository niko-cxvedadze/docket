import { useCallback, useEffect, useRef, useState } from 'react'
import type { PrList, PrSummary, ReviewProgress } from '../../shared/types'
import { Dashboard } from './Dashboard'
import { Notices } from './Notices'
import { PrView } from './PrView'
import { Performance } from './Performance'
import { Settings } from './Settings'
import { Storage } from './Storage'
import { ago } from './util'
import {
  ChartLine,
  ChevronLeft,
  GitPullRequest,
  HardDrive,
  MessageSquareQuote,
  Monitor,
  Moon,
  RefreshCw,
  Sun
} from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { Theme } from '../../shared/types'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const REFRESH_MS = 120_000

const THEME_CHOICES: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: 'system', label: 'Match macOS', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon }
]

function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>('system')
  useEffect(() => void window.api.getTheme().then(setTheme), [])
  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={theme}
      onValueChange={(v) => {
        if (!v) return // clicking the chosen one again keeps it
        setTheme(v as Theme)
        void window.api.setTheme(v as Theme)
      }}
      aria-label="Appearance"
    >
      {THEME_CHOICES.map(({ value, label, Icon }) => (
        <Tooltip key={value}>
          <TooltipTrigger asChild>
            {/* The tooltip sets its own data-state, so the chosen one is marked through aria-checked. */}
            <ToggleGroupItem
              value={value}
              aria-label={label}
              className="size-7 min-w-7 px-0 aria-checked:bg-accent aria-checked:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
            >
              <Icon className="size-3.5" aria-hidden />
            </ToggleGroupItem>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ))}
    </ToggleGroup>
  )
}

/** The number on the dock icon, with where it comes from. */
function NeedsYou({ prs, onShow }: { prs: PrSummary[]; onShow: () => void }) {
  const needs = prs.filter((p) => p.level !== 'waiting')
  if (!needs.length) return null
  const mine = needs.filter((p) => p.role === 'mine')
  const reviews = needs.length - mine.length
  const ready = mine.filter((p) => p.level === 'ready').length
  const parts = [
    mine.length && `${mine.length} of your pull requests${ready ? ` (${ready} ready to merge)` : ''}`,
    reviews && `${reviews} ${reviews === 1 ? 'review' : 'reviews'} waiting on you`
  ].filter(Boolean)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge asChild className="cursor-pointer bg-action-bg text-action hover:bg-action-bg/80">
          <button onClick={onShow}>{needs.length} need you</button>
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{parts.join(', ')}. This is the number on the dock icon.</TooltipContent>
    </Tooltip>
  )
}

/** Re-renders every half minute so relative times such as "updated 3m ago" keep up. */
function useClock(ms = 30_000): void {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), ms)
    return () => clearInterval(t)
  }, [ms])
}

/** The shape of the dashboard while the first list loads: a filter bar and two columns of rows. */
function DashboardSkeleton() {
  const column = (
    <div className="grid gap-3">
      <div className="flex items-center gap-2.5">
        <Skeleton className="h-6 w-44" />
        <Skeleton className="h-5 w-24 rounded-full" />
      </div>
      <div className="grid gap-1.5">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14 rounded-md" />
        ))}
      </div>
    </div>
  )
  return (
    <main className="flex-1 overflow-hidden px-7 pt-3 pb-10" aria-busy aria-label="Loading your pull requests">
      <Skeleton className="h-[86px] rounded-lg" />
      <div className="mt-7 grid grid-cols-1 gap-7 min-[1050px]:grid-cols-2">
        {column}
        {column}
      </div>
    </main>
  )
}

export function App() {
  const [list, setList] = useState<PrList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  // A pull request opened from "All open" is not in the main list, so keep what was clicked.
  const [opened, setOpened] = useState<PrSummary | null>(null)
  const [page, setPage] = useState<'dashboard' | 'performance' | 'settings' | 'storage'>('dashboard')
  const [progress, setProgress] = useState<Record<string, ReviewProgress>>({})
  const busy = useRef(false)
  const again = useRef<{ force: boolean } | null>(null)
  const [fullScreen, setFullScreen] = useState(false)
  useClock()
  useEffect(() => {
    void window.api.isFullScreen().then(setFullScreen)
    return window.api.onFullScreen(setFullScreen)
  }, [])

  const refresh = useCallback(async (force = false) => {
    // A refresh asked for while one is running (say, a review finishing during the timer's) runs
    // right after it: the running one may have marked drafts before the change it was asked for.
    if (busy.current) {
      again.current = { force: again.current?.force || force }
      return
    }
    busy.current = true
    setLoading(true)
    try {
      for (let f = force; ; ) {
        try {
          setList(await window.api.listPrs(f))
          setError(null)
        } catch (e) {
          setError((e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''))
        }
        const next = again.current
        again.current = null
        if (!next) break
        f = next.force
      }
    } finally {
      busy.current = false
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), REFRESH_MS)
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  useEffect(() => {
    void window.api.runningReviews().then((rs) => setProgress(Object.fromEntries(rs.map((r) => [r.key, r]))))
    return window.api.onReviewProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.key]: p }))
      if (p.state !== 'running') void refresh()
    })
  }, [refresh])

  const pr = selected ? (list?.prs.find((p) => p.key === selected) ?? (opened?.key === selected ? opened : undefined)) : undefined

  return (
    <div className={fullScreen ? 'app fullscreen' : 'app'}>
      <header className="topbar">
        <div className="topbar-title">
          {pr ? (
            <Button variant="ghost" size="sm" className="-ml-2 text-primary hover:text-primary" onClick={() => setSelected(null)}>
              <ChevronLeft aria-hidden />
              All pull requests
            </Button>
          ) : (
            <nav className="flex items-center gap-1" aria-label="Pages">
              <span className="brand mr-3 flex items-center gap-2">
                {/* Relative, so it also resolves when the packaged app loads index.html from disk. */}
                <img src="./favicon.svg" alt="" className="size-5 rounded-[5px]" draggable={false} />
                Docket
              </span>
              <Button variant={page === 'dashboard' ? 'secondary' : 'ghost'} size="sm" aria-current={page === 'dashboard' ? 'page' : undefined} onClick={() => setPage('dashboard')}>
                <GitPullRequest aria-hidden />
                Pull requests
              </Button>
              <Button variant={page === 'performance' ? 'secondary' : 'ghost'} size="sm" aria-current={page === 'performance' ? 'page' : undefined} onClick={() => setPage('performance')}>
                <ChartLine aria-hidden />
                My performance
              </Button>
              <Button variant={page === 'settings' ? 'secondary' : 'ghost'} size="sm" aria-current={page === 'settings' ? 'page' : undefined} onClick={() => setPage('settings')}>
                <MessageSquareQuote aria-hidden />
                Reviewer voice
              </Button>
              <Button variant={page === 'storage' ? 'secondary' : 'ghost'} size="sm" aria-current={page === 'storage' ? 'page' : undefined} onClick={() => setPage('storage')}>
                <HardDrive aria-hidden />
                Storage
              </Button>
            </nav>
          )}
        </div>
        <div className="topbar-right">
          {list && (
            <NeedsYou
              prs={list.prs}
              onShow={() => {
                setSelected(null)
                setPage('dashboard')
              }}
            />
          )}
          {list && (
            <span className="muted">
              {list.viewer}, updated {ago(list.fetchedAt)}
            </span>
          )}
          <Notices
            prs={list?.prs ?? []}
            current={pr?.key ?? null}
            onOpen={(p) => {
              setOpened(p)
              setSelected(p.key)
            }}
          />
          <ThemeSwitch />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={loading ? 'Refreshing pull requests' : 'Refresh pull requests'}
                onClick={() => void refresh(true)}
              >
                <RefreshCw className={loading ? 'animate-spin' : ''} aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{loading ? 'Refreshing…' : 'Refresh'}</TooltipContent>
          </Tooltip>
        </div>
      </header>

      {error && (
        <div className="banner error flex items-center gap-3" role="alert">
          <span className="min-w-0 flex-1">{error}</span>
          <Button
            variant="outline"
            size="xs"
            className="shrink-0 border-danger/40 bg-transparent text-danger hover:bg-danger/10 hover:text-danger"
            disabled={loading}
            onClick={() => void refresh(true)}
          >
            <RefreshCw className={loading ? 'animate-spin' : ''} aria-hidden />
            Try again
          </Button>
        </div>
      )}
      {!error && list?.notice && (
        <div className="banner" role="status">
          {list.notice}
        </div>
      )}

      {pr && list ? (
        <PrView
          key={pr.key}
          pr={pr}
          progress={progress[pr.key]}
          onDraftChanged={() => void refresh()}
        />
      ) : page === 'performance' ? (
        <Performance />
      ) : page === 'settings' ? (
        <Settings />
      ) : page === 'storage' ? (
        <Storage onChanged={() => void refresh()} />
      ) : list ? (
        <Dashboard
          list={list}
          progress={progress}
          onOpen={(p) => {
            setOpened(p)
            setSelected(p.key)
          }}
        />
      ) : (
        !error && <DashboardSkeleton />
      )}
    </div>
  )
}
