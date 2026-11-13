import type { SystemMapApi } from './sysmap'

export type Level = 'action' | 'ready' | 'waiting'
export type Role = 'mine' | 'review'
export type CiState = 'success' | 'failure' | 'pending' | 'none'

export interface Reason {
  level: Level
  text: string
  /** A few words for a dashboard row, where the author is already shown beside it. Falls back to text. */
  short?: string
  /** Shown in red rather than the usual attention colour. */
  failing?: boolean
}

export interface FailingCheck {
  /** "Workflow / job" for GitHub Actions jobs, otherwise the check or status name. */
  name: string
  /** The GitHub Actions workflow the job belongs to; null for other kinds of checks. */
  workflow?: string | null
  url: string | null
  /** Whether branch protection requires this check to pass before merging. Null when GitHub did not say. */
  required: boolean | null
  /** The GitHub Actions job behind this check, when there is one; its log can be fetched and it can be re-run. */
  jobId: number | null
  /** The GitHub Actions workflow run the job belongs to. */
  runId: number | null
}

/** Why one failed GitHub Actions job failed. */
export interface CheckLog {
  /** Name of the step that failed. */
  step: string | null
  /** The log lines leading up to the first error. Empty when the log could not be read. */
  excerpt: string
  logError?: string
}

export interface PrSummary {
  key: string // "owner/name#123"
  repo: string
  number: number
  title: string
  url: string
  author: { login: string; avatarUrl: string }
  isDraft: boolean
  updatedAt: string
  createdAt: string
  additions: number
  deletions: number
  changedFiles: number
  headSha: string
  baseRef: string
  headRef: string
  /**
   * The signed-in GitHub account this pull request was found with. Everything Docket does to it
   * (reading it, re-running checks, posting a review) is done as that account.
   */
  account: string
  role: Role
  ci: CiState
  failingChecks: FailingCheck[]
  /** Checks are failing and that stops the merge. False with ci 'failure' means only checks that are not required failed. */
  ciBlocksMerge: boolean
  /** Where the review stands. 'none' means nobody has reviewed and no review is required. */
  approval: 'approved' | 'changes_requested' | 'review_required' | 'none'
  approvedBy: string[]
  changesRequestedBy: string[]
  /**
   * Whether it can be merged now: approved, no conflicts, and no required check failing.
   * 'blocked' lists why in mergeBlockers; 'pending' means approved but checks are still running.
   */
  merge: 'mergeable' | 'blocked' | 'pending' | 'unapproved'
  mergeBlockers: string[]
  /** What the description shows of the change: a screen recording, or failing that screenshots. */
  preview?: 'video' | 'image'
  /** The latest review you submitted on GitHub, whether through Docket or not. Absent when you have not reviewed. */
  myReview?: 'approved' | 'changes_requested' | 'commented'
  level: Level
  reasons: Reason[]
  draftState: 'none' | 'draft' | 'stale' | 'posted'
  /**
   * Only on the bottom open pull request of a stack: the parts below it that have already merged,
   * in merge order, so the whole stack can be shown.
   */
  mergedBelow?: MergedStackPr[]
}

/** A part of a stack that has already merged. */
export interface MergedStackPr {
  key: string
  number: number
  title: string
  url: string
  mergedAt: string
  additions: number
  deletions: number
  baseRef: string
  headRef: string
}

/**
 * Names one account's copy of a pull request. Two accounts can each list the same one, so its key
 * alone is not enough. Drafts are stored under this, so the format must not change.
 */
export const prId = (account: string, key: string): string => `${account} ${key}`

/** A pull request as it is named in passing: "docket#12", without the owner. */
export const shortName = (pr: { repo: string; number: number }): string => `${pr.repo.split('/')[1]}#${pr.number}`

export interface PrList {
  /** The GitHub accounts the list covers. The first is the one gh uses in a terminal, when that one is switched on. */
  accounts: string[]
  fetchedAt: string
  /**
   * Every account's pull requests. The accounts are kept apart: a pull request two of them have
   * to do with is here once for each, and the window only ever shows one account's.
   */
  prs: PrSummary[]
  /** Set when GitHub could not be reached, for every account or for one, and what is shown is older. */
  notice?: string
}

/** A GitHub account the gh CLI is signed in to on this computer. */
export interface Account {
  login: string
  /** The account gh itself uses in a terminal. Docket does not depend on it and never changes it. */
  active: boolean
  /** Whether Docket shows this account's pull requests. On unless switched off here. */
  enabled: boolean
  /** Set when gh says its sign-in for this account no longer works. */
  problem?: string
}

export interface PrFile {
  path: string
  previousPath?: string
  status: string
  additions: number
  deletions: number
  patch?: string
}

