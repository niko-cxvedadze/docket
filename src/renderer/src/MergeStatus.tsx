import { Ban, CircleCheck, CircleDashed, Eye, EyeOff, GitMerge, MessageSquareWarning, UserRoundCheck } from 'lucide-react'
import type { PrSummary } from '../../shared/types'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

type Props = Pick<
  PrSummary,
  'approval' | 'approvedBy' | 'changesRequestedBy' | 'merge' | 'mergeBlockers' | 'isDraft' | 'role' | 'myReview' | 'draftState'
>

const people = (list: string[]): string =>
  list.length === 0 ? '' : list.length <= 2 ? ` by ${list.join(' and ')}` : ` by ${list[0]} and ${list.length - 1} more`

const sentence = (items: string[]): string => {
  const text = items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Where your own review stands on someone else's pull request. Solid and first in the row so it is seen at a glance. */
function mine(pr: Props) {
  if (pr.role !== 'review') return null
  if (pr.myReview === 'approved') return { Icon: CircleCheck, text: 'You approved', className: 'bg-ready text-background' }
  if (pr.myReview === 'changes_requested')
    return { Icon: MessageSquareWarning, text: 'You requested changes', className: 'bg-danger text-background' }
  if (pr.myReview === 'commented' || pr.draftState === 'posted')
    return { Icon: Eye, text: 'You reviewed (commented)', className: 'bg-primary text-primary-foreground' }
  return { Icon: EyeOff, text: 'You have not reviewed', className: 'border border-dashed border-border bg-transparent text-muted-foreground' }
}

/** On every pull request: have you reviewed it, has it been approved, and can it be merged right now. */
export function MergeStatus({ pr, className }: { pr: Props; className?: string }) {
  const approval =
    pr.approval === 'approved'
      ? { Icon: UserRoundCheck, text: `Approved${people(pr.approvedBy)}`, className: 'border-ready/40 bg-ready-bg text-ready' }
      : pr.approval === 'changes_requested'
        ? { Icon: MessageSquareWarning, text: `Changes requested${people(pr.changesRequestedBy)}`, className: 'border-danger/40 bg-danger-bg text-danger' }
        : { Icon: CircleDashed, text: pr.isDraft ? 'Draft' : 'Not approved yet', className: 'text-muted-foreground' }

  const merge =
    pr.merge === 'mergeable'
      ? { Icon: GitMerge, text: 'Mergeable', className: 'bg-ready text-background' }
      : pr.merge === 'pending'
        ? { Icon: CircleCheck, text: 'Mergeable once checks finish', className: 'bg-secondary text-muted-foreground' }
        : pr.merge === 'blocked'
          ? { Icon: Ban, text: `Blocked: ${sentence(pr.mergeBlockers).toLowerCase()}`, className: 'bg-danger text-background' }
          : null // not approved yet: the approval badge already says so

  const you = mine(pr)

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {you && (
        <Badge className={cn('gap-1 font-semibold', you.className)}>
          <you.Icon aria-hidden />
          {you.text}
        </Badge>
      )}
      <Badge variant="outline" className={cn('gap-1 font-medium', approval.className)}>
        <approval.Icon aria-hidden />
        {approval.text}
      </Badge>
      {merge && (
        <Badge className={cn('gap-1', merge.className)}>
          <merge.Icon aria-hidden />
          {merge.text}
        </Badge>
      )}
    </div>
  )
}
