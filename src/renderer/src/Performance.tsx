import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import type { Performance as Data } from '../../shared/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig
} from '@/components/ui/chart'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { ago, cleanError } from './util'

const RANGES = [4, 12, 26] as const
const WEEK = 7 * 86_400_000
const HOUR = 3_600_000

const median = (xs: number[]): number | null => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

const duration = (hours: number | null): string => {
  if (hours === null) return 'no data'
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`
  return `${(hours / 24).toFixed(1)}d`
}

/** Monday 00:00 local time of the week containing `t`. */
function weekStart(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.getTime()
}

/** A calendar month in local time, as "YYYY-MM". */
const monthKey = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
const monthStart = (key: string, offset = 0): Date => new Date(Number(key.slice(0, 4)), Number(key.slice(5)) - 1 + offset, 1)
const monthLabel = (key: string, offset = 0): string =>
  monthStart(key, offset).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

/** Either the last N weeks up to now, or one calendar month. */
type Period = { kind: 'weeks'; weeks: (typeof RANGES)[number] } | { kind: 'month'; month: string }

/** "owner/name" from a pull request key like "owner/name#123". */
const repoOf = (key: string): string => key.slice(0, key.lastIndexOf('#'))
/** The select cannot hold an empty value, so "every repository" travels under this name. */
const ALL = '__all__'

const dayLabel = (t: number): string => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

function Kpi({ title, value, previous, note }: { title: string; value: string; previous: string; note?: string }) {
  return (
    <Card className="gap-2 py-4 shadow-none">
      <CardHeader className="px-4">
        <CardTitle className="text-[13px] font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        <p className="text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{previous}</p>
        {note && <p className="mt-2 border-t pt-2 text-xs text-muted-foreground">{note}</p>}
      </CardContent>
    </Card>
  )
}

function ChartCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <Card className="gap-3 py-4 shadow-none">
      <CardHeader className="px-4">
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
        <CardDescription className="text-xs">{description}</CardDescription>
      </CardHeader>
      <CardContent className="px-4">{children}</CardContent>
    </Card>
  )
}

const axis = { tickLine: false, axisLine: false, tickMargin: 6, fontSize: 11 } as const

function WeeklyBars({ data, label }: { data: { week: string; value: number }[]; label: string }) {
  const config = { value: { label, color: 'var(--series-1)' } } satisfies ChartConfig
  return (
    <ChartContainer config={config} className="aspect-auto h-44 w-full">
      <BarChart data={data} margin={{ left: 0, right: 4, top: 4, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeOpacity={0.5} />
        <XAxis dataKey="week" minTickGap={28} {...axis} />
        <YAxis allowDecimals={false} width={28} {...axis} />
        <ChartTooltip cursor={{ fillOpacity: 0.08 }} content={<ChartTooltipContent labelFormatter={(l) => `Week of ${l}`} />} />
        <Bar dataKey="value" fill="var(--color-value)" radius={[4, 4, 0, 0]} maxBarSize={22} />
      </BarChart>
    </ChartContainer>
  )
}

function WeeklyDuration({ data, label }: { data: { week: string; value: number | null }[]; label: string }) {
  const config = { value: { label, color: 'var(--series-1)' } } satisfies ChartConfig
  return (
    <ChartContainer config={config} className="aspect-auto h-44 w-full">
      <LineChart data={data} margin={{ left: 0, right: 8, top: 6, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeOpacity={0.5} />
        <XAxis dataKey="week" minTickGap={28} {...axis} />
        <YAxis width={40} tickFormatter={(v: number) => duration(v)} {...axis} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(l) => `Week of ${l}`}
              formatter={(v) => (
                <span>
                  {label}: <strong className="tabular-nums">{duration(Number(v))}</strong>
                </span>
              )}
            />
          }
        />
        <Line
          dataKey="value"
          type="linear"
          stroke="var(--color-value)"
          strokeWidth={2}
          dot={{ r: 3, fill: 'var(--color-value)', strokeWidth: 0 }}
          activeDot={{ r: 5 }}
          connectNulls
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  )
}

/** Horizontal bars sharing one scale, largest first. */
function RepoBars({ rows }: { rows: { repo: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <ul className="grid h-44 content-start gap-2 overflow-auto">
      {rows.map((r) => (
        <li key={r.repo} className="grid grid-cols-[minmax(0,11rem)_1fr_2.5rem] items-center gap-2 text-xs">
          <span className="truncate" title={r.repo}>
            {r.repo}
          </span>
          <span className="h-2.5">
            <span className="block h-2.5 min-w-1 rounded-r-sm bg-[var(--series-1)]" style={{ width: `${(r.value / max) * 100}%` }} />
          </span>
          <span className="text-right tabular-nums text-muted-foreground">{r.value}</span>
        </li>
      ))}
    </ul>
  )
}

const queueConfig = {
  reviewQueue: { label: 'Reviews waiting on you', color: 'var(--series-1)' },
  blocked: { label: 'Your PRs blocked on you', color: 'var(--series-2)' }
} satisfies ChartConfig

export function Performance() {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [period, setPeriod] = useState<Period>({ kind: 'weeks', weeks: 12 })
  const [repo, setRepo] = useState('') // '' means every repository

  const load = useCallback(async (force: boolean) => {
    setLoading(true)
    try {
      setData(await window.api.performance(force))
      setError(null)
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => void load(false), [load])
  // While older months are still being fetched in the background, pick up what has arrived.
  useEffect(() => {
    if (!data?.partial) return
    const t = setInterval(() => void window.api.performance(false).then(setData, () => undefined), 20_000)
    return () => clearInterval(t)
  }, [data?.partial])

  const repos = useMemo(() => {
    if (!data) return []
    const all = new Set([...data.merged, ...data.reviews].map((x) => repoOf(x.key)))
    for (const c of data.commits) all.add(c.repo)
    return [...all].sort()
  }, [data])

  const view = useMemo(() => {
    if (!data) return null
    const inRepo = <T,>(items: T[], of: (x: T) => string): T[] => (repo ? items.filter((x) => of(x) === repo) : items)
    const allMerged = inRepo(data.merged, (m) => repoOf(m.key))
    const allReviews = inRepo(data.reviews, (r) => repoOf(r.key))
    const allCommits = inRepo(data.commits, (c) => c.repo)
    const now = Date.now()
    // The period shown is [from, to); the one it is compared with is [prevFrom, from).
    let from: number
    let to: number
    let prevFrom: number
    let label: string // completes "Nothing merged in …"
    let before: string // completes "12 in …"
    if (period.kind === 'weeks') {
      to = now + 1
      from = now - period.weeks * WEEK
      prevFrom = from - period.weeks * WEEK
      label = `the last ${period.weeks} weeks`
      before = `the ${period.weeks} weeks before`
    } else {
      from = monthStart(period.month).getTime()
      to = Math.min(monthStart(period.month, 1).getTime(), now + 1)
      prevFrom = monthStart(period.month, -1).getTime()
      label = monthLabel(period.month)
      before = monthLabel(period.month, -1)
    }
    const within = (iso: string, a: number, b: number): boolean => {
      const t = new Date(iso).getTime()
      return t >= a && t < b
    }
    const mergeHours = (m: Data['merged'][number]): number =>
      (new Date(m.mergedAt).getTime() - new Date(m.createdAt).getTime()) / HOUR

    const merged = allMerged.filter((m) => within(m.mergedAt, from, to))
    const mergedPrev = allMerged.filter((m) => within(m.mergedAt, prevFrom, from))
    const reviews = allReviews.filter((r) => within(r.submittedAt, from, to))
    const commits = allCommits.filter((c) => within(c.committedAt, from, to))
    const commitsPrev = allCommits.filter((c) => within(c.committedAt, prevFrom, from))
    const reviewsPrev = allReviews.filter((r) => within(r.submittedAt, prevFrom, from))
    const responses = (rs: Data['reviews']): number[] =>
      rs.filter((r) => r.responseHours !== null).map((r) => r.responseHours!)
    const firstReviewWait = merged
      .filter((m) => m.firstReviewAt)
      .map((m) => (new Date(m.firstReviewAt!).getTime() - new Date(m.createdAt).getTime()) / HOUR)
      .filter((h) => h >= 0)

    // The comparison period only exists if the history reaches back that far.
    const hasPrev = new Date(data.since).getTime() <= prevFrom + WEEK
    // Commits were added to the history later and are backfilled separately, so they can lag behind.
    const commitsFrom = new Date(data.commitsSince ?? Date.now()).getTime()
    const perRepo = new Map<string, number>()
    for (const c of commits) perRepo.set(c.repo, (perRepo.get(c.repo) ?? 0) + 1)
    const prev = (text: string): string => (hasPrev ? `${text} in ${before}` : 'No earlier period to compare')

    // Every week that overlaps the period, oldest first.
    const starts: number[] = []
    if (period.kind === 'weeks')
      for (let w = weekStart(now), i = 0; i < period.weeks; i++, w = weekStart(w - 86_400_000)) starts.unshift(w)
    else for (let w = weekStart(to - 1); w >= weekStart(from); w = weekStart(w - 86_400_000)) starts.unshift(w)
    const inWeek = (iso: string, start: number): boolean => weekStart(new Date(iso).getTime()) === start
    const weekly = starts.map((start) => {
      const m = merged.filter((x) => inWeek(x.mergedAt, start))
      const r = reviews.filter((x) => inWeek(x.submittedAt, start))
      return {
        week: dayLabel(start),
        merged: m.length,
        reviews: r.length,
        commits: commits.filter((x) => inWeek(x.committedAt, start)).length,
        mergeTime: median(m.map(mergeHours)),
        response: median(responses(r))
      }
    })

    const snapshots = data.snapshots
      .filter((s) => within(`${s.date}T12:00:00`, from, to))
      .map((s) => ({ ...s, day: dayLabel(new Date(`${s.date}T12:00:00`).getTime()) }))

    return {
      label,
      kpis: {
        merged: { value: String(merged.length), previous: prev(String(mergedPrev.length)) },
        mergeTime: {
          value: duration(median(merged.map(mergeHours))),
          previous: prev(duration(median(mergedPrev.map(mergeHours)))),
          note: firstReviewWait.length ? `First review arrives after ${duration(median(firstReviewWait))}` : undefined
        },
        reviews: {
          value: String(reviews.length),
          previous: prev(String(reviewsPrev.length)),
          note: `On ${new Set(reviews.map((r) => r.key)).size} pull requests`
        },
        response: {
          value: duration(median(responses(reviews))),
          previous: prev(duration(median(responses(reviewsPrev))))
        },
        commits: {
          value: String(commits.length),
          previous:
            commitsFrom > from + WEEK
              ? `Loaded back to ${dayLabel(commitsFrom)} so far`
              : commitsFrom <= prevFrom + WEEK
                ? `${commitsPrev.length} in ${before}`
                : 'No earlier period to compare',
          note: `In ${perRepo.size} ${perRepo.size === 1 ? 'repository' : 'repositories'}, on default branches`
        }
      },
      commitsByRepo: [...perRepo].map(([r, value]) => ({ repo: r, value })).sort((a, b) => b.value - a.value),
      recentCommits: [...commits].sort((a, b) => b.committedAt.localeCompare(a.committedAt)).slice(0, 12),
      weekly,
      snapshots,
      recent: [...merged].sort((a, b) => b.mergedAt.localeCompare(a.mergedAt)).slice(0, 8).map((m) => ({ ...m, hours: mergeHours(m) }))
    }
  }, [data, period, repo])

  // Months the stored history reaches, newest first.
  const months = useMemo(() => {
    const out: string[] = []
    const oldest = data ? monthKey(new Date(data.since)) : monthKey(new Date())
    for (let i = 0; i < 13; i++) {
      const key = monthKey(monthStart(monthKey(new Date()), -i))
      if (key < oldest) break
      out.push(key)
    }
    return out
  }, [data])

  return (
    <main className="flex-1 overflow-auto px-7 pt-5 pb-10">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-xl font-semibold tracking-tight">My performance</h1>
        {data && <span className="text-xs text-muted-foreground">History fetched {ago(data.fetchedAt)}</span>}
        <Tabs
          value={period.kind === 'weeks' ? String(period.weeks) : ''}
          onValueChange={(v) => setPeriod({ kind: 'weeks', weeks: Number(v) as (typeof RANGES)[number] })}
        >
          <TabsList>
            {RANGES.map((w) => (
              <TabsTrigger key={w} value={String(w)}>
                {w} weeks
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {(repos.length > 1 || repo) && (
          <Select value={repo || ALL} onValueChange={(v) => setRepo(v === ALL ? '' : v)}>
            <SelectTrigger size="sm" aria-label="Repository" className={cn('max-w-56 bg-card text-[13px]', repo && 'border-primary font-medium')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              <SelectItem value={ALL}>All repositories</SelectItem>
              {repos.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={period.kind === 'month' ? period.month : ''} onValueChange={(month) => month && setPeriod({ kind: 'month', month })}>
          <SelectTrigger
            size="sm"
            aria-label="Show one month"
            className={cn('bg-card text-[13px]', period.kind === 'month' && 'border-primary font-medium')}
          >
            <SelectValue placeholder="Month…" />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            {months.map((m, i) => (
              <SelectItem key={m} value={m}>
                {i === 0 ? `This month (${monthLabel(m)})` : monthLabel(m)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void load(true)}>
          {loading ? 'Fetching…' : 'Fetch latest'}
        </Button>
      </div>

      {error && (
        <div className="banner error mx-0! mb-4" role="alert">
          {error}
        </div>
      )}
      {data?.partial && (
        <div className="banner mx-0! mb-4" role="status">
          History is loaded back to {dayLabel(new Date(data.since).getTime())} so far. The rest of the year is being
          fetched in the background, slowly enough to stay inside GitHub's limits, and fills in here as it arrives.
        </div>
      )}
      {data?.truncated && (
        <div className="banner mx-0! mb-4">
          GitHub returned more history than Docket loads at once, so the oldest weeks may be undercounted.
        </div>
      )}

      {!view ? (
        !error && (
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">Fetching a year of your pull requests and reviews from GitHub. The last four weeks come first; older months follow in the background.</p>
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-28" />
              ))}
            </div>
            <Skeleton className="h-64" />
          </div>
        )
      ) : (
        <div className="grid gap-3">
          <section aria-label="Totals" className="grid grid-cols-2 gap-3 xl:grid-cols-5">
            <Kpi title="Pull requests merged" {...view.kpis.merged} />
            <Kpi title="Median time to merge" {...view.kpis.mergeTime} />
            <Kpi title="Reviews you gave" {...view.kpis.reviews} />
            <Kpi title="Median time to your first review" {...view.kpis.response} />
            <Kpi title="Commits" {...view.kpis.commits} />
          </section>

          <section className="grid grid-cols-1 gap-3 min-[1050px]:grid-cols-2">
            <ChartCard title="Pull requests merged" description="Your merged pull requests, per week">
              <WeeklyBars label="Merged" data={view.weekly.map((w) => ({ week: w.week, value: w.merged }))} />
            </ChartCard>
            <ChartCard title="Reviews you gave" description="Reviews submitted on other people's pull requests, per week">
              <WeeklyBars label="Reviews" data={view.weekly.map((w) => ({ week: w.week, value: w.reviews }))} />
            </ChartCard>
            <ChartCard title="Time to merge" description="Median time from opening to merge, by the week it merged">
              <WeeklyDuration label="Median" data={view.weekly.map((w) => ({ week: w.week, value: w.mergeTime }))} />
            </ChartCard>
            <ChartCard
              title="Time to your first review"
              description="Median time from being asked to your first review, by the week you reviewed"
            >
              <WeeklyDuration label="Median" data={view.weekly.map((w) => ({ week: w.week, value: w.response }))} />
            </ChartCard>
            <ChartCard title="Commits" description="Your commits that landed on a default branch, per week">
              <WeeklyBars label="Commits" data={view.weekly.map((w) => ({ week: w.week, value: w.commits }))} />
            </ChartCard>
            <ChartCard title="Commits by repository" description="Where those commits went in this period">
              {view.commitsByRepo.length === 0 ? (
                <p className="py-6 text-sm text-muted-foreground">No commits in {view.label}.</p>
              ) : (
                <RepoBars rows={view.commitsByRepo} />
              )}
            </ChartCard>
          </section>

          <ChartCard
            title="Open work over time"
            description={`Recorded by Docket once a day while it runs. GitHub does not keep this history.${repo ? ' Always counts every repository.' : ''}`}
          >
            {view.snapshots.length < 2 ? (
              <p className="py-6 text-sm text-muted-foreground">
                {data!.snapshots.length
                  ? `Docket started recording on ${dayLabel(new Date(`${data!.snapshots[0].date}T12:00:00`).getTime())}. This chart fills in as the days pass.`
                  : 'Nothing recorded yet. Open the dashboard once and Docket starts keeping a daily record.'}
              </p>
            ) : (
              <ChartContainer config={queueConfig} className="aspect-auto h-52 w-full">
                <LineChart data={view.snapshots} margin={{ left: 0, right: 8, top: 6, bottom: 0 }}>
                  <CartesianGrid vertical={false} strokeOpacity={0.5} />
                  <XAxis dataKey="day" minTickGap={28} {...axis} />
                  <YAxis allowDecimals={false} width={28} {...axis} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Line dataKey="reviewQueue" type="linear" stroke="var(--color-reviewQueue)" strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line dataKey="blocked" type="linear" stroke="var(--color-blocked)" strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </ChartContainer>
            )}
          </ChartCard>

          <ChartCard title="Recently merged" description={`Your last ${view.recent.length} merges in this period`}>
            {view.recent.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">Nothing merged in {view.label}.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Pull request</TableHead>
                    <TableHead className="w-28">Merged</TableHead>
                    <TableHead className="w-28 text-right">Time to merge</TableHead>
                    <TableHead className="w-32 text-right">Size</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.recent.map((m) => (
                    <TableRow key={m.key}>
                      <TableCell className="max-w-0">
                        <Button
                          variant="link"
                          className="block h-auto w-full truncate p-0 text-left font-normal text-foreground"
                          onClick={() => void window.api.openExternal(m.url)}
                        >
                          {m.title}
                        </Button>
                        <span className="font-mono text-xs text-muted-foreground">{m.key}</span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{ago(m.mergedAt)}</TableCell>
                      <TableCell className="text-right tabular-nums">{duration(m.hours)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        <span className="text-ready">+{m.additions}</span> <span className="text-danger">−{m.deletions}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </ChartCard>

          <ChartCard title="Recent commits" description={`Your last ${view.recentCommits.length} commits in this period`}>
            {view.recentCommits.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">No commits in {view.label}.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Commit</TableHead>
                    <TableHead className="w-56">Repository</TableHead>
                    <TableHead className="w-28">Committed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.recentCommits.map((c) => (
                    <TableRow key={c.sha}>
                      <TableCell className="max-w-0">
                        <Button
                          variant="link"
                          className="block h-auto w-full truncate p-0 text-left font-normal text-foreground"
                          onClick={() => void window.api.openExternal(c.url)}
                        >
                          {c.message}
                        </Button>
                        <span className="font-mono text-xs text-muted-foreground">{c.sha.slice(0, 7)}</span>
                      </TableCell>
                      <TableCell className="max-w-0 truncate text-muted-foreground">{c.repo}</TableCell>
                      <TableCell className="text-muted-foreground">{ago(c.committedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </ChartCard>
        </div>
      )}
    </main>
  )
}