export interface ExistingComment {
  id: number
  path: string
  /** Line the comment sits on now, in the new file (side RIGHT) or the old one (side LEFT). Null once the code under it changed. */
  line: number | null
  side: 'LEFT' | 'RIGHT'
  /** Line it was written on, kept so an outdated comment can still say where it was. */
  originalLine: number | null
  /** First line of a comment on several lines, now and when it was written. Null for a comment on one line. */
  startLine: number | null
  originalStartLine: number | null
  /** The diff the comment was written on, from the hunk header down to the commented line. */
  diffHunk: string
  /** The review it was submitted with. */
  reviewId: number | null
  /** The code under the thread has changed since it was written. */
  outdated: boolean
  author: string
  avatarUrl: string
  body: string
  createdAt: string
  url: string
  /** The comment this one answers; null for the comment that started the thread. */
  replyTo: number | null
  /** The review thread it belongs to, the same for every comment in it. */
  thread: string
  /** Whether the thread is marked resolved. Null when GitHub did not say. */
  resolved: boolean | null
  /** Who resolved the thread. */
  resolvedBy: string | null
}

/** One commit on the pull request's branch. */
export interface PrCommit {
  sha: string
  /** First line of the commit message. */
  message: string
  /** GitHub login, or the name in the commit when it is not tied to an account. */
  author: string
  avatarUrl: string
  committedAt: string
  url: string
}

/** A comment on the pull request as a whole, not on a line of the diff. */
export interface PrComment {
  id: number
  author: string
  avatarUrl: string
  body: string
  /** The comment as GitHub renders it; see PrDetail.bodyHtml. */
  bodyHtml: string
  createdAt: string
  url: string
}

/** A submitted review: its verdict and summary. Its line comments are in PrDetail.comments, linked by reviewId. */
export interface PrReview {
  id: number
  author: string
  avatarUrl: string
  state: 'approved' | 'changes_requested' | 'commented' | 'dismissed'
  body: string
  bodyHtml: string
  submittedAt: string
  url: string
}

export interface PrDetail {
  body: string
  /** The description as GitHub renders it, with signed links to attached images and videos that expire after a few minutes. */
  bodyHtml: string
  headSha: string
  files: PrFile[]
  /** Comments on lines of the diff. */
  comments: ExistingComment[]
  commits: PrCommit[]
  /** Comments on the pull request as a whole. */
  conversation: PrComment[]
  reviews: PrReview[]
  truncated: boolean
}

export type Severity = 'blocker' | 'issue' | 'suggestion' | 'nit' | 'question'
export type Verdict = 'comment' | 'approve' | 'request_changes'

export interface DraftComment {
  id: string
  path: string
  line: number
  severity: Severity
  title: string
  body: string
  included: boolean
  source: 'ai' | 'me'
}

/** Something saved for one GitHub account: a draft, a posted review, a conversation, a notification. */
export interface Owned {
  /** The GitHub account it belongs to. Absent on what was saved before accounts were kept apart. */
  account?: string
}

export interface ReviewDraft extends Owned {
  key: string
  headSha: string
  createdAt: string
  summary: string
  verdict: Verdict
  comments: DraftComment[]
  fullContext: boolean
  /** What drafted it, when that was chosen explicitly. */
  model?: string
  effort?: string
  posted?: { url: string; at: string }
}

export interface ReviewProgress {
  key: string
  /** The account the review is drafted for. */
  account?: string
  state: 'running' | 'done' | 'error' | 'cancelled'
  step: string
  error?: string
}

export interface PostRequest {
  /** The account to post as: the one the pull request is listed for. */
  account?: string
  repo: string
  number: number
  headSha: string
  verdict: Verdict
  body: string
  comments: { path: string; line: number; body: string }[]
}

/** A review as it was posted to GitHub, kept for the Review tab's history whatever happens to the draft. */
export interface PostedReview extends Owned {
  id: string
  /** The pull request it was posted on. */
  key: string
  at: string
  url: string
  verdict: Verdict
  /** The review body as posted: the summary, plus comments that could not go on a line. */
  body: string
  comments: { path: string; line: number; body: string }[]
  headSha: string
  model?: string
  effort?: string
}

export interface MergedPr {
  key: string
  title: string
  url: string
  createdAt: string
  mergedAt: string
  additions: number
  deletions: number
  /** First review from someone else, if any. */
  firstReviewAt: string | null
}

/** One review you submitted on someone else's pull request. */
export interface ReviewGiven {
  key: string
  title: string
  url: string
  author: string
  submittedAt: string
  state: string
  /** Hours from being asked (or the PR opening) to your first review. Only set on your first review of that PR. */
  responseHours: number | null
}

/** One commit of yours that landed on a repository's default branch. */
export interface CommitMade {
  sha: string
  repo: string
  /** First line of the commit message. */
  message: string
  url: string
  committedAt: string
}

