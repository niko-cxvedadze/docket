import { useCallback, useEffect, useRef, useState } from 'react'
import type { PrList, PrSummary, ReviewProgress } from '../../shared/types'
import { Dashboard } from './Dashboard'
import { PrView } from './PrView'
import { Performance } from './Performance'
import { Settings } from './Settings'
import { ago } from './util'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const REFRESH_MS = 120_000

export function App() {
  const [list, setList] = useState<PrList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  // A pull request opened from "All open" is not in the main list, so keep what was clicked.
  const [opened, setOpened] = useState<PrSummary | null>(null)
  const [page, setPage] = useState<'dashboard' | 'performance' | 'settings'>('dashboard')
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
            </nav>
          )}
        </div>
        <div className="topbar-right">
          {list && (
            <span className="muted">
              {list.viewer}, updated {ago(list.fetchedAt)}
            </span>
          )}
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
