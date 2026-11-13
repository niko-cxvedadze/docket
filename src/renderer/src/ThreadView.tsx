import { createContext, useContext, useMemo, useState } from 'react'
import { ChevronRight, CircleCheck, CircleDot, Copy, FileDiff } from 'lucide-react'
import type { ExistingComment } from '../../shared/types'
import type { DiffRow } from '../../shared/diff'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { OnGitHub } from './OnGitHub'
import { Author } from './Author'
import { Markdown } from './Markdown'
import { highlightLine, languageFor } from './highlight'
import { hunkTail, threadKey, whereOf, type Thread } from './threads'
import { ago } from './util'

/**
 * Which comments are selected for copying. Shared by the conversation and the diff, so a comment
 * selected in one shows as selected in the other. Works like selecting rows on the dashboard.
 */
export interface Selection {
  selected: ReadonlySet<string>
  /** Adds the comment to the selection, or takes it out again. */
  toggle: (key: string) => void
  /** Copies these comments to the clipboard as markdown. */
  copy: (keys: string[]) => void
}

export const SelectionContext = createContext<Selection>({ selected: new Set(), toggle: () => undefined, copy: () => undefined })

/** Links, buttons and players inside a card keep their own clicks. */
const ownsClick = (target: EventTarget): boolean => !!(target as HTMLElement).closest('a, button, input, textarea, video, summary')

/**
 * Makes a card selectable the way dashboard rows are: Cmd-click anywhere on it adds it to the
 * selection or takes it out. Spread `props` on the card. Without a key the card is not selectable.
 */
export function useSelectable(key: string | undefined): {
  on: boolean
  props: { onMouseDown: (e: React.MouseEvent) => void; onClick: (e: React.MouseEvent) => void; 'data-selected': true | undefined }
} {
  const { selected, toggle } = useContext(SelectionContext)
  const on = !!key && selected.has(key)
  const wanted = (e: React.MouseEvent): boolean => !!key && (e.metaKey || e.ctrlKey) && !ownsClick(e.target)
  return {
    on,
    props: {
      'data-selected': on || undefined,
      // A Cmd-click selects the card, so it must not start selecting the text under the pointer as well.
      onMouseDown: (e) => wanted(e) && e.preventDefault(),
      onClick: (e) => {
        if (!wanted(e)) return
        e.preventDefault()
        // The second click of a double-click would only undo the first.
        if (e.detail <= 1) toggle(key!)
      }
    }
  }
}

/**
 * Copies one comment as markdown. It is also the card's control for the keyboard: x selects the
 * comment, as it does on a dashboard row.
 */
export function CopyOne({ id, what }: { id: string; what: string }) {
  const { selected, toggle, copy } = useContext(SelectionContext)
  const label = `Copy this ${what} as markdown. ⌘-click ${what}s to select several.`
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="text-muted-foreground"
      title={label}
      aria-label={label}
      aria-pressed={selected.has(id)}
      onClick={() => copy([id])}
      onKeyDown={(e) => e.key === 'x' && toggle(id)}
    >
      <Copy aria-hidden />
    </Button>
  )
}

function ExistingCard({ comment, where, reply }: { comment: ExistingComment; where?: string; reply?: boolean }) {
  return (
    <div className={cn('grid gap-1', reply && 'mt-2 border-t pt-2')}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Author author={{ login: comment.author, avatarUrl: comment.avatarUrl }} className="font-semibold" />
        <span className="text-muted-foreground">
          {ago(comment.createdAt)}
          {where ? `, ${where}` : ''}
        </span>
        <OnGitHub url={comment.url} className="ml-auto" />
      </div>
      <Markdown text={comment.body} className="text-[13px]" />
    </div>
  )
}

