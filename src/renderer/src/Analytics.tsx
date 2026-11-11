import type { PrSummary } from '../../shared/types'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ago } from './util'

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const compact = (n: number): string => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

function Tile({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="gap-3 py-4 shadow-none">
      <CardHeader className="px-4">
        <CardTitle className="text-[13px] font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-4">{children}</CardContent>
    </Card>
  )
}

/** Horizontal bars sharing one scale, with the value written at the end of each row. */
function BarList({ rows, unit }: { rows: { label: string; value: number }[]; unit: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <ul className="grid gap-1.5">
      {rows.map((r) => (
        <li key={r.label}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="grid grid-cols-[minmax(0,7.5rem)_1fr_1.5rem] items-center gap-2 text-xs" tabIndex={0}>
                <span className="truncate">{r.label}</span>
                <span className="h-2">
                  {r.value > 0 && (
                    <span
                      className="block h-2 min-w-1 rounded-r-sm bg-primary"
                      style={{ width: `${(r.value / max) * 100}%` }}
                    />
                  )}
                </span>
                <span className="text-right tabular-nums text-muted-foreground">{r.value}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              {r.label}: {plural(r.value, unit)}
            </TooltipContent>
          </Tooltip>
        </li>
      ))}
    </ul>
  )
}

const DAY = 86_400_000

export function Analytics({ prs }: { prs: PrSummary[] }) {
  const mine = prs.filter((p) => p.role === 'mine')
  const queue = prs.filter((p) => p.role === 'review' && p.level !== 'waiting')
  const mineNeeds = mine.filter((p) => p.level !== 'waiting')

  const added = queue.reduce((n, p) => n + p.additions, 0)
  const removed = queue.reduce((n, p) => n + p.deletions, 0)
  const oldest = queue.reduce<PrSummary | null>((o, p) => (!o || p.createdAt < o.createdAt ? p : o), null)

  const states = [
    { label: 'Blocked on you', value: mine.filter((p) => p.level === 'action').length, color: 'bg-action' },
    { label: 'Ready to merge', value: mine.filter((p) => p.level === 'ready').length, color: 'bg-ready' },
    { label: 'Waiting on others', value: mine.filter((p) => p.level === 'waiting').length, color: 'bg-neutral-mark' }
  ]
  const failing = mine.filter((p) => p.ci === 'failure').length

  const now = Date.now()
  const age = (p: PrSummary): number => (now - new Date(p.createdAt).getTime()) / DAY
  const ages = [
    { label: 'Opened today', value: queue.filter((p) => age(p) < 1).length },
    { label: '1 to 3 days', value: queue.filter((p) => age(p) >= 1 && age(p) < 3).length },
    { label: '3 to 7 days', value: queue.filter((p) => age(p) >= 3 && age(p) < 7).length },
    { label: 'Over a week', value: queue.filter((p) => age(p) >= 7).length }
  ]

  const counts = new Map<string, number>()
  for (const p of queue) counts.set(p.author.login, (counts.get(p.author.login) ?? 0) + 1)
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const authors = ranked.slice(0, 4).map(([label, value]) => ({ label, value }))
  const others = ranked.slice(4)
  if (others.length)
    authors.push({ label: plural(others.length, 'other'), value: others.reduce((n, [, v]) => n + v, 0) })

  return (
    <section aria-label="Overview" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Tile title="Needs you now">
        <p className="text-4xl font-semibold tracking-tight tabular-nums">{mineNeeds.length + queue.length}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {mineNeeds.length} of yours, {queue.length} to review
        </p>
        {queue.length > 0 && (
          <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
            <span className="font-medium text-foreground tabular-nums">{compact(added + removed)} changed lines</span>{' '}
            to read. Oldest opened {oldest ? ago(oldest.createdAt) : ''}.
          </p>
        )}
      </Tile>

      <Tile title="Your pull requests">
        {mine.length === 0 ? (
          <p className="text-xs text-muted-foreground">You have no open pull requests.</p>
        ) : (
          <>
            <div className="flex h-3 gap-0.5" role="img" aria-label={states.map((s) => `${s.label}: ${s.value}`).join(', ')}>
              {states
                .filter((s) => s.value > 0)
                .map((s) => (
                  <Tooltip key={s.label}>
                    <TooltipTrigger asChild>
                      <span
                        className={`${s.color} h-3 min-w-1.5 first:rounded-l-sm last:rounded-r-sm`}
                        style={{ flexGrow: s.value, flexBasis: 0 }}
                      />
                    </TooltipTrigger>
                    <TooltipContent>
                      {s.label}: {s.value} of {mine.length}
                    </TooltipContent>
                  </Tooltip>
                ))}
            </div>
            <ul className="mt-3 grid gap-1 text-xs">
              {states.map((s) => (
                <li key={s.label} className="flex items-center gap-2">
                  <span className={`${s.color} size-2 rounded-xs`} aria-hidden />
                  <span className="flex-1">{s.label}</span>
                  <span className="tabular-nums text-muted-foreground">{s.value}</span>
                </li>
              ))}
            </ul>
            {failing > 0 && (
              <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{failing}</span> with failing checks
              </p>
            )}
          </>
        )}
      </Tile>

      <Tile title="Reviews waiting on you, by age">
        {queue.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nobody is waiting on a review from you.</p>
        ) : (
          <BarList rows={ages} unit="pull request" />
        )}
      </Tile>

      <Tile title="Who is waiting on you">
        {queue.length === 0 ? (
          <p className="text-xs text-muted-foreground">No one right now.</p>
        ) : (
          <BarList rows={authors} unit="pull request" />
        )}
      </Tile>
    </section>
  )
}
