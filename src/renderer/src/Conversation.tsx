import { memo, useMemo, useState } from 'react'
import { ChevronsUpDown, CircleCheck, CircleX, Eye, GitCommitHorizontal, MessageSquare, type LucideIcon } from 'lucide-react'
import type { PrComment, PrCommit, PrDetail, PrReview, PrSummary } from '../../shared/types'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { OnGitHub } from './OnGitHub'
import { Author, Avatar } from './Author'
import { Description, GithubHtml } from './Description'
import { Markdown } from './Markdown'
import { CopyOne, ExistingThread, useSelectable } from './ThreadView'
import { commentKey, reviewKey, type Thread } from './threads'
import { ago } from './util'

/** One entry of the conversation, in the order things happened. */
type Item =
  | { kind: 'commits'; at: string; commits: PrCommit[] }
  | { kind: 'comment'; at: string; comment: PrComment }
  /** A review with the conversations it started. `review` is null when GitHub listed the comments but not their review. */
  | { kind: 'review'; at: string; review: PrReview | null; threads: Thread[] }

function timelineOf(detail: PrDetail, all: Thread[]): Item[] {
  const started = new Map<number | null, Thread[]>()
  for (const t of all) {
    const id = t.comments[0].reviewId
    started.set(id, [...(started.get(id) ?? []), t])
  }
  const items: Item[] = []
  const known = new Set<number>()
  for (const review of detail.reviews) {
    known.add(review.id)
    const threads = started.get(review.id) ?? []
    // A reply in a conversation is submitted as a review of its own with nothing else in it; the reply already shows there.
    if (!threads.length && !review.body.trim() && review.state === 'commented') continue
    items.push({ kind: 'review', at: review.submittedAt, review, threads })
  }
  for (const [id, threads] of started)
    if (id === null || !known.has(id)) items.push({ kind: 'review', at: threads[0].comments[0].createdAt, review: null, threads })
  for (const comment of detail.conversation) items.push({ kind: 'comment', at: comment.createdAt, comment })
  for (const commit of detail.commits) items.push({ kind: 'commits', at: commit.committedAt, commits: [commit] })
  items.sort((a, b) => a.at.localeCompare(b.at))
  // Commits pushed one after another read as one group, as on GitHub.
  const out: Item[] = []
  for (const item of items) {
    const last = out[out.length - 1]
    if (item.kind === 'commits' && last?.kind === 'commits') last.commits.push(...item.commits)
    else out.push(item)
  }
  return out
}

const REVIEW: Record<PrReview['state'], { Icon: LucideIcon; verb: string; className: string }> = {
  approved: { Icon: CircleCheck, verb: 'approved these changes', className: 'text-ready' },
  changes_requested: { Icon: CircleX, verb: 'requested changes', className: 'text-danger' },
  commented: { Icon: Eye, verb: 'reviewed', className: 'text-muted-foreground' },
  dismissed: { Icon: Eye, verb: 'reviewed, since dismissed', className: 'text-muted-foreground' }
}

/** A comment or a review summary: who said it and when, then what they said. */
function Entry({
  selectKey,
  Icon,
  iconClass,
  author,
  verb,
  at,
  url,
  body,
  html
}: {
  /** Set when there is text to copy, which makes the entry selectable. */
  selectKey?: string
  Icon: LucideIcon
  iconClass?: string
  author: { login: string; avatarUrl: string }
  verb: string
  at: string
  url: string
  body: string
  /** The same text as GitHub renders it, when it sent that. */
  html: string
}) {
  const select = useSelectable(selectKey)
  return (
    <div
      {...select.props}
      className={cn('overflow-hidden rounded-md border bg-card transition-colors', select.on && 'border-primary bg-tint')}
    >
      <div className={cn('flex items-center gap-2 px-2.5 py-1.5 text-xs', !select.on && 'bg-secondary', body.trim() && 'border-b')}>
        <Icon className={cn('size-3.5 shrink-0', iconClass ?? 'text-muted-foreground')} aria-hidden />
        <Author author={author} className="font-semibold" />
        <span className="min-w-0 truncate text-muted-foreground">
          {verb} {ago(at)}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {selectKey && <CopyOne id={selectKey} what="comment" />}
          <OnGitHub url={url} />
        </span>
      </div>
      {body.trim() &&
        (html.trim() ? <GithubHtml html={html} className="text-[13px]" /> : <Markdown text={body} className="px-3 py-2.5 text-[13px]" />)}
    </div>
  )
}

/** A long push shows its latest commits; the earlier ones are one click away. */
const COMMITS_SHOWN = 6

