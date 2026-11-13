import { useState } from 'react'
import { ChevronRight, CircleAlert, CircleCheck, CircleDashed, CircleX, RotateCw } from 'lucide-react'
import type { CheckLog, FailingCheck, PrSummary } from '../../shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { cleanError } from './util'
import { groupChecks, type CheckGroup } from './checkGroups'

type CiProps = Pick<PrSummary, 'ci' | 'failingChecks' | 'ciBlocksMerge'>

// Red is for failures that stop the merge; amber for ones that do not.
const tone = (blocking: boolean) =>
  blocking
    ? { solid: 'bg-danger text-background', soft: 'border-danger/40 bg-danger-bg text-danger', hover: 'hover:border-danger', text: 'text-danger' }
    : { solid: 'bg-action text-background', soft: 'border-action/40 bg-action-bg text-action', hover: 'hover:border-action', text: 'text-action' }

/** A failed check blocks unless GitHub told us it is not required; without that answer the pull request decides. */
const blocks = (check: FailingCheck, pr: CiProps): boolean => check.required ?? pr.ciBlocksMerge

function Headline({ pr }: { pr: CiProps }) {
  if (pr.ci === 'success')
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-ready">
        <CircleCheck className="size-3.5" aria-hidden />
        Checks passed
      </span>
    )
  if (pr.ci === 'pending')
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <CircleDashed className="size-3.5" aria-hidden />
        Checks running
      </span>
    )
  const Icon = pr.ciBlocksMerge ? CircleX : CircleAlert
  return (
    <Badge className={cn('gap-1', tone(pr.ciBlocksMerge).solid)}>
      <Icon aria-hidden />
      {pr.ciBlocksMerge ? 'CI failing' : 'CI failing, can still merge'}
    </Badge>
  )
}

/** One line for a dashboard row: green when CI passed, otherwise what failed. Each failed check opens its run on GitHub. */
export function CiStatus({ pr, className, limit = 3 }: { pr: CiProps; className?: string; limit?: number }) {
  if (pr.ci === 'none') return null
  const shown = pr.ci === 'failure' ? pr.failingChecks.slice(0, limit) : []
  const hidden = pr.ci === 'failure' ? pr.failingChecks.length - shown.length : 0
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      <Headline pr={pr} />
      {shown.map((c, i) => {
        const t = tone(blocks(c, pr))
        const classes = cn('max-w-72 font-medium', t.soft)
        const title = `${c.name}${c.required === true ? ' (required)' : c.required === false ? ' (not required)' : ''}`
        return c.url ? (
          <Badge key={i} variant="outline" asChild className={cn(classes, 'cursor-pointer', t.hover)}>
            <button
              title={`${title}. Opens the failed run.`}
              onClick={(e) => {
                e.stopPropagation()
                void window.api.openExternal(c.url!)
              }}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <span className="truncate">{c.name}</span>
            </button>
          </Badge>
        ) : (
          <Badge key={i} variant="outline" className={classes} title={title}>
            <span className="truncate">{c.name}</span>
          </Badge>
        )
      })}
      {hidden > 0 && <span className={cn('text-xs', tone(pr.ciBlocksMerge).text)}>and {hidden} more</span>}
    </div>
  )
}

const linkButton = 'h-auto rounded-sm px-1 py-0.5 text-[13px] font-normal'

type LogState = { state: 'loading' } | { state: 'error'; error: string } | { state: 'done'; log: CheckLog }

type RerunState = { state: 'idle' } | { state: 'running' } | { state: 'started' } | { state: 'error'; error: string }

/** Starts a re-run on GitHub and remembers how it went, so the button can say so. */
function useRerun(start: () => Promise<void>): [RerunState, () => void] {
  const [rerun, setRerun] = useState<RerunState>({ state: 'idle' })
  const go = (): void => {
    setRerun({ state: 'running' })
    start().then(
      () => setRerun({ state: 'started' }),
      (e) => setRerun({ state: 'error', error: cleanError(e) })
    )
  }
  return [rerun, go]
}

function RerunNote({ rerun }: { rerun: RerunState }) {
  if (rerun.state === 'started')
    return <span className="text-xs text-muted-foreground">Re-run started. The checks update on the next refresh.</span>
  if (rerun.state === 'error') return <span className="text-xs text-danger">Could not re-run. {rerun.error}</span>
  return null
}

