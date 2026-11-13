import type { ExistingComment, PrComment, PrReview, PrSummary } from '../../shared/types'
import { parsePatch, type DiffRow } from '../../shared/diff'

/** A conversation already on GitHub: the first comment and its replies, in order. */
export interface Thread {
  id: string
  comments: ExistingComment[]
  resolved: boolean | null
  resolvedBy: string | null
  /** The code it was written on has changed since. */
  outdated: boolean
}

export function threadsOf(comments: ExistingComment[]): Thread[] {
  const map = new Map<string, Thread>()
  for (const c of [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const key = c.thread || `c${c.id}`
    let t = map.get(key)
    if (!t) map.set(key, (t = { id: key, comments: [], resolved: c.resolved, resolvedBy: c.resolvedBy, outdated: c.outdated }))
    t.comments.push(c)
  }
  return [...map.values()]
}

export const countThreads = (threads: Thread[]): { open: number; resolved: number } => ({
  open: threads.filter((t) => t.resolved !== true).length,
  resolved: threads.filter((t) => t.resolved === true).length
})

/** Where a comment sits: "line 42" or "lines 40 to 42", as it is now or, once outdated, as it was written. */
export function whereOf(c: ExistingComment): string {
  const line = c.line ?? c.originalLine
  if (line === null) return ''
  const start = c.line !== null ? c.startLine : c.originalStartLine
  const range = start !== null && start !== line ? `lines ${start} to ${line}` : `line ${line}`
  return `${range}${c.side === 'LEFT' ? ' (removed code)' : ''}`
}

const MIN_HUNK_LINES = 4
const MAX_HUNK_LINES = 20

/**
 * The lines a comment was written on, as GitHub shows them over a conversation: the end of its
 * diff hunk, reaching back to the first line of a comment made on several lines.
 */
export function hunkTail(c: ExistingComment): DiffRow[] {
  const rows = parsePatch(c.diffHunk).filter((r) => r.type !== 'hunk')
  const start = c.originalStartLine ?? c.startLine
  let take = MIN_HUNK_LINES
  if (start !== null)
    for (let i = rows.length - 1; i >= 0; i--)
      if ((c.side === 'LEFT' ? rows[i].oldLine : rows[i].newLine) === start) {
        take = Math.max(take, rows.length - i)
        break
      }
  return rows.slice(-Math.min(take, MAX_HUNK_LINES))
}

// ---------- Selecting and copying ----------

/** Something in the conversation that can be selected and copied. */
export type Picked =
  | { kind: 'thread'; thread: Thread }
  | { kind: 'comment'; comment: PrComment }
  | { kind: 'review'; review: PrReview }

export const threadKey = (t: Thread): string => `t:${t.id}`
export const commentKey = (c: PrComment): string => `c:${c.id}`
export const reviewKey = (r: PrReview): string => `r:${r.id}`

const REVIEW_VERB: Record<PrReview['state'], string> = {
  approved: 'approved',
  changes_requested: 'requested changes',
  commented: 'reviewed',
  dismissed: 'reviewed (since dismissed)'
}

const quote = (body: string): string =>
  body
    .replace(/\r\n?/g, '\n')
    .trim()
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n')

/** A fence longer than any run of backticks in the text, so code that contains fences stays intact. */
function fenced(text: string, lang: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}${lang}\n${text}\n${fence}`
}

const day = (iso: string): string => iso.slice(0, 10)

function threadMarkdown(t: Thread, n: number): string {
  const [first, ...replies] = t.comments
  const where = whereOf(first)
  const notes = [
    t.resolved === true ? 'resolved' : t.resolved === false ? 'unresolved' : '',
    t.outdated ? 'outdated: the code has changed since' : ''
  ].filter(Boolean)
  const rows = hunkTail(first)
  const parts = [`### ${n}. \`${first.path}\`${where ? `, ${where}` : ''}${notes.length ? ` (${notes.join('; ')})` : ''}`]
  if (rows.length)
    parts.push(fenced(rows.map((r) => `${r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' '}${r.text}`).join('\n'), 'diff'))
  parts.push(`**${first.author}** (${day(first.createdAt)}):\n${quote(first.body)}`)
  for (const r of replies) parts.push(`**${r.author}** replied (${day(r.createdAt)}):\n${quote(r.body)}`)
  parts.push(first.url)
  return parts.join('\n\n')
}

/**
 * Review feedback as markdown, written to be pasted to Claude or into a note: what the pull request
 * is, then each comment with the file, the lines and the code it is about, and the replies under it.
 */
export function toMarkdown(pr: PrSummary, items: Picked[]): string {
  const general = items.filter((i) => i.kind !== 'thread')
  const threads = items.filter((i) => i.kind === 'thread')
  const out = [
    `# Review comments on ${pr.repo}#${pr.number}`,
    `**${pr.title}**\nBranch \`${pr.headRef}\` into \`${pr.baseRef}\`\n${pr.url}`
  ]
  if (general.length) {
    out.push('## General comments')
    for (const i of general) {
      if (i.kind === 'review')
        out.push(`**${i.review.author}** ${REVIEW_VERB[i.review.state]} (${day(i.review.submittedAt)}):\n${quote(i.review.body)}\n\n${i.review.url}`)
      else if (i.kind === 'comment')
        out.push(`**${i.comment.author}** commented (${day(i.comment.createdAt)}):\n${quote(i.comment.body)}\n\n${i.comment.url}`)
    }
  }
  if (threads.length) {
    out.push(`## Comments on the code (${threads.length})`)
    threads.forEach((i, n) => i.kind === 'thread' && out.push(threadMarkdown(i.thread, n + 1)))
  }
  return `${out.join('\n\n')}\n`
}
