import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronsUpDown, CircleAlert, CircleCheck, CircleDashed, GitBranch, LoaderCircle, Network, RefreshCw, RotateCcw, ScanSearch, Search, Trash2, Waypoints, X } from 'lucide-react'
import { toast } from 'sonner'
import type { PrSummary } from '../../shared/types'
import { mapId, type MapBranches, type MapFreshness, type MapProgress, type MapSummary, type SystemMap as SystemMapData } from '../../shared/sysmap'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Confirm } from './Confirm'
import { ClaudeOptions, EFFORT_LABEL, MODEL_LABEL } from './ClaudeOptions'
import { ago } from './util'
import { cn } from '@/lib/utils'
import { SystemView } from './map/SystemView'
import { FeatureView } from './map/FeatureView'
import { FeatureRail } from './map/FeatureRail'
import { MapDetail } from './map/MapDetail'
import { freshOf, type Selection } from './map/kinds'

type View = 'system' | 'features'

const clean = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, '')
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

// ---------- What was on screen last time, per account ----------

interface Choice {
  repo: string | null
  branch: string | null
  view: View
}
const choiceKey = (account: string): string => `docket.map.${account}`
function loadChoice(account: string): Choice {
  try {
    const saved = JSON.parse(localStorage.getItem(choiceKey(account)) ?? '{}') as Partial<Choice>
    return {
      repo: typeof saved.repo === 'string' ? saved.repo : null,
      branch: typeof saved.branch === 'string' ? saved.branch : null,
      view: saved.view === 'features' ? 'features' : 'system'
    }
  } catch {
    return { repo: null, branch: null, view: 'system' }
  }
}
function saveChoice(account: string, choice: Choice): void {
  try {
    localStorage.setItem(choiceKey(account), JSON.stringify(choice))
  } catch {
    /* remembered for this session only */
  }
}

/** Re-renders every second while `on`, for a running clock. */
function useTick(on: boolean): void {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [on])
}