/** Commits pushed together, as one card in the same style as the comments around it. */
function Commits({ commits }: { commits: PrCommit[] }) {
  const [all, setAll] = useState(false)
  const hidden = all || commits.length <= COMMITS_SHOWN + 1 ? 0 : commits.length - COMMITS_SHOWN
  const authors = [...new Map(commits.map((c) => [c.author, c])).values()]
  const latest = commits[commits.length - 1]
  return (
    <div className="overflow-hidden rounded-md border bg-card">
      <div className="flex items-center gap-2 border-b bg-secondary px-2.5 py-1.5 text-xs">
        <GitCommitHorizontal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        {authors.length === 1 ? (
          <Author author={{ login: authors[0].author, avatarUrl: authors[0].avatarUrl }} className="font-semibold" />
        ) : (
          <span className="font-semibold">{authors.length} people</span>
        )}
        <span className="min-w-0 truncate text-muted-foreground">
          pushed {commits.length === 1 ? 'a commit' : `${commits.length} commits`}
          {commits.length === 1 ? ` ${ago(latest.committedAt)}` : `, the latest ${ago(latest.committedAt)}`}
        </span>
      </div>
      {hidden > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-full justify-start rounded-none border-b px-3 text-xs font-normal text-muted-foreground"
          onClick={() => setAll(true)}
        >
          <ChevronsUpDown aria-hidden />
          Show {hidden} earlier {hidden === 1 ? 'commit' : 'commits'}
        </Button>
      )}
      <ul className="divide-y">
        {commits.slice(hidden).map((c) => (
          <li key={c.sha} className="flex items-center gap-2.5 px-3 py-2 text-[13px]">
            <Avatar url={c.avatarUrl} title={c.author} className="size-5" />
            <span className="min-w-0 flex-1 truncate font-medium" title={c.message}>
              {c.message}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">{ago(c.committedAt)}</span>
            <Button
              variant="outline"
              size="xs"
              className="mono shrink-0 font-normal"
              title={`Open commit ${c.sha.slice(0, 7)} by ${c.author} on GitHub`}
              onClick={() => void window.api.openExternal(c.url)}
            >
              {c.sha.slice(0, 7)}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The pull request as a conversation, the way GitHub's own first tab tells it: the description, then
 * commits, comments and reviews in the order they happened. Each review conversation shows the file
 * and lines it is on. Comments are selected for copying as rows are on the dashboard: Cmd-click.
 */
export const Conversation = memo(function Conversation({
  pr,
  detail,
  threads,
  onLocate
}: {
  pr: PrSummary
  detail: PrDetail
  /** The review conversations in `detail`, already grouped. */
  threads: Thread[]
  /** Shows a conversation where it sits in the changed files. */
  onLocate: (thread: Thread) => void
}) {
  const items = useMemo(() => timelineOf(detail, threads), [detail, threads])
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto grid max-w-[1000px] gap-3 px-4 pt-3.5 pb-16">
        {detail.truncated && (
          <div className="banner m-0">This pull request has more files than Docket loads. The rest are on GitHub.</div>
        )}
        <Description
          html={detail.bodyHtml}
          url={pr.url}
          className="mb-0"
          heading={
            <span className="inline-flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
              <Author author={pr.author} className="font-semibold text-foreground" />
              opened this pull request {ago(pr.createdAt)}
            </span>
          }
        />
        {items.map((item, i) =>
          item.kind === 'commits' ? (
            <Commits key={`commits-${item.commits[0].sha}`} commits={item.commits} />
          ) : item.kind === 'comment' ? (
            <Entry
              key={`comment-${item.comment.id}`}
              selectKey={item.comment.body.trim() ? commentKey(item.comment) : undefined}
              Icon={MessageSquare}
              author={{ login: item.comment.author, avatarUrl: item.comment.avatarUrl }}
              verb="commented"
              at={item.comment.createdAt}
              url={item.comment.url}
              body={item.comment.body}
              html={item.comment.bodyHtml}
            />
          ) : (
            <section key={item.review ? `review-${item.review.id}` : `threads-${i}`} className="grid gap-2">
              {item.review && (
                <Entry
                  selectKey={item.review.body.trim() ? reviewKey(item.review) : undefined}
                  Icon={REVIEW[item.review.state].Icon}
                  iconClass={REVIEW[item.review.state].className}
                  author={{ login: item.review.author, avatarUrl: item.review.avatarUrl }}
                  verb={REVIEW[item.review.state].verb}
                  at={item.review.submittedAt}
                  url={item.review.url}
                  body={item.review.body}
                  html={item.review.bodyHtml}
                />
              )}
              {item.threads.length > 0 && (
                <div className={cn('grid gap-2', item.review && 'pl-5')}>
                  {item.threads.map((t) => (
                    <ExistingThread key={t.id} thread={t} context onLocate={() => onLocate(t)} />
                  ))}
                </div>
              )}
            </section>
          )
        )}
      </div>
    </div>
  )
})