/** What the dashboard looked like on one day, recorded locally. */
export interface Snapshot extends SnapshotCounts {
  date: string // YYYY-MM-DD, local time
}

/**
 * One day as it is stored: each account's counts. A day recorded before accounts were kept apart
 * has the counts at the top level instead; they belong to the account gh was using then.
 */
export interface StoredSnapshot extends Partial<SnapshotCounts> {
  date: string
  byAccount?: Record<string, SnapshotCounts>
}

export interface SnapshotCounts {
  blocked: number
  ready: number
  reviewQueue: number
  queueLines: number
}

export interface Performance {
  fetchedAt: string
  since: string
  merged: MergedPr[]
  reviews: ReviewGiven[]
  commits: CommitMade[]
  /** How far back the commits reach. Tracked apart from `since` because commits were added to the history later. */
  commitsSince?: string
  snapshots: Snapshot[]
  truncated: boolean
  /** The history does not reach back a full year yet; the rest is fetched on a later visit. */
  partial?: boolean
}

/** How the reviewer writes, so drafted comments sound like them. */
export interface VoiceSettings {
  enabled: boolean
  /** Free-form description of the reviewer's writing style, given to Claude with every review. */
  guide: string
  /** Set when the guide was last generated from the reviewer's own GitHub comments. */
  learnedAt?: string
  learnedFrom?: number
  /** How long the review summary may be. Concise unless the reviewer asks for more. */
  summaryLength: SummaryLength
}

export const SUMMARY_LENGTHS = ['concise', 'standard', 'detailed'] as const
export type SummaryLength = (typeof SUMMARY_LENGTHS)[number]

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]
export const VERBOSITIES = ['brief', 'normal', 'detailed'] as const
export type Verbosity = (typeof VERBOSITIES)[number]

/** Which Claude drafts reviews and how hard it thinks. Empty means whatever the claude CLI defaults to. */
export interface ReviewOptions {
  /** A model alias such as "opus" or a full model name. */
  model: string
  effort: Effort | ''
  /** How much the review says: fewer, shorter comments, or more of them with fuller explanations. */
  verbosity: Verbosity
}

export interface Settings {
  voice: VoiceSettings
  review: ReviewOptions
  /** The same choices for questions about a pull request; verbosity sets how long answers are. */
  chat: ReviewOptions
  /** The same choices for scanning a system map; verbosity sets how deep a scan goes. Opus at medium effort unless changed. */
  map: ReviewOptions
  /**
   * `disabled`: GitHub accounts switched off in Docket. `original`: the account gh was using when
   * accounts were first kept apart; everything saved before that is its. Neither is changed by saveSettings.
   */
  accounts: { disabled: string[]; original?: string }
  /**
   * Each account's own voice, by login. An account without one yet starts from `voice`, the guide
   * from before accounts were kept apart, and gets its own the first time it is saved.
   */
  voices: Record<string, VoiceSettings>
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  at: string
  /** Set when the answer did not finish; `text` then holds whatever arrived. */
  error?: string
}

/** A conversation with Claude about one pull request. */
export interface Chat extends Owned {
  id: string
  /** The pull request it is about. */
  key: string
  /** The first question, shortened; names the conversation in the history. */
  title: string
  createdAt: string
  updatedAt: string
  /** The claude CLI session the conversation continues in. */
  sessionId: string
  /** Where the session runs: the pull request's own checkout, or an empty folder when only the diff is available. */
  cwd: string
  /** The commit Claude last saw, so new pushes can be passed on. */
  headSha: string
  messages: ChatMessage[]
}

/** Progress of an answer: the text so far while it streams, then how it ended. */
export interface ChatEvent {
  key: string
  account?: string
  chatId: string
  state: 'running' | 'done' | 'error' | 'cancelled'
  step?: string
  partial?: string
  error?: string
}

export type NoticeKind =
  | 'review-done'
  | 'review-failed'
  | 'chat-done'
  | 'chat-failed'
  | 'needs-you'
  | 'ci-failed'
  | 'ci-passed'
  | 'approved'
  | 'changes-requested'
  | 'ready'

/** Something Docket told the user about, kept for the bell's list. */
export interface Notice extends Owned {
  id: string
  at: string
  kind: NoticeKind
  title: string
  body: string
  /** The pull request it is about; absent when it covers several. */
  prKey?: string
  prUrl?: string
  read: boolean
}

/** Follow macOS, or force one appearance. */
export type Theme = 'system' | 'light' | 'dark'

