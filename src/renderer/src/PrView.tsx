import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DraftComment,
  ExistingComment,
  PrDetail,
  PrFile,
  PrSummary,
  ReviewDraft,
  ReviewProgress,
  Verdict
} from '../../shared/types'
import { commentableLines, parsePatch, type DiffRow } from '../../shared/diff'
import { ago, cleanError } from './util'
import { Check, ChevronRight, CircleCheck, CircleDot, Copy, MessageSquare, NotebookPen } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Author } from './Author'
import { Description } from './Description'
import { ReviewOptionsPicker } from './ReviewOptionsPicker'
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

const rowsFor = (text: string): number => Math.min(Math.max(3, text.split('\n').length + 1), 16)

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
    <div id={`c-${comment.id}`} className={`draft-card ${comment.included ? '' : 'dropped'}`}>
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
      <textarea
        value={comment.body}
        rows={rowsFor(comment.body)}
        readOnly={readOnly}
        placeholder="Write a comment"
        aria-label={`Comment on ${comment.path} line ${comment.line}`}
        onChange={(e) => onChange({ ...comment, body: e.target.value })}
        onBlur={() => {
          if (comment.source === 'me' && !comment.body.trim()) onRemove(comment.id)
        }}
      />
      {!readOnly && (
        <div className="draft-actions">
          <label className="check">
            <Checkbox checked={comment.included} onCheckedChange={(v) => onChange({ ...comment, included: v === true })} />
            Post this comment
          </label>
          <button className="link-button danger" onClick={() => onRemove(comment.id)}>
            Delete
          </button>
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
      <div className="existing-body">{comment.body}</div>
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
    return rows.map((r) => (r.type === 'hunk' ? '' : highlightLine(r.text, lang)))
  }, [rows, file.path])
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
        <button className="link-button" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? '▾' : '▸'}
        </button>
        <span className="mono file-path">
          {file.previousPath ? `${file.previousPath} → ` : ''}
          {file.path}
        </span>
        {/* Shown in the header so a folded file still says there is a conversation inside. */}
        {placed.counts.open > 0 && (
          <span
            className="comment-count border-action/50 text-action"
            title={`${placed.counts.open} unresolved ${placed.counts.open === 1 ? 'conversation' : 'conversations'} on GitHub`}
          >
            <MessageSquare aria-hidden /> {placed.counts.open}
          </span>
        )}
        {placed.counts.resolved > 0 && (
          <span
            className="comment-count text-ready"
            title={`${placed.counts.resolved} resolved ${placed.counts.resolved === 1 ? 'conversation' : 'conversations'}`}
          >
            <CircleCheck aria-hidden /> {placed.counts.resolved}
          </span>
        )}
        {drafts.length > 0 && (
          <span className="comment-count draft" title={`${drafts.length} drafted ${drafts.length === 1 ? 'comment' : 'comments'}, not posted yet`}>
            <NotebookPen aria-hidden /> {drafts.length}
          </span>
        )}
        <span className="muted">{file.status}</span>
        <span>
          <span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span>
        </span>
        {/* As on GitHub: ticking Viewed folds the file away, and it stays ticked until the file changes. */}
        <label className={viewed ? 'viewed-toggle on' : 'viewed-toggle'}>
          <Checkbox
            checked={viewed}
            onCheckedChange={(v) => {
              setOpen(v !== true)
              onViewed(file, v === true)
            }}
          />
          Viewed
        </label>
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
                              <button
                                title={`Comment on line ${line}`}
                                aria-label={`Comment on line ${line}`}
                                onClick={() => onAdd(file.path, line)}
                              >
                                +
                              </button>
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
  const [detail, setDetail] = useState<PrDetail | null>(null)
  const [draft, setDraft] = useState<ReviewDraft | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [branchCopied, setBranchCopied] = useState(false)
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

  const load = useCallback(async () => {
    try {
      const [d, dr] = await Promise.all([window.api.prDetail(pr.repo, pr.number), window.api.getDraft(pr.key)])
      const real = dr && hasContent(dr) ? dr : null
      if (dr && !real) void window.api.discardDraft(pr.key)
      setDetail(d)
      setDraft(real)
      latest.current = real
      stored.current = !!real
      setLoadError(null)
    } catch (e) {
      setLoadError(cleanError(e))
    }
  }, [pr.repo, pr.number, pr.key])

  useEffect(() => void load(), [load])
  useEffect(() => {
    if (progress?.state === 'done') void load()
  }, [progress?.state, load])

  // Flush a pending save when leaving the view.
  useEffect(
    () => () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
        if (latest.current && hasContent(latest.current)) void window.api.saveDraft(latest.current)
        else if (stored.current) void window.api.discardDraft(pr.key)
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
          void (real ? window.api.saveDraft(next) : changed ? window.api.discardDraft(pr.key) : Promise.resolve()).then(
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
      await load()
      onDraftChanged()
    } catch (e) {
      setPostError(cleanError(e))
    } finally {
      setPosting(false)
    }
  }

  const discard = async (): Promise<void> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    await window.api.discardDraft(pr.key)
    setDraft(null)
    latest.current = null
    stored.current = false
    setConfirming(false)
    onDraftChanged()
  }

  const startReview = (): void => void window.api.startReview(pr, focus)
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
        <button className="button quiet" onClick={() => void window.api.openExternal(pr.url)}>
          Open on GitHub
        </button>
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
        <aside className="review-pane" aria-label="Review">
          <h2>{pr.role === 'mine' ? 'Self-review' : 'Your review'}</h2>

          {running && (
            <div className="progress">
              <span className="spinner" aria-hidden />
              <span>{progress!.step}</span>
              <button className="link-button" onClick={() => void window.api.cancelReview(pr.key)}>
                Cancel
              </button>
            </div>
          )}
          {progress?.state === 'error' && (
            <div className="banner error" role="alert">
              The review did not finish. {progress.error}
            </div>
          )}

          {!real && !running && (
            <div className="start">
              <label className="field">
                Focus (optional)
                <textarea
                  value={focus}
                  rows={3}
                  onChange={(e) => setFocus(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) startReview()
                  }}
                  placeholder="e.g. the retry logic, error handling"
                />
              </label>
              <ReviewOptionsPicker />
              <button
                className="button primary"
                onClick={startReview}
                title="Claude reads the changes in a separate checkout kept by Docket and drafts comments. Nothing is posted until you choose to."
              >
                Review with Claude
              </button>
              <p className="muted small">Or press + on a line to comment yourself.</p>
            </div>
          )}

          {real && draft && (
            <>
              {posted && (
                <div className="banner ok">
                  Review posted {ago(posted.at)}.{' '}
                  <button className="link-button" onClick={() => void window.api.openExternal(posted.url)}>
                    View on GitHub
                  </button>
                </div>
              )}
              {stale && (
                <div className="banner">
                  New commits were pushed after this review was drafted. Comments may point at lines that moved.
                </div>
              )}
              {(draft.model || draft.effort) && draft.comments.some((c) => c.source === 'ai') && (
                <p className="muted small">
                  Drafted with {[draft.model, draft.effort && `${draft.effort} effort`].filter(Boolean).join(', ')}.
                </p>
              )}
              {!draft.fullContext && draft.comments.some((c) => c.source === 'ai') && (
                <p className="muted small">Claude saw only the diff for this review, not the rest of the repository.</p>
              )}

              <label className="field">
                Summary
                <textarea
                  value={draft.summary}
                  rows={summaryRows(draft.summary)}
                  readOnly={readOnly}
                  placeholder="Overall comment for the author"
                  onChange={(e) => update((d) => ({ ...d, summary: e.target.value }))}
                />
              </label>

              <div className="field">
                Post as
                <div className="segmented" role="radiogroup" aria-label="Review type">
                  {(Object.keys(VERDICT_LABEL) as Verdict[]).map((v) => (
                    <button
                      key={v}
                      role="radio"
                      aria-checked={draft.verdict === v}
                      className={draft.verdict === v ? 'on' : ''}
                      disabled={readOnly || (pr.role === 'mine' && v !== 'comment')}
                      onClick={() => update((d) => ({ ...d, verdict: v }))}
                    >
                      {VERDICT_LABEL[v]}
                    </button>
                  ))}
                </div>
                {pr.role === 'mine' && (
                  <span className="muted small">GitHub only allows comments on your own pull request.</span>
                )}
              </div>

              <h3>
                Comments <span className="count">{toPost.length} to post of {written.length}</span>
              </h3>
              {written.length === 0 && <p className="muted small">No comments. Press + next to a line to add one.</p>}
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
                  <h3>Not on a changed line</h3>
                  <p className="muted small">
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
                <div className="banner error" role="alert">
                  GitHub did not accept the review. {postError}
                </div>
              )}

              <div className="review-actions">
                {posted ? (
                  <button className="button" onClick={() => void discard()}>
                    Start a new review
                  </button>
                ) : confirming ? (
                  <div className="confirm">
                    <p>
                      Post to {pr.repo}#{pr.number} as <strong>{VERDICT_LABEL[draft.verdict]}</strong> with{' '}
                      {toPost.length} {toPost.length === 1 ? 'comment' : 'comments'}? {pr.author.login} and other
                      watchers will be notified.
                    </p>
                    <button className="button primary" disabled={posting} onClick={() => void post()}>
                      {posting ? 'Posting…' : 'Post review'}
                    </button>
                    <button className="button quiet" disabled={posting} onClick={() => setConfirming(false)}>
                      Keep editing
                    </button>
                  </div>
                ) : rerunning ? (
                  <form
                    className="confirm"
                    onSubmit={(e) => {
                      e.preventDefault()
                      setRerunning(false)
                      startReview()
                    }}
                  >
                    <label className="field">
                      Anything to focus on this time? (optional)
                      <textarea
                        autoFocus
                        value={focus}
                        rows={3}
                        onChange={(e) => setFocus(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit()
                        }}
                        placeholder="e.g. the retry logic, error handling"
                      />
                    </label>
                    <ReviewOptionsPicker />
                    <p className="muted small">This replaces the current draft, including your edits.</p>
                    <button type="submit" className="button primary" disabled={running}>
                      Run Claude again
                    </button>
                    <button type="button" className="button quiet" onClick={() => setRerunning(false)}>
                      Keep this draft
                    </button>
                  </form>
                ) : (
                  <>
                    <button className="button primary" disabled={!canPost} onClick={() => setConfirming(true)}>
                      Post review…
                    </button>
                    <button className="button quiet" disabled={running} onClick={() => setRerunning(true)}>
                      Run Claude again…
                    </button>
                    <button className="link-button danger" onClick={() => void discard()}>
                      Discard draft
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </aside>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

const EMPTY_FILES: PrFile[] = []
const EMPTY_DRAFTS: DraftComment[] = []
const EMPTY_EXISTING: ExistingComment[] = []