const elapsed = (since: string): string => {
  const s = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// ---------- Toasts for scans, wherever the user is in the app ----------

/**
 * A scan takes minutes, so the user is usually elsewhere in Docket when it ends. This lives in App
 * and says so with a toast; `onOpen` goes to the map when the user is on another page.
 */
export function MapScanNotices({ account, onOpen }: { account: string | null; onOpen: (() => void) | null }): null {
  const open = useRef(onOpen)
  open.current = onOpen
  useEffect(() => {
    if (!account) return
    return window.api.onMapProgress((p) => {
      if (p.account !== account || p.state === 'running' || p.state === 'cancelled') return
      const where = `${p.repo.split('/')[1]} · ${p.branch}`
      const action = open.current ? { label: 'Open', onClick: () => open.current?.() } : undefined
      if (p.state === 'error') toast.error('System map did not finish', { description: `${where}: ${p.error ?? ''}`, duration: 8000, action })
      else toast.success(p.mode === 'update' ? 'System map updated' : 'System map ready', { description: `${where}: ${p.step}`, duration: 6000, action })
    })
  }, [account])
  return null
}

// ---------- Pickers ----------

function BranchPicker({
  branches,
  loading,
  error,
  value,
  mapped,
  hinted,
  onChange
}: {
  branches: MapBranches | null
  loading: boolean
  error: string | null
  value: string | null
  /** Branches of this repository that already have a map. */
  mapped: Set<string>
  /** Branches of the user's own pull requests here, listed early. */
  hinted: Set<string>
  onChange: (branch: string) => void
}) {
  const [open, setOpen] = useState(false)
  const names = useMemo(() => {
    // A mapped branch stays in the list after it is deleted on GitHub, so its map can still be read.
    const all = new Set([...(branches?.branches.map((b) => b.name) ?? []), ...mapped])
    const rank = (b: string): number => (b === branches?.defaultBranch ? 0 : mapped.has(b) ? 1 : hinted.has(b) ? 2 : 3)
    return [...all].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  }, [branches, mapped, hinted])
  const onGitHub = useMemo(() => new Set(branches?.branches.map((b) => b.name)), [branches])
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" role="combobox" aria-expanded={open} aria-label="Branch" className="max-w-[280px] justify-between font-normal">
          <GitBranch className="text-muted-foreground" aria-hidden />
          <span className="truncate">{value ?? (loading ? 'Loading branches…' : 'Choose a branch')}</span>
          <ChevronsUpDown className="opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[340px] p-0">
        <Command>
          <CommandInput placeholder="Find a branch…" />
          <CommandList>
            <CommandEmpty>{loading ? 'Loading branches…' : (error ?? 'No branch by that name.')}</CommandEmpty>
            <CommandGroup>
              {names.map((name) => (
                <CommandItem
                  key={name}
                  value={name}
                  onSelect={() => {
                    onChange(name)
                    setOpen(false)
                  }}
                >
                  <Check className={cn(value === name ? 'opacity-100' : 'opacity-0')} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  {name === branches?.defaultBranch && (
                    <Badge variant="secondary" className="font-normal">
                      default
                    </Badge>
                  )}
                  {mapped.has(name) && <Badge className="bg-tint font-normal text-primary">mapped</Badge>}
                  {branches && !onGitHub.has(name) && (
                    <Badge variant="secondary" className="font-normal text-muted-foreground">
                      gone from GitHub
                    </Badge>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ---------- A scan in progress ----------

/** Which Claude a scan runs on, as "Opus · Medium"; empty when the main process did not say. */
const using = (run: MapProgress): string => [run.model && MODEL_LABEL(run.model), run.effort && EFFORT_LABEL(run.effort)].filter(Boolean).join(' · ')

const SCAN_PHASES: { phase: MapProgress['phase']; label: string }[] = [
  { phase: 'prepare', label: 'Fetch the branch' },
  { phase: 'survey', label: 'Find the parts of the system' },
  { phase: 'study', label: 'Study each component and trace each feature' }
]

/** The whole page while a branch is scanned for the first time. */
function ScanCard({ run, onStop }: { run: MapProgress; onStop: () => void }) {
  useTick(true)
  // A phase this page does not list (a main process from before a restart names them differently) counts as the last.
  const found = SCAN_PHASES.findIndex((p) => p.phase === run.phase)
  const at = found < 0 ? SCAN_PHASES.length - 1 : found
  return (
    <div className="grid flex-1 place-items-center overflow-auto p-10">
      <div className="grid w-full max-w-md gap-4 rounded-xl border bg-card p-6" role="status">
        <div className="grid gap-1">
          <h2 className="text-base font-semibold">Drawing the system map</h2>
          <p className="text-xs text-muted-foreground">
            {run.repo} on {run.branch}
            {using(run) && ` · with ${using(run)}`}
          </p>
        </div>
        <ol className="grid gap-2.5">
          {SCAN_PHASES.map((p, i) => (
            <li key={p.phase} className={cn('flex items-center gap-2.5 text-sm', i > at && 'text-muted-foreground')}>
              {i < at ? (
                <CircleCheck className="size-4 text-ready" aria-hidden />
              ) : i === at ? (
                <LoaderCircle className="size-4 animate-spin text-primary" aria-hidden />
              ) : (
                <CircleDashed className="size-4 opacity-60" aria-hidden />
              )}
              <span className={cn(i === at && 'font-medium')}>{p.label}</span>
              {i === at && run.total > 0 && (
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                  {run.done} of {run.total}
                </span>
              )}
            </li>
          ))}
        </ol>
        <div className="flex items-center gap-3 border-t pt-3">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={run.step}>
            {run.step}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">{elapsed(run.startedAt)}</span>
          <Button variant="outline" size="xs" onClick={onStop}>
            Stop
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          The first scan of a branch takes a few minutes. After that the map follows the branch: an update reads only the new commits. You can keep using Docket
          meanwhile.
        </p>
      </div>
    </div>
  )
}

/** A strip over the map while it is brought up to date or scanned again. */
function ScanStrip({ run, onStop }: { run: MapProgress; onStop: () => void }) {
  useTick(true)
  return (
    <div className="flex items-center gap-2.5 border-b bg-tint px-7 py-2 text-xs" role="status">
      <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
      <span className="shrink-0 font-medium">
        {run.mode === 'update' ? 'Updating the map from new commits' : 'Scanning the branch again'}
        {using(run) && ` with ${using(run)}`}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {run.step}
        {run.total > 0 && ` · ${run.done} of ${run.total}`}
      </span>
      <span className="text-muted-foreground tabular-nums">{elapsed(run.startedAt)}</span>
      <Button variant="outline" size="xs" className="bg-transparent" onClick={onStop}>
        Stop
      </Button>
    </div>
  )
}

// ---------- The page ----------

/**
 * A map of one repository on one branch, in two linked views: the system (what it is built from
 * and how the parts connect) and its features (what it does, and which parts each one runs
 * through). Scanned once, then kept up to date from the branch's new commits.
 */
export function SystemMap({ account, prs }: { account: string; /** The account's pull requests: the repositories it can map. */ prs: PrSummary[] }) {
  const saved = useMemo(() => loadChoice(account), [account])
  const [maps, setMaps] = useState<MapSummary[] | null>(null)
  const [runs, setRuns] = useState<Record<string, MapProgress>>({})
  const [repo, setRepo] = useState<string | null>(saved.repo)
  const [branch, setBranch] = useState<string | null>(saved.branch)
  const [branches, setBranches] = useState<{ repo: string; data: MapBranches | null; error: string | null } | null>(null)
  const [map, setMap] = useState<SystemMapData | null>(null)
  /** The map `map` answers for; differs from the chosen one while that is still loading. */
  const [loadedId, setLoadedId] = useState<string | null>(null)
  const [freshness, setFreshness] = useState<MapFreshness | null>(null)
  const [view, setView] = useState<View>(saved.view)
  const [selection, setSelection] = useState<Selection>(null)
  const [query, setQuery] = useState('')
  const [connections, setConnections] = useState(true)
  const [expandAll, setExpandAll] = useState(false)

  const repos = useMemo(() => [...new Set([...prs.map((p) => p.repo), ...(maps ?? []).map((m) => m.repo)])].sort((a, b) => a.localeCompare(b)), [prs, maps])
  const id = repo && branch ? mapId(account, repo, branch) : null
  const current = useRef<string | null>(null)

  const refreshList = useCallback(
    () =>
      window.api.mapList(account).then(
        ({ maps: list, running }) => {
          setMaps(list)
          setRuns((prev) => ({ ...prev, ...Object.fromEntries(running.map((r) => [r.id, r])) }))
        },
        () => setMaps((m) => m ?? [])
      ),
    [account]
  )
  const fetchMap = useCallback((forId: string) => {
    const got = (loaded: SystemMapData | null): void => {
      if (current.current !== forId) return
      // A map drawn before components listed what is inside them has none to show.
      const m = loaded && { ...loaded, nodes: loaded.nodes.map((n) => ({ ...n, contents: n.contents ?? [] })) }
      setMap(m)
      setLoadedId(forId)
      // A part an update removed cannot stay picked.
      setSelection((s) => (s && m && (s.type === 'node' ? m.nodes.some((n) => n.id === s.id) : m.features.some((f) => f.id === s.id)) ? s : null))
    }
    void window.api.mapGet(forId).then(got, () => got(null))
  }, [])
  const lastCheck = useRef(0)
  const checkFreshness = useCallback((forId: string) => {
    lastCheck.current = Date.now()
    void window.api.mapFreshness(forId).then(
      (f) => current.current === forId && setFreshness(f),
      () => undefined
    )
  }, [])

  // The list of maps, and every scan as it moves.
  useEffect(() => {
    void refreshList()
    return window.api.onMapProgress((p) => {
      if (p.account !== account) return
      setRuns((prev) => ({ ...prev, [p.id]: p }))
      if (p.state === 'running') return
      void refreshList()
      if (p.id === current.current) {
        fetchMap(p.id)
        checkFreshness(p.id)
      }
    })
  }, [account, refreshList, fetchMap, checkFreshness])

  // Start on the map looked at last, else the one most recently drawn, else the first repository.
  useEffect(() => {
    if (!maps || (repo && repos.includes(repo))) return
    const pick = maps[0]?.repo ?? repos[0] ?? null
    setRepo(pick)
    setBranch(maps.find((m) => m.repo === pick)?.branch ?? null)
  }, [maps, repos, repo])
  useEffect(() => {
    if (!repo) return
    let stale = false
    setBranches({ repo, data: null, error: null })
    window.api.mapBranches(account, repo).then(
      (data) => !stale && setBranches({ repo, data, error: null }),
      (e) => !stale && setBranches({ repo, data: null, error: clean(e) })
    )
    return () => {
      stale = true
    }
  }, [account, repo])
  // No branch chosen yet: the one already mapped, else the repository's default once GitHub has said which that is.
  useEffect(() => {
    if (!repo || branch) return
    const pick = maps?.find((m) => m.repo === repo)?.branch ?? (branches?.repo === repo ? branches.data?.defaultBranch : null)
    if (pick) setBranch(pick)
  }, [repo, branch, maps, branches])

  useEffect(() => {
    current.current = id
    setMap(null)
    setLoadedId(null)
    setSelection(null)
    setFreshness(null)
    if (!id) return
    fetchMap(id)
    checkFreshness(id)
  }, [id, fetchMap, checkFreshness])
  // Coming back to the window is when new commits are most likely to have landed.
  useEffect(() => {
    const onFocus = (): void => {
      if (current.current && Date.now() - lastCheck.current > 60_000) checkFreshness(current.current)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [checkFreshness])
  useEffect(() => saveChoice(account, { repo, branch, view }), [account, repo, branch, view])

  const run = id ? runs[id] : undefined
  const scanning = run?.state === 'running'
  const failed = run?.state === 'error' ? run : undefined
  const fresh = useMemo(() => (map ? freshOf(map) : { added: new Set<string>(), changed: new Set<string>() }), [map])
  const mappedBranches = useMemo(() => new Set((maps ?? []).filter((m) => m.repo === repo).map((m) => m.branch)), [maps, repo])
  const hintedBranches = useMemo(() => new Set(prs.filter((p) => p.repo === repo).flatMap((p) => [p.headRef, p.baseRef])), [prs, repo])
  const mappedRepos = useMemo(() => new Set((maps ?? []).map((m) => m.repo)), [maps])

  const scan = (mode: 'scan' | 'update'): void => {
    if (!repo || !branch) return
    void window.api.mapScan(account, repo, branch, mode).catch((e) => toast.error(clean(e)))
  }
  const stop = (): void => void (id && window.api.mapCancel(id))
  const dismiss = (): void =>
    setRuns((prev) => {
      const next = { ...prev }
      if (id) delete next[id]
      return next
    })
  const remove = (): void => {
    if (!id) return
    void window.api.mapDelete(id).then(() => {
      void refreshList()
      fetchMap(id)
    })
  }
  const select = (s: Selection): void => setSelection(s)

  if (!maps)
    return (
      <main className="flex-1 px-7 pt-5" aria-busy aria-label="Loading system maps">
        <Skeleton className="h-9 w-[520px] max-w-full" />
        <Skeleton className="mt-6 h-64 rounded-xl" />
      </main>
    )
  if (!repos.length)
    return (
      <main className="grid flex-1 place-items-center p-10">
        <div className="grid max-w-md gap-2 text-center">
          <Network className="mx-auto size-8 text-muted-foreground" aria-hidden />
          <h1 className="text-lg font-semibold">No repository to map yet</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            The system map is drawn from the repositories of your pull requests. Once {account} has a pull request to review or one of its own, its repository
            appears here.
          </p>
        </div>
      </main>
    )

  const behind = freshness?.behind ?? null
  const moved = !!map && !!freshness?.head && freshness.head !== map.headSha

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-7 py-3">
        <h1 className="mr-2 text-xl font-semibold tracking-tight">System map</h1>
        <Select
          value={repo ?? undefined}
          onValueChange={(r) => {
            setRepo(r)
            setBranch(maps.find((m) => m.repo === r)?.branch ?? null)
          }}
        >
          <SelectTrigger size="sm" className="max-w-[300px]" aria-label="Repository">
            <SelectValue placeholder="Choose a repository" />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            {repos.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
                {mappedRepos.has(r) && <span className="text-xs text-primary">mapped</span>}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <BranchPicker
          branches={branches?.repo === repo ? branches.data : null}
          loading={!branches || branches.repo !== repo || (!branches.data && !branches.error)}
          error={branches?.repo === repo ? branches.error : null}
          value={branch}
          mapped={mappedBranches}
          hinted={hintedBranches}
          onChange={setBranch}
        />

        {map && loadedId === id && (
          <div className="ml-auto flex items-center gap-2.5 text-xs text-muted-foreground">
            <span title={`The map describes commit ${map.headSha}`}>
              at <span className="font-mono">{map.headSha.slice(0, 7)}</span> · updated {ago(map.updatedAt)}
            </span>
            <ClaudeOptions kind="map" disabled={scanning} />
            {scanning ? null : moved ? (
              <Button size="sm" onClick={() => scan('update')}>
                <RefreshCw aria-hidden />
                {behind ? `Update from ${plural(behind, 'new commit')}` : 'Update from new commits'}
              </Button>
            ) : freshness?.head ? (
              <Badge className="bg-ready-bg text-ready">
                <Check aria-hidden />
                Up to date
              </Badge>
            ) : freshness ? (
              <span title="GitHub could not be reached, or the branch no longer exists there.">Could not check for new commits</span>
            ) : (
              <span>Checking for new commits…</span>
            )}
          </div>
        )}
      </div>

      {failed && (
        <div className="flex items-center gap-2.5 border-b border-danger/30 bg-danger-bg px-7 py-2 text-xs text-danger" role="alert">
          <CircleAlert className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            {failed.step}: {failed.error}
          </span>
          <Button variant="outline" size="xs" className="border-danger/40 bg-transparent text-danger hover:bg-danger/10 hover:text-danger" onClick={() => scan(map ? 'update' : 'scan')}>
            Try again
          </Button>
          <Button variant="ghost" size="icon-xs" className="text-danger hover:bg-danger/10 hover:text-danger" aria-label="Dismiss" onClick={dismiss}>
            <X aria-hidden />
          </Button>
        </div>
      )}

      {!branch ? (
        <div className="grid flex-1 place-items-center p-10 text-sm text-muted-foreground">
          {branches?.repo === repo && branches.error ? `Could not list the branches: ${branches.error}` : 'Loading branches…'}
        </div>
      ) : loadedId !== id ? (
        <div className="flex-1 px-7 pt-5" aria-busy>
          <Skeleton className="h-64 rounded-xl" />
        </div>
      ) : !map ? (
        scanning ? (
          <ScanCard run={run!} onStop={stop} />
        ) : (
          <div className="grid flex-1 place-items-center overflow-auto p-10">
            <div className="grid max-w-lg gap-3 rounded-xl border bg-card p-6">
              <Network className="size-7 text-primary" aria-hidden />
              <h2 className="text-base font-semibold">
                Map {repo} on {branch}
              </h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Claude reads the branch and draws two linked views. <strong className="font-medium text-foreground">System</strong> shows what it is built from: entry
                points, services, background jobs, data stores and outside services, and how they connect. <strong className="font-medium text-foreground">Features</strong>{' '}
                shows what it does, and which parts of the system each feature runs through.
              </p>
              <p className="text-sm leading-relaxed text-muted-foreground">
                The first scan takes a few minutes. After that the map follows the branch: when new commits land, an update reads only those.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => scan('scan')}>
                  <ScanSearch aria-hidden />
                  Scan this branch
                </Button>
                <ClaudeOptions kind="map" />
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                A scan is many Claude runs, one for every few parts of the system, so the model matters. The menu beside the button sets the model, the effort and how
                deep the scan goes; a quick scan on a smaller model uses far less.
              </p>
            </div>
          </div>
        )
      ) : (
        <>
          {scanning && <ScanStrip run={run!} onStop={stop} />}
          <div className="flex min-h-0 flex-1">
            <div className="min-w-0 flex-1 overflow-auto px-7 pt-4 pb-10">
              <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
                <Tabs value={view} onValueChange={(v) => setView(v as View)}>
                  <TabsList>
                    <TabsTrigger value="system">
                      <Network aria-hidden />
                      System
                    </TabsTrigger>
                    <TabsTrigger value="features">
                      <Waypoints aria-hidden />
                      Features
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find on the map" aria-label="Find on the map" className="h-8 w-48 pl-8" />
                </div>
                <div className="ml-auto flex items-center gap-2">
                  {view === 'system' ? (
                    <>
                      <Switch id="map-connections" size="sm" checked={connections} onCheckedChange={setConnections} />
                      <Label htmlFor="map-connections" className="text-xs font-normal text-muted-foreground">
                        All connections
                      </Label>
                    </>
                  ) : (
                    <>
                      <Switch id="map-expand" size="sm" checked={expandAll} onCheckedChange={setExpandAll} />
                      <Label htmlFor="map-expand" className="text-xs font-normal text-muted-foreground">
                        Components of every feature
                      </Label>
                    </>
                  )}
                </div>
              </div>
              {view === 'system' ? (
                // What it does beside what it is built from: a feature picked on the left is traced over the system on the right.
                <div className="flex items-start gap-4">
                  <FeatureRail map={map} selection={selection} onSelect={select} fresh={fresh} query={query} />
                  <div className="min-w-0 flex-1">
                    <SystemView map={map} selection={selection} onSelect={select} fresh={fresh} query={query} connections={connections} />
                  </div>
                </div>
              ) : (
                <FeatureView map={map} selection={selection} onSelect={select} fresh={fresh} query={query} expandAll={expandAll} />
              )}
            </div>
            <MapDetail
              map={map}
              selection={selection}
              onSelect={select}
              fresh={fresh}
              view={view}
              onView={setView}
              actions={
                <div className="flex flex-wrap gap-2 border-t pt-4">
                  <Confirm
                    title="Scan this branch again from scratch?"
                    description="Claude reads the whole branch again and draws a new map in place of this one, which takes a few minutes. For new commits an update is enough; scan again when the map has drifted from the code."
                    action="Scan again"
                    onConfirm={() => scan('scan')}
                  >
                    <Button variant="outline" size="xs" disabled={scanning}>
                      <RotateCcw aria-hidden />
                      Scan again from scratch
                    </Button>
                  </Confirm>
                  <Confirm
                    title="Delete this map?"
                    description={`The map of ${repo} on ${branch} is removed, with its history. The code is not touched. Drawing it again takes a few minutes.`}
                    action="Delete map"
                    onConfirm={remove}
                  >
                    <Button variant="outline" size="xs" className="text-danger hover:text-danger">
                      <Trash2 aria-hidden />
                      Delete map
                    </Button>
                  </Confirm>
                </div>
              }
            />
          </div>
        </>
      )}
    </main>
  )
}
