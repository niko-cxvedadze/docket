import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DraftComment,
  PrDetail,
  PrFile,
  PostedReview,
  PrSummary,
  ReviewDraft,
  ReviewProgress,
  Verdict
} from '../../shared/types'
import { commentableLines, parsePatch, type DiffRow } from '../../shared/diff'
import { ago, cleanError, isCopyKey, recall, recallJson, remember, toggled, VIEWED_PREFIX, viewedKey } from './util'
import { SelectionBar } from './SelectionBar'
import { toast } from 'sonner'
import { ArrowRight, Bug, Check, ChevronRight, CircleCheck, CircleDot, ClipboardCheck, Copy, ExternalLink, FileDiff as FileDiffIcon, FlaskConical, Gauge, GitBranch, MessageSquare, MessagesSquare, NotebookPen, Plus, ScanSearch, ShieldAlert, Trash2 } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PrChat } from './PrChat'
import { Asked } from './ChatPanel'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Author } from './Author'
import { Conversation } from './Conversation'
import { ExistingThread, SelectionContext, type Selection } from './ThreadView'
import { commentKey, countThreads, reviewKey, threadKey, threadsOf, toMarkdown, whereOf, type Picked, type Thread } from './threads'
import { Composer, Shortcuts, type Shortcut } from './Composer'
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

