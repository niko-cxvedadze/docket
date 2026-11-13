import { History, NotebookPen } from 'lucide-react'
import { OnGitHub } from './OnGitHub'
import type { PostedReview, Verdict } from '../../shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { Markdown } from './Markdown'
import { ago } from './util'

const VERDICT: Record<Verdict, { label: string; className: string }> = {
  approve: { label: 'Approved', className: 'border-ready/40 bg-ready-bg text-ready' },
  request_changes: { label: 'Changes requested', className: 'border-danger/40 bg-danger-bg text-danger' },
  comment: { label: 'Commented', className: 'border-border bg-secondary text-foreground' }
}

const count = (n: number): string => `${n} ${n === 1 ? 'comment' : 'comments'}`

/** The bar over the Review tab: which review is on screen, and the reviews posted before. */
export function ReviewHistoryBar({
  reviews,
  viewing,
  onView
}: {
  reviews: PostedReview[]
  /** The posted review on screen, or null for the current draft. */
  viewing: PostedReview | null
  onView: (review: PostedReview | null) => void
}) {
  return (
    <div className="flex items-center gap-1 border-b px-3 py-1.5">
      <span className="min-w-0 flex-1 truncate text-xs font-medium">
        {viewing ? `Posted ${ago(viewing.at)}` : 'Current review'}
      </span>
      {viewing && (
        <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => onView(null)}>
          <NotebookPen aria-hidden />
          Back to current
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs" className="text-muted-foreground" disabled={!reviews.length}>
            <History aria-hidden />
            History{reviews.length ? ` (${reviews.length})` : ''}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 w-72 overflow-auto">
          <DropdownMenuLabel className="text-xs text-muted-foreground">Reviews you posted on this pull request</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onView(null)} className={cn(!viewing && 'bg-accent')}>
            <NotebookPen aria-hidden />
            Current review
          </DropdownMenuItem>
          {reviews.map((r) => (
            <DropdownMenuItem key={r.id} onSelect={() => onView(r)} className={cn('grid gap-0.5', viewing?.id === r.id && 'bg-accent')}>
              <span className="text-[13px]">
                {VERDICT[r.verdict].label}, {count(r.comments.length)}
              </span>
              <span className="text-xs text-muted-foreground">
                {ago(r.at)} · {new Date(r.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** A posted review, read-only, exactly as it went to GitHub. */
export function PostedReviewView({ review, onJump }: { review: PostedReview; onJump: (path: string, line: number) => void }) {
  const verdict = VERDICT[review.verdict]
  return (
    <div className="grid content-start gap-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={verdict.className}>
          {verdict.label}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {new Date(review.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
          {review.model || review.effort ? `, drafted with ${[review.model, review.effort && `${review.effort} effort`].filter(Boolean).join(', ')}` : ''}
        </span>
        <OnGitHub url={review.url} icon className="ml-auto" />
      </div>
      {review.body.trim() ? (
        <div className="rounded-lg border bg-background p-3">
          <Markdown text={review.body} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No summary.</p>
      )}
      <h3 className="mt-1 flex items-baseline gap-2 font-semibold">
        Comments <span className="count">{review.comments.length}</span>
      </h3>
      {review.comments.length === 0 && <p className="text-xs text-muted-foreground">No line comments.</p>}
      <ul className="grid gap-2">
        {review.comments.map((c, i) => (
          <li key={i} className="grid gap-1.5 rounded-lg border bg-background p-3">
            <Button
              variant="link"
              size="xs"
              className="h-auto justify-self-start px-0 font-mono text-xs"
              title="Show it in the diff"
              onClick={() => onJump(c.path, c.line)}
            >
              {c.path}:{c.line}
            </Button>
            <Markdown text={c.body} />
          </li>
        ))}
      </ul>
    </div>
  )
}