/** One thing Docket keeps on disk, as shown on the Storage page. */
export interface StorageItem {
  /** What clearStorage takes: "repo:<dir>", "drafts:open", "drafts:posted", "history", "snapshots", "cache", ... */
  id: string
  /** 'app' is what every account shares; the rest is the one account's. */
  group: 'repos' | 'data' | 'app'
  label: string
  detail: string
  bytes: number
  /** For repository clones, when a review last fetched into it. */
  lastUsed?: string
  clearable: boolean
}

export interface StorageUsage {
  /** The app's data folder. */
  path: string
  /** The account's own data. What every account shares is listed too, but not counted here. */
  total: number
  items: StorageItem[]
}

/** Everything the window can ask of the main process. The system map's part is in sysmap.ts. */
export interface Api extends SystemMapApi {
  getSettings(): Promise<Settings>
  /** What the claude CLI uses when no model or effort is chosen, read from the user's Claude Code settings. Empty when unknown. */
  reviewDefaults(): Promise<{ model: string; effort: string }>
  saveSettings(settings: Settings): Promise<Settings>
  /** The GitHub accounts gh is signed in to. `force` asks gh again instead of using what it said a moment ago. */
  listAccounts(force?: boolean): Promise<Account[]>
  /** Show or hide one account's pull requests. Resolves with the accounts as they are now. */
  setAccountEnabled(login: string, enabled: boolean): Promise<Account[]>
  /** Drafts a voice guide from one account's recent review comments. Does not save it. */
  learnVoice(account: string): Promise<{ guide: string; samples: number }>
  /** One account's history. */
  performance(account: string, force: boolean): Promise<Performance>
  /** The dashboard list. Reuses a recent result unless `force` is set (the Refresh button). */
  listPrs(force?: boolean): Promise<PrList>
  /** Every open pull request by other people in these repositories, as one account sees them. */
  listOpenPrs(account: string, repos: string[]): Promise<{ prs: PrSummary[]; truncated: boolean }>
  // What follows names a pull request by the account it is listed for, since two accounts can each list the same one.
  prDetail(account: string, repo: string, number: number): Promise<PrDetail>
  checkLog(account: string, repo: string, jobId: number): Promise<CheckLog>
  /** Re-run one failed GitHub Actions job. */
  rerunJob(account: string, repo: string, jobId: number): Promise<void>
  /** Re-run the failed jobs of these GitHub Actions workflow runs. */
  rerunFailedJobs(account: string, repo: string, runIds: number[]): Promise<void>
  getDraft(account: string, key: string): Promise<ReviewDraft | null>
  saveDraft(draft: ReviewDraft): Promise<void>
  /** `why` is logged, so a draft that goes missing can be traced. */
  discardDraft(account: string, key: string, why: string): Promise<void>
  /** Reviews posted on a pull request, newest first. */
  listReviews(account: string, key: string): Promise<PostedReview[]>
  /** `extend` keeps the current draft and adds only what it does not already have. Replaces by default. */
  startReview(pr: PrSummary, focus: string, mode?: 'replace' | 'extend'): Promise<void>
  cancelReview(account: string, key: string): Promise<void>
  runningReviews(): Promise<ReviewProgress[]>
  postReview(req: PostRequest): Promise<{ url: string }>
  /** Put text on the clipboard, optionally with a rich (HTML) version for apps that accept it. */
  copyText(text: string, html?: string): Promise<void>
  openExternal(url: string): Promise<void>
  /** What one account keeps on this computer, and what every account shares. */
  storageUsage(account: string): Promise<StorageUsage>
  /** Clears one item: of that account only, unless the item is shared. */
  clearStorage(account: string, id: string): Promise<void>
  /** Open the app's data folder in Finder. */
  revealStorage(): Promise<void>
  onReviewProgress(cb: (p: ReviewProgress) => void): () => void
  /** The conversations about a pull request, most recent first, and which of them Claude is answering in. */
  listChats(account: string, key: string): Promise<{ chats: Chat[]; running: string[] }>
  /** Asks in conversation `chatId`, or starts a new one when it is null. Resolves with the conversation's id. */
  sendChat(pr: PrSummary, chatId: string | null, question: string): Promise<string | null>
  cancelChat(chatId: string): Promise<void>
  deleteChat(chatId: string): Promise<void>
  onChatEvent(cb: (e: ChatEvent) => void): () => void
  /** One account's notifications, newest first. */
  listNotices(account: string): Promise<Notice[]>
  markNoticesRead(account: string): Promise<void>
  /** A new notice, for the toast and the bell. */
  onNotice(cb: (n: Notice) => void): () => void
  /** The user clicked a macOS notification: open what it is about. */
  onOpenNotice(cb: (n: Notice) => void): () => void
  getTheme(): Promise<Theme>
  setTheme(theme: Theme): Promise<void>
  isFullScreen(): Promise<boolean>
  onFullScreen(cb: (on: boolean) => void): () => void
}