function CheckRow({ check, label, pr }: { check: FailingCheck; label: string; pr: PrSummary }) {
  const [open, setOpen] = useState(false)
  const [log, setLog] = useState<LogState | null>(null)
  const blocking = blocks(check, pr)
  const Icon = blocking ? CircleX : CircleAlert
  const jobId = check.jobId
  const [rerun, startRerun] = useRerun(() => window.api.rerunJob(pr.account, pr.repo, jobId!))

  const toggle = (): void => {
    setOpen(!open)
    if (log || check.jobId === null) return
    setLog({ state: 'loading' })
    window.api.checkLog(pr.account, pr.repo, check.jobId).then(
      (l) => setLog({ state: 'done', log: l }),
      (e) => setLog({ state: 'error', error: cleanError(e) })
    )
  }

  return (
    <li className="text-[13px]">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
        <Icon className={cn('size-3.5 shrink-0', tone(blocking).text)} aria-hidden />
        <span className="min-w-0 font-medium break-words">{label}</span>
        {check.required !== null && (
          <span className={cn('text-xs', check.required ? 'font-semibold text-danger' : 'text-muted-foreground')}>
            {check.required ? 'Required' : 'Not required'}
          </span>
        )}
        {check.jobId !== null && (
          <Button variant="link" className={linkButton} onClick={toggle} aria-expanded={open}>
            {open ? 'Hide log' : 'Show why it failed'}
          </Button>
        )}
        {check.url && (
          <Button variant="link" className={linkButton} onClick={() => void window.api.openExternal(check.url!)}>
            Open run
          </Button>
        )}
        {jobId !== null && rerun.state !== 'started' && (
          <Button variant="link" className={linkButton} onClick={startRerun} disabled={rerun.state === 'running'}>
            {rerun.state === 'running' ? 'Re-running…' : 'Re-run'}
          </Button>
        )}
        <RerunNote rerun={rerun} />
      </div>
      {open && log && (
        <div className="mt-1.5 mb-1 ml-6 overflow-hidden rounded-md border bg-background">
          {log.state === 'loading' && <p className="px-3 py-2 text-xs text-muted-foreground">Loading the log…</p>}
          {log.state === 'error' && <p className="px-3 py-2 text-xs text-danger">Could not load the log. {log.error}</p>}
          {log.state === 'done' && (
            <>
              {log.log.step && (
                <p className="border-b px-3 py-1.5 text-xs">
                  <span className="text-muted-foreground">Failed at step</span>{' '}
                  <span className="font-semibold">{log.log.step}</span>
                </p>
              )}
              {log.log.excerpt ? (
                <pre className="max-h-64 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
                  {log.log.excerpt}
                </pre>
              ) : (
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  The log is not available{log.log.logError ? ` (${log.log.logError})` : ''}. Open the run to see it on GitHub.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </li>
  )
}

/** One workflow's failed jobs under its name, with a button that re-runs them all. */
function WorkflowGroup({ group, pr }: { group: CheckGroup; pr: PrSummary }) {
  const [rerun, startRerun] = useRerun(() => window.api.rerunFailedJobs(pr.account, pr.repo, group.runIds))
  const runUrl = group.checks.find((c) => c.check.url)?.check.url?.replace(/\/job\/\d+.*$/, '')
  const n = group.checks.length
  return (
    <li className="grid gap-1">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[13px]">
        <span className="font-semibold">{group.workflow}</span>
        <span className="text-xs text-muted-foreground">{n === 1 ? '1 failed job' : `${n} failed jobs`}</span>
        {runUrl && (
          <Button variant="link" className={linkButton} onClick={() => void window.api.openExternal(runUrl)}>
            Open workflow run
          </Button>
        )}
        {group.runIds.length > 0 && rerun.state !== 'started' && (
          <Button variant="link" className={linkButton} onClick={startRerun} disabled={rerun.state === 'running'}>
            {rerun.state === 'running' ? 'Re-running…' : n === 1 ? 'Re-run failed job' : 'Re-run failed jobs'}
          </Button>
        )}
        <RerunNote rerun={rerun} />
      </div>
      <ul className="ml-1 grid gap-1 border-l pl-3">
        {group.checks.map(({ check, label }, i) => (
          <CheckRow key={check.url ?? `${check.name}-${i}`} check={check} label={label} pr={pr} />
        ))}
      </ul>
    </li>
  )
}

/** The pull request page's CI section: the verdict, whether it stops the merge, and each failed check with its log. */
export function CiDetails({ pr, className }: { pr: PrSummary; className?: string }) {
  // Lists saved by older versions have no run ids; those checks simply cannot be re-run from here.
  const runIds = [...new Set(pr.failingChecks.map((c) => c.runId).filter((id): id is number => id != null))]
  const [rerun, startRerun] = useRerun(() => window.api.rerunFailedJobs(pr.account, pr.repo, runIds))
  if (pr.ci === 'none') return null
  if (pr.ci !== 'failure')
    return (
      <div className={className}>
        <Headline pr={pr} />
      </div>
    )
  const required = pr.failingChecks.filter((c) => c.required).length
  const count = pr.failingChecks.length
  const workflows = groupChecks(pr.failingChecks).filter((g) => g.workflow).length
  return (
    <Collapsible className={cn('grid gap-1.5', className)}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <Headline pr={pr} />
        <span className="text-xs text-muted-foreground">
          {pr.ciBlocksMerge
            ? required
              ? `Merging is blocked until ${required === 1 ? 'the required check passes' : `the ${required} required checks pass`}.`
              : 'Merging is blocked until the checks pass.'
            : 'None of the failing checks is required, so they do not stop the merge.'}
        </span>
        {count > 0 && (
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="xs" className="group text-muted-foreground">
              <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" aria-hidden />
              {count === 1 ? '1 failed check' : `${count} failed checks`}
              {workflows > 1 && ` in ${workflows} workflows`}
            </Button>
          </CollapsibleTrigger>
        )}
        {runIds.length > 0 && rerun.state !== 'started' && (
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            title="Re-run the failed GitHub Actions jobs of this pull request"
            onClick={startRerun}
            disabled={rerun.state === 'running'}
          >
            <RotateCw className={cn(rerun.state === 'running' && 'animate-spin')} aria-hidden />
            {rerun.state === 'running' ? 'Re-running…' : 'Re-run failed jobs'}
          </Button>
        )}
        <RerunNote rerun={rerun} />
      </div>
      {count > 0 && (
        <CollapsibleContent asChild>
          <ul className="grid max-h-[40vh] gap-2 overflow-auto">
            {groupChecks(pr.failingChecks).map((g) =>
              g.workflow ? (
                <WorkflowGroup key={g.key} group={g} pr={pr} />
              ) : (
                <CheckRow key={g.key} check={g.checks[0].check} label={g.checks[0].label} pr={pr} />
              )
            )}
          </ul>
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}