const FileDiff = memo(function FileDiff({
  index,
  file,
  rows,
  drafts,
  threads,
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
  /** The conversations on GitHub that started in this file. */
  threads: Thread[]
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
    for (const t of threads) {
      const c = t.comments[0]
      const [lines, map] = c.side === 'LEFT' ? [oldLines, left] : [newLines, right]
      if (c.line !== null && lines.has(c.line)) map.set(c.line, [...(map.get(c.line) ?? []), t])
      else loose.push(t)
    }
    return { right, left, loose, counts: countThreads(threads) }
  }, [rows, threads])
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
            <ExistingThread key={t.id} thread={t} where={looseWhere(t)} />
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
                            // A comment made on several lines sits under the last of them and says which.
                            <ExistingThread key={t.id} thread={t} where={t.comments[0].startLine !== null ? whereOf(t.comments[0]) : undefined} />
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

/** Where a thread that could not be put on its line used to be, or still is outside the lines shown. */
function looseWhere(t: Thread): string | undefined {
  const first = t.comments[0]
  const where = whereOf(first)
  return where ? `${first.line === null ? 'was on' : 'on'} ${where}` : undefined
}

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

/** The two pages of a pull request, as on GitHub: what was said, and what changed. */
type Page = 'conversation' | 'files'
const PAGE_KEY = 'docket.prPage'
const loadPage = (): Page => (recall(PAGE_KEY) === 'files' ? 'files' : 'conversation')

// Each account has its own marks. Ones saved before accounts were kept apart name only the pull request; they are read until the account saves its own.
const loadViewed = (pr: PrSummary): Record<string, string> =>
  recallJson<Record<string, string>>(viewedKey(pr.account, pr.key), {}, `${VIEWED_PREFIX}${pr.key}`)

export function PrView({ pr, progress, onDraftChanged }: Props) {
  // A page opened before shows at once from the cache; load() then refreshes it if needed.
  const [detail, setDetail] = useState<PrDetail | null>(() => peekDetail(pr.key))
  const [draft, setDraft] = useState<ReviewDraft | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // The branch name just copied, so its chip can say so.
  const [branchCopied, setBranchCopied] = useState<string | null>(null)
  const [sideTab, setSideTab] = useState<'review' | 'chat'>('review')
  // The page used last opens first on the next pull request.
  const [page, setPage] = useState<Page>(loadPage)
  const showPage = useCallback((next: Page) => {
    setPage(next)
    remember(PAGE_KEY, next)
  }, [])
  // Comments selected for copying, by key. Selected like rows on the dashboard: Cmd-click, then Cmd-C.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = useCallback((key: string) => setSelected((prev) => toggled(prev, key)), [])
  // Reviews already posted on this pull request; one of them can be opened read-only.
  const [postedReviews, setPostedReviews] = useState<PostedReview[]>([])
  const [viewingReview, setViewingReview] = useState<PostedReview | null>(null)
  const loadReviews = useCallback(
    () => window.api.listReviews(pr.account, pr.key).then(setPostedReviews, () => undefined),
    [pr.key]
  )
  useEffect(() => {
    void loadReviews()
  }, [loadReviews])
  const [focus, setFocus] = useState('')
  // The focus the running review was started with. It leaves the box when sent and shows above the progress.
  const [asked, setAsked] = useState('')
  // Between pressing Review and the first word from the review itself, so the page answers the click at once.
  const [starting, setStarting] = useState(false)
  useEffect(() => {
    if (progress) setStarting(false)
  }, [progress])
  useEffect(() => {
    // A review that was stopped or failed gives the focus back, ready to send again.
    if (progress?.state === 'error' || progress?.state === 'cancelled') setFocus((f) => f || asked)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress?.state])
  // Path to the signature of the diff that was on screen when the file was marked viewed.
  const [viewedMarks, setViewedMarks] = useState(() => loadViewed(pr))
  const onViewed = useCallback(
    (file: PrFile, on: boolean) =>
      setViewedMarks((prev) => {
        const next = { ...prev }
        if (on) next[file.path] = fileSignature(file)
        else delete next[file.path]
        remember(viewedKey(pr.account, pr.key), JSON.stringify(next))
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
  const layout = useDefaultLayout({ id: 'docket-pr-main', storage: localStorage })
  const filesLayout = useDefaultLayout({ id: 'docket-pr-files', storage: localStorage })
  const latest = useRef<ReviewDraft | null>(null)
  /** Whether a draft for this pull request currently exists on disk. */
  const stored = useRef(false)

  /** The draft, and the page unless the cached one is still fresh. `force` always asks GitHub (after posting). */
  const load = useCallback(
    async (force = false) => {
      const draftLoad = window.api.getDraft(pr.account, pr.key).then((dr) => {
        const real = dr && hasContent(dr) ? dr : null
        if (dr && !real) void window.api.discardDraft(pr.account, pr.key, 'empty draft on load')
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
      void window.api.getDraft(pr.account, pr.key).then(async (disk) => {
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
        else if (stored.current) void window.api.discardDraft(pr.account, pr.key, 'emptied, saved on leaving').then(() => draftChanged.current())
      }
    },
    []
  )

  const update = useCallback(
    (fn: (d: ReviewDraft) => ReviewDraft) => {
      setDraft((prev) => {
        const base: ReviewDraft = prev ?? {
          key: pr.key,
          account: pr.account,
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
          void (real ? window.api.saveDraft(next) : changed ? window.api.discardDraft(pr.account, pr.key, 'emptied while editing') : Promise.resolve()).then(
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

  const draftsByFile = useMemo(() => {
    const drafts = new Map<string, DraftComment[]>()
    for (const c of draft?.comments ?? [])
      if (inDiff(c)) drafts.set(c.path, [...(drafts.get(c.path) ?? []), c])
    return drafts
  }, [draft?.comments, inDiff])
  // The conversations on GitHub, grouped once here and handed to both pages. A conversation belongs to the file it started in.
  const threads = useMemo(() => threadsOf(detail?.comments ?? []), [detail])
  const threadsByFile = useMemo(() => {
    const map = new Map<string, Thread[]>()
    for (const t of threads) map.set(t.comments[0].path, [...(map.get(t.comments[0].path) ?? []), t])
    return map
  }, [threads])

  const viewed = useMemo(
    () => new Set((detail?.files ?? []).filter((f) => viewedMarks[f.path] === fileSignature(f)).map((f) => f.path)),
    [detail, viewedMarks]
  )
  const discussion = useMemo(() => new Map([...threadsByFile].map(([path, list]) => [path, countThreads(list)])), [threadsByFile])
  const conversations = useMemo(() => countThreads(threads), [threads])
  const commentCounts = useMemo(() => new Map([...draftsByFile].map(([path, list]) => [path, list.length])), [draftsByFile])

  /** Everything that can be selected, by key, in the order it is copied: general comments by date, then conversations by file and line. */
  const copyable = useMemo(() => {
    const general: { key: string; at: string; item: Picked }[] = [
      ...(detail?.reviews ?? []).map((review) => ({ key: reviewKey(review), at: review.submittedAt, item: { kind: 'review' as const, review } })),
      ...(detail?.conversation ?? []).map((comment) => ({ key: commentKey(comment), at: comment.createdAt, item: { kind: 'comment' as const, comment } }))
    ].sort((a, b) => a.at.localeCompare(b.at))
    const map = new Map<string, Picked>()
    for (const g of general) map.set(g.key, g.item)
    const fileOrder = new Map((detail?.files ?? []).map((f, i) => [f.path, i]))
    const place = (t: Thread): [number, number] => {
      const c = t.comments[0]
      return [fileOrder.get(c.path) ?? 1e9, c.line ?? c.originalLine ?? 0]
    }
    const sorted = [...threads].sort((a, b) => place(a)[0] - place(b)[0] || place(a)[1] - place(b)[1])
    for (const thread of sorted) map.set(threadKey(thread), { kind: 'thread', thread })
    return map
  }, [detail, threads])
  /** Puts these comments on the clipboard as markdown. `done` runs once they are there. */
  const copy = useCallback(
    (keys: string[], done?: () => void): void => {
      const want = new Set(keys)
      const items = [...copyable].filter(([key]) => want.has(key)).map(([, item]) => item)
      if (!items.length) return
      void window.api.copyText(toMarkdown(pr, items)).then(
        () => {
          toast.success(items.length === 1 ? 'Copied comment' : `Copied ${items.length} comments`, {
            description: 'As markdown, with the file, lines and code each one is about. Paste it to Claude.'
          })
          done?.()
        },
        (e) => toast.error('Could not copy', { description: cleanError(e) })
      )
    },
    [copyable, pr]
  )
  const selection = useMemo<Selection>(() => ({ selected, toggle, copy }), [selected, toggle, copy])
  // A selected comment that has since gone from GitHub no longer counts.
  const picked = useMemo(() => [...selected].filter((key) => copyable.has(key)), [selected, copyable])
  // The selection was only made to copy it, so it is done once the comments are on the clipboard.
  const copySelected = useCallback(() => copy(picked, () => setSelected(new Set())), [copy, picked])
  // Cmd-C copies the selection; Escape drops it. Text selected on the page still copies as text.
  useEffect(() => {
    if (!picked.length) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') return setSelected(new Set())
      if (e.shiftKey || !isCopyKey(e)) return
      e.preventDefault()
      copySelected()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picked.length, copySelected])
  const unresolved = useMemo(() => threads.filter((t) => t.resolved !== true).map(threadKey), [threads])
  const running = starting || progress?.state === 'running'
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
        account: pr.account,
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
    await window.api.discardDraft(pr.account, pr.key, why)
    setDraft(null)
    latest.current = null
    stored.current = false
    setConfirming(false)
    onDraftChanged()
  }

  const startReview = (withFocus: string = focus, mode: 'replace' | 'extend' = 'replace'): void => {
    // Sending empties the box and shows what was asked above, the way a question does in Ask Claude.
    const sent = withFocus.trim()
    setAsked(sent)
    setFocus('')
    setStarting(true)
    const failed = (): void => {
      setStarting(false)
      setFocus((f) => f || sent)
    }
    // Claude reads the draft from disk when it starts adding to it, so save what is typed first.
    if (mode === 'extend' && saveTimer.current && latest.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
      void window.api
        .saveDraft(latest.current)
        .then(() => window.api.startReview(pr, withFocus, mode))
        .catch(failed)
      return
    }
    void window.api.startReview(pr, withFocus, mode).catch(failed)
  }
  const copyBranch = (branch: string): void =>
    void window.api.copyText(branch).then(() => {
      setBranchCopied(branch)
      setTimeout(() => setBranchCopied(null), 1500)
    })
  /** A branch as a chip that stands out from the line around it. Clicking it copies the name. */
  const branchChip = (branch: string, what: string) => (
    <Button
      variant="outline"
      size="xs"
      className="mono h-6 max-w-full min-w-0 shrink gap-1.5 border-primary/30 bg-tint px-2 font-medium text-foreground hover:border-primary/60 hover:bg-tint dark:border-primary/40 dark:bg-tint dark:hover:bg-tint"
      title={`${what}: ${branch}. Click to copy the name.`}
      onClick={() => copyBranch(branch)}
    >
      <GitBranch className="text-primary" aria-hidden />
      <span className="min-w-0 truncate">{branch}</span>
      {branchCopied === branch ? <Check className="text-ready" aria-hidden /> : <Copy className="text-muted-foreground" aria-hidden />}
    </Button>
  )
  /** Scrolls the changed files to an element, or to `fallback` when that one is folded away. */
  const jump = useCallback(
    (id: string, fallback?: string): void => {
      showPage('files')
      // The files page keeps its layout while the conversation is showing, so it can scroll as soon as it is back.
      requestAnimationFrame(() =>
        (document.getElementById(id) ?? (fallback ? document.getElementById(fallback) : null))?.scrollIntoView({
          block: 'center',
          behavior: 'smooth'
        })
      )
    },
    [showPage]
  )
  const locate = useCallback(
    (thread: Thread) => jump(`t-${thread.id}`, `f-${parsed.findIndex(({ file }) => file.path === thread.comments[0].path)}`),
    [jump, parsed]
  )

  return (
    <div className="pr-view">
      <header className="pr-head">
        <div className="min-w-0 flex-1">
          <h1>{pr.title}</h1>
          {/* Who wants to merge what into where, the way GitHub words it; the branches are chips so they are found at a glance. */}
          <p className="pr-meta items-center gap-x-2 gap-y-1.5 text-[13px]">
            <span className="mono">
              {pr.repo}#{pr.number}
            </span>
            <span className="inline-flex items-center gap-2 whitespace-nowrap">
              <Author author={pr.author} className="font-semibold text-foreground [&>img]:size-5" />
              wants to merge
            </span>
            {branchChip(pr.headRef, 'The branch with the changes')}
            {/* Kept together, so a long branch name never leaves "into" on one line and its target on the next. */}
            <span className="inline-flex min-w-0 items-center gap-2">
              <span className="inline-flex shrink-0 items-center gap-1">
                <ArrowRight className="size-3.5" aria-hidden />
                into
              </span>
              {branchChip(pr.baseRef, 'The branch it merges into')}
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

      <SelectionContext.Provider value={selection}>
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
      >
        <ResizablePanel id="pages" minSize={440}>
        <Tabs value={page} onValueChange={(v) => showPage(v === 'files' ? 'files' : 'conversation')} className="h-full gap-0">
          <div className="flex items-center gap-3 border-b px-3">
            <TabsList variant="line" className="shrink-0">
              <TabsTrigger value="conversation">
                <MessagesSquare aria-hidden />
                Conversation
                {conversations.open > 0 && (
                  <Badge variant="outline" className="border-action/50 px-1.5 font-semibold text-action" title={`${conversations.open} unresolved`}>
                    {conversations.open}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="files">
                <FileDiffIcon aria-hidden />
                Files changed
                <Badge variant="secondary" className="px-1.5 tabular-nums">
                  {detail?.files.length ?? pr.changedFiles}
                </Badge>
              </TabsTrigger>
            </TabsList>
            {/* Review feedback as markdown, ready to paste to Claude. Works from either page. */}
            <Button
              variant="outline"
              size="xs"
              className="ml-auto"
              disabled={!unresolved.length}
              title={
                unresolved.length
                  ? 'Copy every unresolved conversation as markdown, with its file, lines and code. To copy only some, ⌘-click them.'
                  : 'No unresolved conversations'
              }
              onClick={() => copy(unresolved)}
            >
              <Copy aria-hidden />
              Copy unresolved{unresolved.length ? ` (${unresolved.length})` : ''}
            </Button>
          </div>
          {/* Both pages stay mounted and laid out, so each keeps its scroll position and half-written comments. */}
          <div className="relative min-h-0 flex-1">
          <TabsContent value="conversation" forceMount className="absolute inset-0 data-[state=inactive]:invisible">
            {detail ? (
              <Conversation pr={pr} detail={detail} threads={threads} onLocate={locate} />
            ) : (
              !loadError && <div className="empty">Loading the conversation…</div>
            )}
          </TabsContent>
          <TabsContent value="files" forceMount className="absolute inset-0 data-[state=inactive]:invisible">
          <ResizablePanelGroup orientation="horizontal" defaultLayout={filesLayout.defaultLayout} onLayoutChanged={filesLayout.onLayoutChanged}>
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
          {parsed.map(({ file, rows }, i) => (
            <FileDiff
              key={file.path}
              index={i}
              file={file}
              rows={rows}
              drafts={draftsByFile.get(file.path) ?? EMPTY_DRAFTS}
              threads={threadsByFile.get(file.path) ?? EMPTY_THREADS}
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
          </ResizablePanelGroup>
          </TabsContent>
          {picked.length > 0 && (
            <SelectionBar
              className="absolute"
              count={picked.length}
              label="Copy as markdown"
              icon={Copy}
              onCopy={copySelected}
              onClear={() => setSelected(new Set())}
            />
          )}
          </div>
        </Tabs>
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
            <div className="grid gap-3">
              {asked && <Asked>{asked}</Asked>}
              <div className="grid gap-1 rounded-lg border bg-background px-3 py-2.5" role="status">
                <p className="flex items-center gap-2 font-medium">
                  <span className="spinner" aria-hidden />
                  {real ? 'Claude is reviewing again' : 'Claude is reviewing this pull request'}
                </p>
                <p className="text-xs break-words text-muted-foreground">{progress?.state === 'running' ? progress.step : 'Starting'}</p>
                <p className="text-xs text-muted-foreground">
                  The draft shows up here when it is done. You can keep reading in the meantime.
                </p>
              </div>
            </div>
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
                    Post to {pr.repo}#{pr.number}
                    {pr.account && (
                      <>
                        {' '}
                        from <strong>{pr.account}</strong>
                      </>
                    )}{' '}
                    as <strong>{VERDICT_LABEL[draft.verdict]}</strong> with{' '}
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
              onStop={() => void window.api.cancelReview(pr.account, pr.key)}
              onSubmit={() => (real ? setRerunning(true) : startReview())}
              submitLabel={real ? 'Run again' : 'Review'}
              placeholder={
                running ? 'Claude is reviewing…' : real ? 'Anything to focus on this time? (optional)' : 'Anything to focus on? (optional)'
              }
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
      </SelectionContext.Provider>
    </div>
  )
}

const EMPTY_FILES: PrFile[] = []
const EMPTY_DRAFTS: DraftComment[] = []
const EMPTY_THREADS: Thread[] = []

/** Ready-made focus for a review: one click puts it in the box, ready to send or edit. */
const REVIEW_FOCUS: Shortcut[] = [
  // No focus: Claude weighs everything and reports what matters most in this pull request.
  { label: 'General', Icon: ScanSearch, title: 'A general review with no particular focus, started right away', prompt: '' },
  { label: 'Bugs', Icon: Bug, title: 'Bugs and edge cases', prompt: 'Bugs and edge cases in the changed logic' },
  { label: 'Security', Icon: ShieldAlert, title: 'Input handling, auth and secrets', prompt: 'Security: input handling, auth and secrets' },
  { label: 'Tests', Icon: FlaskConical, title: 'Missing or weak tests', prompt: 'Missing or weak tests for the changed behaviour' },
  { label: 'Performance', Icon: Gauge, title: 'Slow paths and wasted work', prompt: 'Performance and unnecessary work' }
]
