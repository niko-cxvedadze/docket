import { useState } from 'react'
import { ChevronRight, CircleAlert, CircleCheck, CircleDashed, CircleX } from 'lucide-react'
import type { CheckLog, FailingCheck, PrSummary } from '../../shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { cleanError } from './util'

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

type LogState ={ state: 'loading' } | { state: 'error'; error: string } | { state: 'done'; log: CheckLog }

function CheckRow({ repo, check, pr }: { repo: string; check: FailingCheck; pr: CiProps }) {
  const [open, setOpen] = useState(false)
  const [log, setLog] = useState<LogState | null>(null)
  const blocking = blocks(check, pr)
  const Icon = blocking ? CircleX : CircleAlert

  const toggle = (): void => {
    setOpen(!open)
    if (log || check.jobId === null) return
    setLog({ state: 'loading' })
    window.api.checkLog(repo, check.jobId).then(
      (l) => setLog({ state: 'done', log: l }),
      (e) => setLog({ state: 'error', error: cleanError(e) })
    )
  }

  return (
    <li className="text-[13px]">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
        <Icon className={cn('size-3.5 shrink-0', tone(blocking).text)} aria-hidden />
        <span className="min-w-0 font-medium break-words">{check.name}</span>
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

/** The pull request page's CI section: the verdict, whether it stops the merge, and each failed check with its log. */
export function CiDetails({ pr, className }: { pr: PrSummary; className?: string }) {
  if (pr.ci === 'none') return null
  if (pr.ci !== 'failure')
    return (
      <div className={className}>
        <Headline pr={pr} />
      </div>
    )
  const required = pr.failingChecks.filter((c) => c.required).length
  const count = pr.failingChecks.length
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
            </Button>
          </CollapsibleTrigger>
        )}
      </div>
      {count > 0 && (
        <CollapsibleContent asChild>
          <ul className="grid max-h-[40vh] gap-1 overflow-auto">
            {pr.failingChecks.map((c, i) => (
              <CheckRow key={c.url ?? `${c.name}-${i}`} repo={pr.repo} check={c} pr={pr} />
            ))}
          </ul>
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}
