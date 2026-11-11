import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DraftComment,
  ExistingComment,
  PrDetail,
  PrFile,
  PostedReview,
  PrSummary,
  ReviewDraft,
  ReviewProgress,
  Verdict
} from '../../shared/types'
import { commentableLines, parsePatch, type DiffRow } from '../../shared/diff'
import { ago, cleanError } from './util'
import { Bug, Check, ChevronRight, CircleCheck, CircleDot, ClipboardCheck, Copy, ExternalLink, FlaskConical, Gauge, MessageSquare, MessagesSquare, NotebookPen, Plus, ScanSearch, ShieldAlert, Trash2 } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PrChat } from './PrChat'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Author } from './Author'
import { Description } from './Description'
import { Composer, Shortcuts, type Shortcut } from './Composer'
import { Markdown } from './Markdown'
import { Confirm } from './Confirm'
import { PostedReviewView, ReviewHistoryBar } from './ReviewHistory'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { cachedHighlight, fetchDetail, isFresh, peekDetail } from './prCache'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { CiDetails } from './CiStatus'
import { MergeStatus } from './MergeStatus'
import { FileTree } from './FileTree'
import { highlightLine, languageFor } from './highlight'
import { Checkbox } from '@/components/ui/checkbox'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useDefaultLayout } from 'react-resizable-panels'

interface Props {
  pr: PrSummary
  progress?: ReviewProgress
  onDraftChanged: () => void
}

const VERDICT_LABEL: Record<Verdict, string> = {
  comment: 'Comment',
  approve: 'Approve',
  request_changes: 'Request changes'
}

/** A draft only counts once it says something: a summary, or a comment with text in it. */
const hasContent = (d: ReviewDraft): boolean =>
  !!d.posted || !!d.summary.trim() || d.comments.some((c) => c.body.trim())

/** The summary is prose that wraps, so size it by its length as well as its line breaks, and never start small. */
const summaryRows = (text: string): number =>
  Math.min(Math.max(8, text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 42)), 1)), 24)

function DraftCard({
  comment,
  readOnly,
  showLocation,
  onChange,
  onRemove
}: {
  comment: DraftComment
  readOnly: boolean
  showLocation?: boolean
  onChange: (c: DraftComment) => void
  onRemove: (id: string) => void
}) {
  return (
    <div id={`c-${comment.id}`} className={cn('draft-card', !comment.included && 'dropped')}>
      <div className="draft-head">
        <span className={`severity ${comment.severity}`}>{comment.severity}</span>
        <span className="draft-title">{comment.title || (comment.source === 'me' ? 'Your comment' : 'Finding')}</span>
        {showLocation && (
          <span className="mono muted">
            {comment.path}:{comment.line}
          </span>
        )}
        <span className="muted">{comment.source === 'ai' ? 'drafted by Claude' : 'written by you'}</span>
      </div>
      {/* Grows with what is typed; a posted comment reads as text rather than as a box to type in. */}
      <Textarea
        value={comment.body}
        rows={3}
        readOnly={readOnly}
        placeholder="Write a comment"
        aria-label={`Comment on ${comment.path} line ${comment.line}`}
        className={cn(
          'min-h-16 field-sizing-content bg-background text-[13px] leading-relaxed md:text-[13px]',
          readOnly && 'cursor-default resize-none border-transparent bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent'
        )}
        onChange={(e) => onChange({ ...comment, body: e.target.value })}
        onBlur={() => {
          if (comment.source === 'me' && !comment.body.trim()) onRemove(comment.id)
        }}
      />
      {!readOnly && (
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <Label className="gap-2 text-[13px] font-normal">
            <Checkbox checked={comment.included} onCheckedChange={(v) => onChange({ ...comment, included: v === true })} />
            Post this comment
          </Label>
          <Button variant="ghost" size="xs" className="text-danger hover:text-danger" onClick={() => onRemove(comment.id)}>
            <Trash2 aria-hidden />
            Delete
          </Button>
        </div>
      )}
    </div>
  )
}

/** A conversation already on GitHub: the first comment and its replies, in order. */
interface Thread {
  id: string
  comments: ExistingComment[]
  resolved: boolean | null
  resolvedBy: string | null
}

function threadsOf(comments: ExistingComment[]): Thread[] {
  const map = new Map<string, Thread>()
  for (const c of [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const key = c.thread || `c${c.id}`
    let t = map.get(key)
    if (!t) map.set(key, (t = { id: key, comments: [], resolved: c.resolved, resolvedBy: c.resolvedBy }))
    t.comments.push(c)
  }
  return [...map.values()]
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
        <Button variant="link" size="xs" className="ml-auto h-auto px-0" onClick={() => void window.api.openExternal(comment.url)}>
          On GitHub
        </Button>
      </div>
      <Markdown text={comment.body} className="text-[13px]" />
    </div>
  )
}

