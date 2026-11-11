import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleX,
  GitMerge,
  GitPullRequestDraft,
  LoaderCircle,
  MessageSquareCheck,
  MessageSquareWarning,
  NotebookPen,
  UserRound,
  UserRoundCheck,
  type LucideIcon
} from 'lucide-react'
import type { PrSummary, ReviewProgress } from '../../shared/types'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { groupChecks } from './checkGroups'

const list = (names: string[]): string =>
  names.length <= 2 ? names.join(' and ') : `${names[0]}, ${names[1]} and ${names.length - 2} more`

/** Slot widths are fixed so the same kind of status lines up from row to row. Labels drop out when the row is narrow. */
const SLOT = {
  review: 'w-6 @[640px]:w-[7.25rem]',
  checks: 'w-9 @[640px]:w-[6.25rem]',
  merge: 'w-6 @[640px]:w-[6.75rem]',
  draft: 'w-6'
}

function Status({
  Icon,
  slot,
  className,
  text,
  count,
  label,
  children
}: {
  Icon: LucideIcon
  slot: keyof typeof SLOT
  className: string
  /** Short word shown beside the icon when there is room. */
  text?: string
  /** Shown beside the icon when the text is hidden. */
  count?: number
  label: string
  children?: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('flex h-6 items-center gap-1.5', SLOT[slot], className)} role="img" aria-label={label}>
          <Icon className="size-4 shrink-0" aria-hidden />
          {count !== undefined && <span className="text-[11px] font-semibold tabular-nums @[640px]:hidden">{count}</span>}
          {text && <span className="hidden truncate text-xs font-medium @[640px]:inline">{text}</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        <p className="font-medium">{label}</p>
        {children}
      </TooltipContent>
    </Tooltip>
  )
}

const Empty = ({ slot }: { slot: keyof typeof SLOT }) => <span className={cn('h-6', SLOT[slot])} aria-hidden />

/**
 * The standing of a pull request in four fixed columns: review, checks, merge, and your own review draft.
 * Colour carries the verdict (green good, red blocks, amber worth a look, grey nothing yet); a short
 * word says what it is, and hovering says the rest.
 */
export function StatusIcons({ pr, progress }: { pr: PrSummary; progress?: ReviewProgress }) {
  const failing = pr.failingChecks
  const groups = groupChecks(failing)
  return (
    <div className="flex shrink-0 items-center gap-3">
      {pr.isDraft ? (
        <Status slot="review" Icon={GitPullRequestDraft} className="text-muted-foreground" text="Draft" label="Draft pull request" />
      ) : pr.approval === 'approved' ? (
        <Status
          slot="review"
          Icon={UserRoundCheck}
          className="text-ready"
          text="Approved"
          label={pr.approvedBy.length ? `Approved by ${list(pr.approvedBy)}` : 'Approved'}
        />
      ) : pr.approval === 'changes_requested' ? (
        <Status
          slot="review"
          Icon={MessageSquareWarning}
          className="text-danger"
          text="Changes asked"
          label={pr.changesRequestedBy.length ? `Changes requested by ${list(pr.changesRequestedBy)}` : 'Changes requested'}
        />
      ) : (
        <Status slot="review" Icon={UserRound} className="text-muted-foreground" text="Not approved" label="Not approved yet" />
      )}

      {pr.ci === 'none' && <Empty slot="checks" />}
      {pr.ci === 'success' && <Status slot="checks" Icon={CircleCheck} className="text-ready" text="Passing" label="Checks passed" />}
      {pr.ci === 'pending' && (
        <Status slot="checks" Icon={LoaderCircle} className="text-muted-foreground [&>svg]:animate-spin [&>svg]:[animation-duration:1.4s] motion-reduce:[&>svg]:animate-none" text="Running" label="Checks running" />
      )}
      {pr.ci === 'failure' && (
        <Status
          slot="checks"
          Icon={pr.ciBlocksMerge ? CircleX : CircleAlert}
          className={pr.ciBlocksMerge ? 'text-danger' : 'text-action'}
          count={failing.length || undefined}
          text={failing.length ? `${failing.length} failing` : 'Failing'}
          label={pr.ciBlocksMerge ? 'Checks failing, merge blocked' : 'Checks failing, none required'}
        >
          {failing.length > 0 && (
            <ul className="mt-1 grid gap-0.5">
              {groups.slice(0, 6).map((g) => (
                <li key={g.key} className="truncate">
                  {g.workflow ?? g.checks[0].label}
                  {g.workflow && `: ${g.checks.length === 1 ? g.checks[0].label : `${g.checks.length} jobs`}`}
                  {g.required === true && ' (required)'}
                </li>
              ))}
              {groups.length > 6 && <li>and {groups.length - 6} more</li>}
            </ul>
          )}
        </Status>
      )}

      {pr.merge === 'mergeable' ? (
        <Status slot="merge" Icon={GitMerge} className="text-ready" text="Mergeable" label="Mergeable" />
      ) : pr.merge === 'pending' ? (
        <Status slot="merge" Icon={GitMerge} className="text-muted-foreground" text="After checks" label="Mergeable once checks finish" />
      ) : pr.merge === 'blocked' && !pr.isDraft ? (
        <Status slot="merge" Icon={Ban} className="text-danger" text="Blocked" label="Merge blocked">
          <p className="mt-1">{pr.mergeBlockers.join(', ')}</p>
        </Status>
      ) : (
        <Empty slot="merge" />
      )}

      {progress?.state === 'running' ? (
        <Status slot="draft" Icon={LoaderCircle} className="text-primary [&>svg]:animate-spin motion-reduce:[&>svg]:animate-none" label="Claude is reviewing" />
      ) : pr.draftState === 'draft' ? (
        <Status slot="draft" Icon={NotebookPen} className="text-primary" label="You have a review drafted" />
      ) : pr.draftState === 'stale' ? (
        <Status slot="draft" Icon={NotebookPen} className="text-action" label="Your review draft is behind new commits" />
      ) : pr.draftState === 'posted' ? (
        <Status slot="draft" Icon={MessageSquareCheck} className="text-ready" label="You posted a review" />
      ) : pr.role === 'review' && pr.myReview ? (
        <Status
          slot="draft"
          Icon={MessageSquareCheck}
          className={pr.myReview === 'changes_requested' ? 'text-danger' : pr.myReview === 'approved' ? 'text-ready' : 'text-primary'}
          label={pr.myReview === 'approved' ? 'You approved' : pr.myReview === 'changes_requested' ? 'You requested changes' : 'You reviewed'}
        />
      ) : (
        <Empty slot="draft" />
      )}
    </div>
  )
}
