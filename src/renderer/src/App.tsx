import { useCallback, useEffect, useRef, useState } from 'react'
import type { PrList, PrSummary, ReviewProgress } from '../../shared/types'
import { Dashboard } from './Dashboard'
import { PrView } from './PrView'
import { Performance } from './Performance'
import { Settings } from './Settings'
import { Storage } from './Storage'
import { ago } from './util'
import { Monitor, Moon, RefreshCw, Sun } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { Theme } from '../../shared/types'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
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
            <ToggleGroupItem value={value} aria-label={label} className="size-7 min-w-7 px-0">
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
  const [fullScreen, setFullScreen] = useState(false)
  useEffect(() => {
    void window.api.isFullScreen().then(setFullScreen)
    return window.api.onFullScreen(setFullScreen)
  }, [])

  const refresh = useCallback(async (force = false) => {
    if (busy.current) return
    busy.current = true
    setLoading(true)
    try {
      setList(await window.api.listPrs(force))
      setError(null)
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''))
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
            <button className="link-button" onClick={() => setSelected(null)}>
              ‹ All pull requests
            </button>
          ) : (
            <nav className="flex items-center gap-1">
              <span className="brand mr-3">Docket</span>
              <Button variant={page === 'dashboard' ? 'secondary' : 'ghost'} size="sm" onClick={() => setPage('dashboard')}>
                Pull requests
              </Button>
              <Button variant={page === 'performance' ? 'secondary' : 'ghost'} size="sm" onClick={() => setPage('performance')}>
                My performance
              </Button>
              <Button variant={page === 'settings' ? 'secondary' : 'ghost'} size="sm" onClick={() => setPage('settings')}>
                Reviewer voice
              </Button>
              <Button variant={page === 'storage' ? 'secondary' : 'ghost'} size="sm" onClick={() => setPage('storage')}>
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
        <div className="banner error" role="alert">
          {error}
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
        !error && <div className="empty">Loading your pull requests…</div>
      )}
    </div>
  )
}