/** Unresolved threads stay open and marked; resolved ones fold to one line, as on GitHub. */
function ExistingThread({ thread, where }: { thread: Thread; where?: string }) {
  const [open, setOpen] = useState(thread.resolved !== true)
  const [first, ...replies] = thread.comments
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
      open={open}
      onOpenChange={setOpen}
      className={cn(
        'existing border-l-[3px]',
        thread.resolved === true ? 'border-l-ready/60 opacity-80' : thread.resolved === false ? 'border-l-action' : ''
      )}
    >
      <div className="mb-1.5 flex items-center gap-2">
        {status}
        {!open && (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {first.author}: {first.body.split('\n')[0]}
          </span>
        )}
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="xs" className="ml-auto text-muted-foreground">
            <ChevronRight className={cn('transition-transform', open && 'rotate-90')} aria-hidden />
            {open
              ? 'Hide'
              : `Show ${thread.comments.length === 1 ? 'comment' : `${thread.comments.length} comments`}`}
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <ExistingCard comment={first} where={where} />
        {replies.map((c) => (
          <ExistingCard key={c.id} comment={c} reply />
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

const countThreads = (threads: Thread[]): { open: number; resolved: number } => ({
  open: threads.filter((t) => t.resolved !== true).length,
  resolved: threads.filter((t) => t.resolved === true).length
})

const FileDiff = memo(function FileDiff({
  index,
  file,
  rows,
  drafts,
  existing,
  readOnly,
  viewed,
  onViewed,
  onAdd,
  onChange,
  onRemove
}: {
  viewed: boolean
  onViewed: (file: PrFile, viewed: boolean) => void
  index: number
  file: PrFile
  rows: DiffRow[]
  drafts: DraftComment[]
  existing: ExistingComment[]
  readOnly: boolean
  onAdd: (path: string, line: number) => void
  onChange: (c: DraftComment) => void
  onRemove: (id: string) => void
}) {
  const [open, setOpen] = useState(!viewed && rows.length <= 800)
  const html = useMemo(() => {
    const lang = languageFor(file.path)
    return cachedHighlight(`${file.path}:${fileSignature(file)}`, () =>
      rows.map((r) => (r.type === 'hunk' ? '' : highlightLine(r.text, lang)))
    )
    // The signature changes whenever the patch does, so it stands in for rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file])
  // Where each GitHub thread belongs: on a new-side line, an old-side (deleted) line, or nowhere in this diff any more.
  // A thread sits where its first comment was made.
  const placed = useMemo(() => {
    const right = new Map<number, Thread[]>()
    const left = new Map<number, Thread[]>()
    const newLines = new Set(rows.filter((r) => r.type !== 'del' && r.type !== 'hunk').map((r) => r.newLine))
    const oldLines = new Set(rows.filter((r) => r.type === 'del').map((r) => r.oldLine))
    const loose: Thread[] = []
    const threads = threadsOf(existing)
    for (const t of threads) {
      const c = t.comments[0]
      const [lines, map] = c.side === 'LEFT' ? [oldLines, left] : [newLines, right]
      if (c.line !== null && lines.has(c.line)) map.set(c.line, [...(map.get(c.line) ?? []), t])
      else loose.push(t)
    }
    return { right, left, loose, counts: countThreads(threads) }
  }, [rows, existing])
  return (
    <section className={viewed ? 'file viewed' : 'file'} id={`f-${index}`}>
      <header className="file-head">
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={open ? `Collapse ${file.path}` : `Expand ${file.path}`}
        >
          <ChevronRight className={cn('transition-transform', open && 'rotate-90')} aria-hidden />
        </Button>
        <span className="mono file-path">
          {file.previousPath ? `${file.previousPath} → ` : ''}
          {file.path}
        </span>
        {/* Shown in the header so a folded file still says there is a conversation inside. */}
        {placed.counts.open > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="gap-1 border-action/50 font-semibold text-action">
                <MessageSquare aria-hidden /> {placed.counts.open}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              {placed.counts.open} unresolved {placed.counts.open === 1 ? 'conversation' : 'conversations'} on GitHub
            </TooltipContent>
          </Tooltip>
        )}
        {placed.counts.resolved > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="gap-1 font-semibold text-ready">
                <CircleCheck aria-hidden /> {placed.counts.resolved}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              {placed.counts.resolved} resolved {placed.counts.resolved === 1 ? 'conversation' : 'conversations'}
            </TooltipContent>
          </Tooltip>
        )}
        {drafts.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="gap-1 border-primary font-semibold text-primary">
                <NotebookPen aria-hidden /> {drafts.length}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              {drafts.length} drafted {drafts.length === 1 ? 'comment' : 'comments'}, not posted yet
            </TooltipContent>
          </Tooltip>
        )}
        <span className="muted">{file.status}</span>
        <span>
          <span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span>
        </span>
        {/* As on GitHub: ticking Viewed folds the file away, and it stays ticked until the file changes. */}
        <Label
          className={cn(
            'h-6 cursor-pointer gap-1.5 rounded-md border px-2 text-xs font-normal whitespace-nowrap transition-colors hover:border-muted-foreground',
            viewed && 'border-ready/60 bg-ready-bg font-semibold text-ready hover:border-ready'
          )}
        >
          <Checkbox
            checked={viewed}
            onCheckedChange={(v) => {
              setOpen(v !== true)
              onViewed(file, v === true)
            }}
          />
          Viewed
        </Label>
      </header>
      {open && placed.loose.length > 0 && (
        <div className="loose-comments">
          <p className="muted small">Comments on lines that have since changed or are outside this diff</p>
          {placed.loose.map((t) => (
            <ExistingThread
              key={t.id}
              thread={t}
              where={t.comments[0].originalLine ? `was on line ${t.comments[0].originalLine}` : undefined}
            />
          ))}
        </div>
      )}
      {open &&
        (rows.length === 0 ? (
          <p className="empty small">No text diff to show (binary, renamed without changes, or too large).</p>
        ) : (
          <table className="diff">
            <colgroup>
              <col className="col-num" />
              <col className="col-num" />
              <col className="col-plus" />
              <col />
            </colgroup>
            <tbody>
              {rows.map((row, i) => {
                const line = row.type === 'del' ? undefined : row.newLine
                const here = line === undefined ? [] : drafts.filter((d) => d.line === line)
                const old =
                  row.type === 'hunk'
                    ? []
                    : row.type === 'del'
                      ? (placed.left.get(row.oldLine!) ?? [])
                      : (placed.right.get(row.newLine!) ?? [])
                return (
                  <FragmentRow key={i}>
                    <tr className={`row ${row.type}`}>
                      {row.type === 'hunk' ? (
                        <td colSpan={4} className="hunk">
                          {row.text}
                        </td>
                      ) : (
                        <>
                          <td className="num">{row.oldLine ?? ''}</td>
                          <td className="num">{row.newLine ?? ''}</td>
                          <td className="plus">
                            {line !== undefined && !readOnly && (
                              <Button
                                size="icon-xs"
                                className="size-[18px] rounded opacity-0 focus-visible:opacity-100 [tr.row:hover_&]:opacity-100"
                                title={`Comment on line ${line}`}
                                aria-label={`Comment on line ${line}`}
                                onClick={() => onAdd(file.path, line)}
                              >
                                <Plus className="size-3" strokeWidth={3} aria-hidden />
                              </Button>
                            )}
                          </td>
                          <td className="code">
                            <span className="sign">{row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' '}</span>
                            <span dangerouslySetInnerHTML={{ __html: html[i] }} />
                          </td>
                        </>
                      )}
                    </tr>
                    {(here.length > 0 || old.length > 0) && (
                      <tr className="thread">
                        <td colSpan={4}>
                          {old.map((t) => (
                            <ExistingThread key={t.id} thread={t} />
                          ))}
                          {here.map((c) => (
                            <DraftCard key={c.id} comment={c} readOnly={readOnly} onChange={onChange} onRemove={onRemove} />
                          ))}
                        </td>
                      </tr>
                    )}
                  </FragmentRow>
                )
              })}
            </tbody>
          </table>
        ))}
    </section>
  )
})

function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

/** Changes whenever the file's diff does, so a file you viewed shows up again after new commits touch it. */
function fileSignature(file: PrFile): string {
  const text = file.patch ?? ''
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return `${file.status}:${text.length}:${h}`
}

const viewedKey = (prKey: string): string => `docket.viewed.${prKey}`
const loadViewed = (prKey: string): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(viewedKey(prKey)) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

export function PrView({ pr, progress, onDraftChanged }: Props) {
  // A page opened before shows at once from the cache; load() then refreshes it if needed.
  const [detail, setDetail] = useState<PrDetail | null>(() => peekDetail(pr.key))
  const [draft, setDraft] = useState<ReviewDraft | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [branchCopied, setBranchCopied] = useState(false)
  const [sideTab, setSideTab] = useState<'review' | 'chat'>('review')
  // Reviews already posted on this pull request; one of them can be opened read-only.
  const [postedReviews, setPostedReviews] = useState<PostedReview[]>([])
  const [viewingReview, setViewingReview] = useState<PostedReview | null>(null)
  const loadReviews = useCallback(
    () => window.api.listReviews(pr.key).then(setPostedReviews, () => undefined),
    [pr.key]
  )
  useEffect(() => {
    void loadReviews()
  }, [loadReviews])
  const [focus, setFocus] = useState('')
  // Path to the signature of the diff that was on screen when the file was marked viewed.
  const [viewedMarks, setViewedMarks] = useState(() => loadViewed(pr.key))
  const onViewed = useCallback(
    (file: PrFile, on: boolean) =>
      setViewedMarks((prev) => {
        const next = { ...prev }
        if (on) next[file.path] = fileSignature(file)
        else delete next[file.path]
        try {
          localStorage.setItem(viewedKey(pr.key), JSON.stringify(next))
        } catch {
          /* remembered for this visit only */
        }
        return next
      }),
    [pr.key]
  )
  const [rerunning, setRerunning] = useState(false) // asking what to focus on before running Claude again
  const [confirming, setConfirming] = useState(false)
  const [posting, setPosting] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Pane widths are remembered between pull requests and launches.
  const layout = useDefaultLayout({ id: 'docket-pr-panes', storage: localStorage })
  const latest = useRef<ReviewDraft | null>(null)
  /** Whether a draft for this pull request currently exists on disk. */
  const stored = useRef(false)

  /** The draft, and the page unless the cached one is still fresh. `force` always asks GitHub (after posting). */
  const load = useCallback(
    async (force = false) => {
      const draftLoad = window.api.getDraft(pr.key).then((dr) => {
        const real = dr && hasContent(dr) ? dr : null
        if (dr && !real) void window.api.discardDraft(pr.key, 'empty draft on load')
        setDraft(real)
        latest.current = real
        stored.current = !!real
      })
      try {
        if (force || !isFresh(pr)) setDetail(await fetchDetail(pr))
        else setDetail(peekDetail(pr.key))
        await draftLoad
        setLoadError(null)
      } catch (e) {
        await draftLoad.catch(() => undefined)
        // With a cached page on screen, a failed refresh only needs a note, not an empty page.
        setLoadError(peekDetail(pr.key) ? `Showing the copy loaded earlier. ${cleanError(e)}` : cleanError(e))
      }
    },
    // pr changes identity on every dashboard refresh; what matters is which pull request and its head.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pr.key, pr.headSha]
  )

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (progress?.state !== 'done') return
    // An edit typed just before Claude finished may not be saved yet. When Claude added to this same
    // draft, keep that edit and take only the comments Claude added; a replaced draft wins outright.
    const mine = latest.current
    if (saveTimer.current && mine) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
      void window.api.getDraft(pr.key).then(async (disk) => {
        if (disk && disk.createdAt === mine.createdAt) {
          const ids = new Set(mine.comments.map((c) => c.id))
          await window.api.saveDraft({ ...mine, comments: [...mine.comments, ...disk.comments.filter((c) => !ids.has(c.id))] })
        }
        void load()
      })
      return
    }
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress?.state, load])

  // Flush a pending save when leaving the view, and let the dashboard know if a draft appeared or went away.
  const draftChanged = useRef(onDraftChanged)
  draftChanged.current = onDraftChanged
  useEffect(
    () => () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
        const real = !!latest.current && hasContent(latest.current)
        const changed = real !== stored.current
        if (real) void window.api.saveDraft(latest.current!).then(() => changed && draftChanged.current())
        else if (stored.current) void window.api.discardDraft(pr.key, 'emptied, saved on leaving').then(() => draftChanged.current())
      }
    },
    []
  )

  const update = useCallback(
    (fn: (d: ReviewDraft) => ReviewDraft) => {
      setDraft((prev) => {
        const base: ReviewDraft = prev ?? {
          key: pr.key,
          headSha: detail?.headSha ?? pr.headSha,
          createdAt: new Date().toISOString(),
          summary: '',
          verdict: 'comment',
          comments: [],
          fullContext: false
        }
        const next = fn(base)
        latest.current = next
        if (saveTimer.current) clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => {
          saveTimer.current = null
          // Nothing is stored until the draft has real content, and it is removed again if emptied.
          const real = hasContent(next)
          const changed = real !== stored.current
          stored.current = real
          void (real ? window.api.saveDraft(next) : changed ? window.api.discardDraft(pr.key, 'emptied while editing') : Promise.resolve()).then(
            () => changed && onDraftChanged()
          )
        }, 400)
        return next
      })
    },
    [pr.key, pr.headSha, detail?.headSha, onDraftChanged]
  )

  const onChange = useCallback(
    (c: DraftComment) => update((d) => ({ ...d, comments: d.comments.map((x) => (x.id === c.id ? c : x)) })),
    [update]
  )
  const onRemove = useCallback(
    (id: string) => update((d) => ({ ...d, comments: d.comments.filter((x) => x.id !== id) })),
    [update]
  )
  const onAdd = useCallback(
    (path: string, line: number) => {
      const id = crypto.randomUUID()
      update((d) => ({
        ...d,
        comments: [
          ...d.comments,
          { id, path, line, severity: 'suggestion', title: '', body: '', included: true, source: 'me' }
        ]
      }))
      setTimeout(() => document.querySelector<HTMLTextAreaElement>(`#c-${CSS.escape(id)} textarea`)?.focus(), 50)
    },
    [update]
  )

  const parsed = useMemo(
    () =>
      (detail?.files ?? []).map((file) => {
        const rows = parsePatch(file.patch)
        return { file, rows, lines: commentableLines(rows) }
      }),
    [detail]
  )
  const lineSets = useMemo(() => new Map(parsed.map((p) => [p.file.path, p.lines])), [parsed])
  const inDiff = useCallback((c: DraftComment) => lineSets.get(c.path)?.has(c.line) ?? false, [lineSets])

  const byFile = useMemo(() => {
    const drafts = new Map<string, DraftComment[]>()
    for (const c of draft?.comments ?? [])
      if (inDiff(c)) drafts.set(c.path, [...(drafts.get(c.path) ?? []), c])
    const existing = new Map<string, ExistingComment[]>()
    for (const c of detail?.comments ?? []) existing.set(c.path, [...(existing.get(c.path) ?? []), c])
    return { drafts, existing }
  }, [draft?.comments, detail?.comments, inDiff])

  const viewed = useMemo(
    () => new Set((detail?.files ?? []).filter((f) => viewedMarks[f.path] === fileSignature(f)).map((f) => f.path)),
    [detail, viewedMarks]
  )
  const discussion = useMemo(
    () => new Map([...byFile.existing].map(([path, list]) => [path, countThreads(threadsOf(list))])),
    [byFile.existing]
  )
  const conversations = useMemo(() => {
    let open = 0
    let resolved = 0
    for (const c of discussion.values()) {
      open += c.open
      resolved += c.resolved
    }
    return { open, resolved }
  }, [discussion])
  const commentCounts = useMemo(
    () => new Map([...byFile.drafts].map(([path, list]) => [path, list.length])),
    [byFile.drafts]
  )
  const running = progress?.state === 'running'
  const real = !!draft && hasContent(draft)
  const written = (draft?.comments ?? []).filter((c) => c.body.trim())
  const posted = draft?.posted
  const readOnly = !!posted
  const stale = !!draft && !!detail && !posted && draft.headSha !== detail.headSha
  const outside = (draft?.comments ?? []).filter((c) => !inDiff(c))
  const toPost = (draft?.comments ?? []).filter((c) => c.included && c.body.trim())
  const inline = toPost.filter(inDiff)
  const general = toPost.filter((c) => !inDiff(c))
  const canPost =
    !!draft && !running && (inline.length > 0 || general.length > 0 || draft.summary.trim() || draft.verdict === 'approve')

  const post = async (): Promise<void> => {
    if (!draft) return
    setPosting(true)
    setPostError(null)
    try {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
        saveTimer.current = null
      }
      await window.api.saveDraft(draft)
      const body = [
        draft.summary.trim(),
        ...general.map((c) => `**\`${c.path}:${c.line}\`** ${c.title ? `${c.title}\n\n` : ''}${c.body.trim()}`)
      ]
        .filter(Boolean)
        .join('\n\n')
      await window.api.postReview({
        repo: pr.repo,
        number: pr.number,
        headSha: draft.headSha,
        verdict: draft.verdict,
        body,
        comments: inline.map((c) => ({ path: c.path, line: c.line, body: c.body.trim() }))
      })
      setConfirming(false)
      await Promise.all([load(true), loadReviews()])
      onDraftChanged()
    } catch (e) {
      setPostError(cleanError(e))
    } finally {
      setPosting(false)
    }
  }

  const discard = async (why: string): Promise<void> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    await window.api.discardDraft(pr.key, why)
    setDraft(null)
    latest.current = null
    stored.current = false
    setConfirming(false)
    onDraftChanged()
  }

  const startReview = (withFocus: string = focus, mode: 'replace' | 'extend' = 'replace'): void => {
    // Claude reads the draft from disk when it starts adding to it, so save what is typed first.
    if (mode === 'extend' && saveTimer.current && latest.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
      void window.api.saveDraft(latest.current).then(() => window.api.startReview(pr, withFocus, mode))
      return
    }
    void window.api.startReview(pr, withFocus, mode)
  }
  const copyBranch = (): void =>
    void window.api.copyText(pr.headRef).then(() => {
      setBranchCopied(true)
      setTimeout(() => setBranchCopied(false), 1500)
    })
  const jump = (id: string): void =>
    document.getElementById(id)?.scrollIntoView({ block: 'center', behavior: 'smooth' })

  return (
    <div className="pr-view">
      <header className="pr-head">
        <div className="min-w-0 flex-1">
          <h1>{pr.title}</h1>
          <p className="pr-meta">
            <span className="mono">
              {pr.repo}#{pr.number}
            </span>
            <span className="inline-flex items-center gap-1.5">
              by <Author author={pr.author} className="font-medium text-foreground" />
            </span>
            <span className="inline-flex items-center gap-1">
              <Button
                variant="ghost"
                size="xs"
                className="mono h-auto px-1 py-0.5 font-normal text-muted-foreground hover:text-foreground"
                title="Copy branch name"
                onClick={copyBranch}
              >
                {pr.headRef}
                {branchCopied ? <Check className="text-ready" aria-hidden /> : <Copy aria-hidden />}
              </Button>
              <span className="mono">into {pr.baseRef}</span>
            </span>
            {pr.reasons.map((r, i) => (
              <span key={i} className={`reason level-${r.level}`}>
                {r.text}
              </span>
            ))}
          </p>
          <MergeStatus pr={pr} className="mt-2" />
          <CiDetails pr={pr} className="mt-2" />
          {conversations.open + conversations.resolved > 0 && (
            <p className="mt-2 flex items-center gap-3 text-xs">
              <span className={cn('inline-flex items-center gap-1 font-medium', conversations.open ? 'text-action' : 'text-muted-foreground')}>
                <CircleDot className="size-3.5" aria-hidden />
                {conversations.open} unresolved
              </span>
              <span className="inline-flex items-center gap-1 text-ready">
                <CircleCheck className="size-3.5" aria-hidden />
                {conversations.resolved} resolved
              </span>
              <span className="text-muted-foreground">
                {conversations.open + conversations.resolved === 1 ? 'conversation' : 'conversations'} on GitHub
              </span>
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" className="shrink-0" onClick={() => void window.api.openExternal(pr.url)}>
          <ExternalLink aria-hidden />
          Open on GitHub
        </Button>
      </header>

      {loadError && (
        <div className="banner error" role="alert">
          {loadError}
        </div>
      )}

      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
      >
        <ResizablePanel id="files" defaultSize={220} minSize={120} maxSize={480}>
          <FileTree files={detail?.files ?? EMPTY_FILES} counts={commentCounts} viewed={viewed} discussion={discussion} onJump={(n) => jump(`f-${n}`)} />
        </ResizablePanel>
        <ResizableHandle />

        <ResizablePanel id="diff" minSize={320}>
        <main className="diff-pane">
          {!detail && !loadError && <div className="empty">Loading changes…</div>}
          {detail?.truncated && (
            <div className="banner">
              This pull request has more files than Docket loads. The rest are on GitHub.
            </div>
          )}
          {detail?.bodyHtml && <Description html={detail.bodyHtml} url={pr.url} />}
          {parsed.map(({ file, rows }, i) => (
            <FileDiff
              key={file.path}
              index={i}
              file={file}
              rows={rows}
              drafts={byFile.drafts.get(file.path) ?? EMPTY_DRAFTS}
              existing={byFile.existing.get(file.path) ?? EMPTY_EXISTING}
              readOnly={readOnly}
              viewed={viewed.has(file.path)}
              onViewed={onViewed}
              onAdd={onAdd}
              onChange={onChange}
              onRemove={onRemove}
            />
          ))}
        </main>
        </ResizablePanel>
        <ResizableHandle />

        <ResizablePanel id="review" defaultSize={400} minSize={280} maxSize="65%">
        <Tabs value={sideTab} onValueChange={(v) => setSideTab(v === 'chat' ? 'chat' : 'review')} className="h-full gap-0 bg-card">
        <TabsList className="mx-3 mt-3 self-start">
          <TabsTrigger value="review">
            <ClipboardCheck aria-hidden />
            Review
          </TabsTrigger>
          <TabsTrigger value="chat">
            <MessagesSquare aria-hidden />
            Ask Claude
          </TabsTrigger>
        </TabsList>
        {/* Kept mounted, so switching tabs never drops a half-written comment or a streaming answer. */}
        <TabsContent value="chat" forceMount className="min-h-0 data-[state=inactive]:hidden">
          <PrChat pr={pr} />
        </TabsContent>
        <TabsContent value="review" forceMount className="min-h-0 data-[state=inactive]:hidden">
        <aside className="flex h-full min-h-0 flex-col bg-card" aria-label="Review">
          <ReviewHistoryBar reviews={postedReviews} viewing={viewingReview} onView={setViewingReview} />
          <div className="grid min-h-0 flex-1 content-start gap-3 overflow-auto px-4 py-3 text-[13px]">
          {viewingReview ? (
            <PostedReviewView
              review={viewingReview}
              onJump={(path) => {
                const i = parsed.findIndex(({ file }) => file.path === path)
                if (i >= 0) jump(`f-${i}`)
              }}
            />
          ) : (
          <>
          {running && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="spinner" aria-hidden />
              {progress!.step}
            </p>
          )}
          {progress?.state === 'done' && progress.step !== 'Review drafted' && (
            <p className="text-xs text-muted-foreground" role="status">
              {progress.step}.
            </p>
          )}
          {progress?.state === 'error' && (
            <div className="banner error m-0" role="alert">
              The review did not finish. {progress.error}
            </div>
          )}

          {!real && !running && (
            <p className="text-muted-foreground">
              {pr.role === 'mine' ? 'Have Claude look over your own change before others do. ' : ''}Claude reads the changes
              in its own up-to-date checkout and drafts comments for you to edit. Nothing is posted until you choose to.
              Or press + on a line to comment yourself.
            </p>
          )}

          {real && draft && (
            <>
              {posted && (
                <div className="banner ok m-0">
                  Review posted {ago(posted.at)}.{' '}
                  <Button variant="link" size="xs" className="h-auto px-0" onClick={() => void window.api.openExternal(posted.url)}>
                    View on GitHub
                  </Button>
                </div>
              )}
              {stale && (
                <div className="banner m-0">
                  New commits were pushed after this review was drafted. Comments may point at lines that moved.
                </div>
              )}
              {(draft.model || draft.effort) && draft.comments.some((c) => c.source === 'ai') && (
                <p className="text-xs text-muted-foreground">
                  Drafted with {[draft.model, draft.effort && `${draft.effort} effort`].filter(Boolean).join(', ')}.
                </p>
              )}
              {!draft.fullContext && draft.comments.some((c) => c.source === 'ai') && (
                <p className="text-xs text-muted-foreground">Claude saw only the diff for this review, not the rest of the repository.</p>
              )}

              <div className="grid gap-1.5">
                <Label htmlFor="review-summary">Summary</Label>
                <Textarea
                  id="review-summary"
                  value={draft.summary}
                  rows={summaryRows(draft.summary)}
                  readOnly={readOnly}
                  placeholder="Overall comment for the author"
                  className="text-[13px]"
                  onChange={(e) => update((d) => ({ ...d, summary: e.target.value }))}
                />
              </div>

              <div className="grid gap-1.5">
                <Label>Post as</Label>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  value={draft.verdict}
                  disabled={readOnly}
                  aria-label="Review type"
                  onValueChange={(v) => v && update((d) => ({ ...d, verdict: v as Verdict }))}
                  className="w-full"
                >
                  {(Object.keys(VERDICT_LABEL) as Verdict[]).map((v) => (
                    <ToggleGroupItem key={v} value={v} className="flex-1 text-xs" disabled={pr.role === 'mine' && v !== 'comment'}>
                      {VERDICT_LABEL[v]}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                {pr.role === 'mine' && (
                  <span className="text-xs text-muted-foreground">GitHub only allows comments on your own pull request.</span>
                )}
              </div>

              <h3 className="mt-1 flex items-baseline gap-2 font-semibold">
                Comments <span className="count">{toPost.length} to post of {written.length}</span>
              </h3>
              {written.length === 0 && <p className="text-xs text-muted-foreground">No comments. Press + next to a line to add one.</p>}
              <ul className="finding-list">
                {written.filter(inDiff).map((c) => (
                  <li key={c.id}>
                    <button
                      className={`finding ${c.severity} ${c.included ? '' : 'dropped'}`}
                      title={`${c.path}:${c.line}. Click to jump to it in the diff.`}
                      onClick={() => jump(`c-${c.id}`)}
                    >
                      <span className="finding-meta">
                        <span className={`severity ${c.severity}`}>{c.severity}</span>
                        <span className="finding-where">
                          {c.path.split('/').pop()}:{c.line}
                        </span>
                        {!c.included && <span className="finding-skipped">not posting</span>}
                      </span>
                      <span className="finding-title">{c.title || c.body.slice(0, 80) || 'Empty comment'}</span>
                    </button>
                  </li>
                ))}
              </ul>

              {outside.length > 0 && (
                <>
                  <h3 className="mt-1 font-semibold">Not on a changed line</h3>
                  <p className="text-xs text-muted-foreground">
                    GitHub cannot attach these to the diff, so they will be added to the summary.
                  </p>
                  {outside.map((c) => (
                    <DraftCard
                      key={c.id}
                      comment={c}
                      readOnly={readOnly}
                      showLocation
                      onChange={onChange}
                      onRemove={onRemove}
                    />
                  ))}
                </>
              )}

              {postError && (
                <div className="banner error m-0" role="alert">
                  GitHub did not accept the review. {postError}
                </div>
              )}

              {posted ? (
                <Button variant="outline" size="sm" className="justify-self-start" onClick={() => void discard('start a new review')}>
                  Start a new review
                </Button>
              ) : confirming ? (
                <div className="grid gap-2 rounded-lg border bg-background p-3">
                  <p>
                    Post to {pr.repo}#{pr.number} as <strong>{VERDICT_LABEL[draft.verdict]}</strong> with{' '}
                    {toPost.length} {toPost.length === 1 ? 'comment' : 'comments'}? {pr.author.login} and other watchers
                    will be notified.
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" disabled={posting} onClick={() => void post()}>
                      {posting ? 'Posting…' : 'Post review'}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={posting} onClick={() => setConfirming(false)}>
                      Keep editing
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Button size="sm" disabled={!canPost} onClick={() => setConfirming(true)}>
                    Post review
                  </Button>
                  <Confirm
                    title="Discard this draft?"
                    description="The summary and every comment in it, including your edits, are deleted. This cannot be undone from Docket."
                    action="Discard draft"
                    onConfirm={() => void discard('discard draft button')}
                  >
                    <Button size="sm" variant="ghost" className="ml-auto text-danger hover:text-danger">
                      Discard draft
                    </Button>
                  </Confirm>
                </div>
              )}
            </>
          )}
          </>
          )}
          </div>

          {!posted && !viewingReview && (
            <Composer
              kind="review"
              value={focus}
              onChange={setFocus}
              running={running}
              allowEmpty
              onStop={() => void window.api.cancelReview(pr.key)}
              onSubmit={() => (real ? setRerunning(true) : startReview())}
              submitLabel={real ? 'Run again' : 'Review'}
              placeholder={real ? 'Anything to focus on this time? (optional)' : 'Anything to focus on? (optional)'}
              above={
                <Shortcuts
                  items={REVIEW_FOCUS}
                  disabled={running}
                  onPick={(s) => {
                    setFocus(s.prompt)
                    // General starts at once; with a draft open it still asks before replacing it.
                    if (!s.prompt) {
                      if (real) setRerunning(true)
                      else startReview('')
                    }
                  }}
                />
              }
            />
          )}
          <AlertDialog open={rerunning && !running} onOpenChange={(open) => !open && setRerunning(false)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{stale ? 'Replace the draft?' : 'Run Claude again on this draft?'}</AlertDialogTitle>
                <AlertDialogDescription>
                  {stale
                    ? 'The draft is behind new commits, so its comments point at old lines. Running again replaces it, including your edits.'
                    : 'Add to draft keeps your summary, verdict and comments, and adds only what Claude finds that is not already there. Replace draft starts over and loses your edits.'}
                  {focus.trim() && (
                    <>
                      {' '}
                      Focus: <span className="text-foreground">{focus.trim()}</span>
                    </>
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  variant={stale ? 'destructive' : 'outline'}
                  className={stale ? '' : 'text-danger hover:text-danger'}
                  onClick={() => startReview()}
                >
                  Replace draft
                </AlertDialogAction>
                {!stale && <AlertDialogAction onClick={() => startReview(focus, 'extend')}>Add to draft</AlertDialogAction>}
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </aside>
        </TabsContent>
        </Tabs>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

const EMPTY_FILES: PrFile[] = []
const EMPTY_DRAFTS: DraftComment[] = []
const EMPTY_EXISTING: ExistingComment[] = []

/** Ready-made focus for a review: one click puts it in the box, ready to send or edit. */
const REVIEW_FOCUS: Shortcut[] = [
  // No focus: Claude weighs everything and reports what matters most in this pull request.
  { label: 'General', Icon: ScanSearch, title: 'A general review with no particular focus, started right away', prompt: '' },
  { label: 'Bugs', Icon: Bug, title: 'Bugs and edge cases', prompt: 'Bugs and edge cases in the changed logic' },
  { label: 'Security', Icon: ShieldAlert, title: 'Input handling, auth and secrets', prompt: 'Security: input handling, auth and secrets' },
  { label: 'Tests', Icon: FlaskConical, title: 'Missing or weak tests', prompt: 'Missing or weak tests for the changed behaviour' },
  { label: 'Performance', Icon: Gauge, title: 'Slow paths and wasted work', prompt: 'Performance and unnecessary work' }
]