/** The lines a conversation is about, drawn like the diff they came from. */
function HunkSnippet({ path, rows }: { path: string; rows: DiffRow[] }) {
  const html = useMemo(() => {
    const lang = languageFor(path)
    return rows.map((r) => highlightLine(r.text, lang))
  }, [path, rows])
  return (
    <table className="diff border-b bg-(--code-bg)">
      <colgroup>
        <col className="col-num" />
        <col className="col-num" />
        <col />
      </colgroup>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className={`row ${row.type}`}>
            <td className="num">{row.oldLine ?? ''}</td>
            <td className="num">{row.newLine ?? ''}</td>
            <td className="code">
              <span className="sign">{row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' '}</span>
              <span dangerouslySetInnerHTML={{ __html: html[i] }} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * Unresolved threads stay open and marked; resolved ones fold to one line, as on GitHub.
 * In the diff a thread sits under its line. In the conversation (`context`) it carries its own
 * place with it: the file, the lines, and the code it was written on.
 */
export function ExistingThread({
  thread,
  where,
  context,
  onLocate
}: {
  thread: Thread
  /** Said next to the first comment, for a thread that could not be put on its line. */
  where?: string
  context?: boolean
  /** Shows the thread where it sits in the changed files. */
  onLocate?: () => void
}) {
  const [open, setOpen] = useState(thread.resolved !== true)
  const key = threadKey(thread)
  const select = useSelectable(key)
  const [first, ...replies] = thread.comments
  const rows = useMemo(() => (context ? hunkTail(first) : []), [context, first])
  const place = whereOf(first)
  const status =
    thread.resolved === true ? (
      <Badge variant="outline" className="gap-1 border-ready/40 bg-ready-bg text-ready">
        <CircleCheck aria-hidden />
        Resolved{thread.resolvedBy ? ` by ${thread.resolvedBy}` : ''}
      </Badge>
    ) : thread.resolved === false ? (
      <Badge variant="outline" className="gap-1 border-action/40 bg-action-bg text-action">
        <CircleDot aria-hidden />
        Unresolved
      </Badge>
    ) : null
  return (
    <Collapsible
      id={`${context ? 'ct' : 't'}-${thread.id}`}
      open={open}
      onOpenChange={setOpen}
      {...select.props}
      className={cn(
        'transition-colors',
        context ? 'overflow-hidden rounded-md border bg-card' : 'existing',
        // After the border above, so the stripe keeps its width.
        'border-l-[3px]',
        thread.resolved === true ? 'border-l-ready/60' : thread.resolved === false ? 'border-l-action' : '',
        thread.resolved === true && !select.on && 'opacity-80',
        // The same look as a selected row on the dashboard; the stripe on the left keeps saying whether it is resolved.
        select.on && 'border-y-primary border-r-primary bg-tint'
      )}
    >
      <div className={cn('flex items-center gap-2', context ? cn('px-2.5 py-1.5', !select.on && 'bg-secondary', open && 'border-b') : 'mb-1.5')}>
        {context && (
          <span className="mono min-w-0 shrink truncate font-semibold" title={first.path}>
            {first.path}
          </span>
        )}
        {context && place && <span className="shrink-0 text-xs text-muted-foreground">{place}</span>}
        {status}
        {thread.outdated && (
          <Badge variant="outline" className="text-muted-foreground" title="The code under this conversation has changed since it was written">
            Outdated
          </Badge>
        )}
        {/* In the conversation the file and lines already say what a folded thread is; under a line of the diff, its first words do. */}
        {!open && !context && (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {first.author}: {first.body.split('\n')[0]}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {onLocate && (
            <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={onLocate}>
              <FileDiff aria-hidden />
              View in files
            </Button>
          )}
          <CopyOne id={key} what="conversation" />
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="xs" className="text-muted-foreground">
              <ChevronRight className={cn('transition-transform', open && 'rotate-90')} aria-hidden />
              {open ? 'Hide' : `Show ${thread.comments.length === 1 ? 'comment' : `${thread.comments.length} comments`}`}
            </Button>
          </CollapsibleTrigger>
        </span>
      </div>
      <CollapsibleContent>
        {rows.length > 0 && <HunkSnippet path={first.path} rows={rows} />}
        <div className={cn(context && 'px-3 py-2.5')}>
          <ExistingCard comment={first} where={where} />
          {replies.map((c) => (
            <ExistingCard key={c.id} comment={c} reply />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
