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

export interface PrList {
  viewer: string
  fetchedAt: string
  prs: PrSummary[]
  /** Set when GitHub could not be reached and this is the last list that was fetched. */
  notice?: string
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

export interface PrDetail {
  body: string
  /** The description as GitHub renders it, with signed links to attached images and videos that expire after a few minutes. */
  bodyHtml: string
  headSha: string
  files: PrFile[]
  comments: ExistingComment[]
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

export interface ReviewDraft {
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
  state: 'running' | 'done' | 'error' | 'cancelled'
  step: string
  error?: string
}

export interface PostRequest {
  repo: string
  number: number
  headSha: string
  verdict: Verdict
  body: string
  comments: { path: string; line: number; body: string }[]
}

/** A review as it was posted to GitHub, kept for the Review tab's history whatever happens to the draft. */
export interface PostedReview {
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
export interface Snapshot {
  date: string // YYYY-MM-DD, local time
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
export interface Chat {
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
export interface Notice {
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
  total: number
  items: StorageItem[]
}

export interface Api {
  getSettings(): Promise<Settings>
  /** What the claude CLI uses when no model or effort is chosen, read from the user's Claude Code settings. Empty when unknown. */
  reviewDefaults(): Promise<{ model: string; effort: string }>
  saveSettings(settings: Settings): Promise<Settings>
  /** Drafts a voice guide from the signed-in user's recent review comments. Does not save it. */
  learnVoice(): Promise<{ guide: string; samples: number }>
  performance(force: boolean): Promise<Performance>
  /** The dashboard list. Reuses a recent result unless `force` is set (the Refresh button). */
  listPrs(force?: boolean): Promise<PrList>
  /** Every open pull request by other people in these repositories. */
  listOpenPrs(repos: string[]): Promise<{ prs: PrSummary[]; truncated: boolean }>
  prDetail(repo: string, number: number): Promise<PrDetail>
  checkLog(repo: string, jobId: number): Promise<CheckLog>
  /** Re-run one failed GitHub Actions job. */
  rerunJob(repo: string, jobId: number): Promise<void>
  /** Re-run the failed jobs of these GitHub Actions workflow runs. */
  rerunFailedJobs(repo: string, runIds: number[]): Promise<void>
  getDraft(key: string): Promise<ReviewDraft | null>
  saveDraft(draft: ReviewDraft): Promise<void>
  /** `why` is logged, so a draft that goes missing can be traced. */
  discardDraft(key: string, why: string): Promise<void>
  /** Reviews posted on a pull request, newest first. */
  listReviews(key: string): Promise<PostedReview[]>
  /** `extend` keeps the current draft and adds only what it does not already have. Replaces by default. */
  startReview(pr: PrSummary, focus: string, mode?: 'replace' | 'extend'): Promise<void>
  cancelReview(key: string): Promise<void>
  runningReviews(): Promise<ReviewProgress[]>
  postReview(req: PostRequest): Promise<{ url: string }>
  /** Put text on the clipboard, optionally with a rich (HTML) version for apps that accept it. */
  copyText(text: string, html?: string): Promise<void>
  openExternal(url: string): Promise<void>
  storageUsage(): Promise<StorageUsage>
  clearStorage(id: string): Promise<void>
  /** Open the app's data folder in Finder. */
  revealStorage(): Promise<void>
  onReviewProgress(cb: (p: ReviewProgress) => void): () => void
  /** The conversations about a pull request, most recent first, and which of them Claude is answering in. */
  listChats(key: string): Promise<{ chats: Chat[]; running: string[] }>
  /** Asks in conversation `chatId`, or starts a new one when it is null. Resolves with the conversation's id. */
  sendChat(pr: PrSummary, chatId: string | null, question: string): Promise<string | null>
  cancelChat(chatId: string): Promise<void>
  deleteChat(chatId: string): Promise<void>
  onChatEvent(cb: (e: ChatEvent) => void): () => void
  listNotices(): Promise<Notice[]>
  markNoticesRead(): Promise<void>
  /** A new notice, for the toast and the bell. */
  onNotice(cb: (n: Notice) => void): () => void
  /** The user clicked a macOS notification: open what it is about. */
  onOpenNotice(cb: (n: Notice) => void): () => void
  getTheme(): Promise<Theme>
  setTheme(theme: Theme): Promise<void>
  isFullScreen(): Promise<boolean>
  onFullScreen(cb: (on: boolean) => void): () => void
}
