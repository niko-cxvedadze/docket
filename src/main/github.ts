import { run } from './env'
import type {
  CheckLog,
  CommitMade,
  CiState,
  ExistingComment,
  FailingCheck,
  Level,
  PostRequest,
  PrDetail,
  PrFile,
  PrSummary,
  Reason,
  Role
} from '../shared/types'

let cachedToken: string | null = null

async function token(): Promise<string> {
  if (cachedToken) return cachedToken
  let out: string
  try {
    out = await run('gh', ['auth', 'token'])
  } catch (e) {
    throw new Error(
      `Could not get a GitHub token from the gh CLI. Run "gh auth login" in a terminal, then refresh. (${(e as Error).message})`
    )
  }
  cachedToken = out.trim()
  return cachedToken
}

export async function gh(path: string, init: RequestInit & { accept?: string } = {}): Promise<Response> {
  const res = await fetch(path.startsWith('http') ? path : `https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await token()}`,
      Accept: init.accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'docket-desktop',
      ...(init.body ? { 'Content-Type': 'application/json' } : {})
    }
  })
  if (res.status === 401) cachedToken = null
  if (!res.ok) {
    let detail = ''
    try {
      const j = (await res.json()) as { message?: string; errors?: unknown[] }
      detail = [j.message, ...(j.errors ?? []).map((e) => (typeof e === 'string' ? e : JSON.stringify(e)))]
        .filter(Boolean)
        .join(' — ')
    } catch {
      /* no body */
    }
    throw new Error(`GitHub ${res.status}: ${detail || res.statusText}`)
  }
  return res
}

// When the pull request below in a stack merges, GitHub moves the next one onto its base branch and
// records where it pointed before. That is how merged parts of a stack are found again.
const BASE_CHANGES = `timelineItems(itemTypes: [BASE_REF_CHANGED_EVENT], last: 10) {
    nodes { ... on BaseRefChangedEvent { createdAt previousRefName currentRefName } }
  }`

const PR_FIELDS = `
  number title url body isDraft updatedAt createdAt additions deletions changedFiles
  mergeable reviewDecision headRefOid headRefName baseRefName
  repository { nameWithOwner }
  author { login avatarUrl }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviewThreads(first: 60) { nodes { isResolved comments(last: 1) { nodes { author { login } } } } }
  latestReviews(first: 30) { nodes { author { login } state commit { oid } } }
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } } } }
  ${BASE_CHANGES}
`

const LIST_QUERY = `
query($q: String!) {
  viewer { login }
  search(query: $q, type: ISSUE, first: 40) {
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
}`

const SEARCHES = {
  mine: 'is:pr is:open author:@me archived:false sort:updated-desc',
  requested: 'is:pr is:open review-requested:@me archived:false sort:updated-desc',
  reviewed: 'is:pr is:open reviewed-by:@me -author:@me archived:false sort:updated-desc'
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// GitHub allows 30 searches a minute, shared by everything signed in as you. Docket keeps under
// that itself: the dashboard may use most of it, and background history only a part, so a long
// history fetch can never starve the dashboard.
const SEARCH_WINDOW_MS = 61_000
const SEARCH_CAP = { foreground: 22, background: 10 }
const searchTimes: number[] = []

async function searchSlot(background: boolean): Promise<void> {
  const cap = background ? SEARCH_CAP.background : SEARCH_CAP.foreground
  for (;;) {
    const now = Date.now()
    while (searchTimes.length && now - searchTimes[0] > SEARCH_WINDOW_MS) searchTimes.shift()
    if (searchTimes.length < cap) {
      searchTimes.push(now)
      return
    }
    await sleep(searchTimes[searchTimes.length - cap] + SEARCH_WINDOW_MS - now + 50)
  }
}

/**
 * A read-only GraphQL call. Searches wait for a slot under the per-minute limit. GitHub answers
 * heavy queries with a 502 now and then, and other tools can use up the limit, so both are retried.
 */
export async function graphql<T>(
  query: string,
  variables: Record<string, unknown> = {},
  opts: { background?: boolean } = {}
): Promise<T> {
  const isSearch = /\bsearch\s*\(/.test(query)
  let last: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    if (isSearch) await searchSlot(!!opts.background)
    try {
      const res = await gh('/graphql', { method: 'POST', body: JSON.stringify({ query, variables }) })
      const json = (await res.json()) as { data?: T; errors?: { message: string }[] }
      if (!json.data) throw new Error(`GitHub: ${json.errors?.map((e) => e.message).join('; ') ?? 'empty response'}`)
      return json.data
    } catch (e) {
      last = e
      const message = (e as Error).message
      if (/rate limit/i.test(message)) await sleep(20_000 * (attempt + 1))
      else if (/GitHub 50[234]/.test(message)) await sleep(800 * (attempt + 1))
      else throw e
    }
  }
  throw last
}

const COMMIT_PAGES = 10 // GitHub's search stops at 1000 results

/**
 * The signed-in user's commits on default branches, committed within [from, to]. GitHub's commit
 * search only indexes default branches, so work still sitting on a pull request branch is not here.
 */
export async function searchCommits(from: number, to: number): Promise<{ commits: CommitMade[]; truncated: boolean }> {
  const day = (t: number): string => new Date(t).toISOString().slice(0, 10)
  const q = encodeURIComponent(`author:@me committer-date:${day(from)}..${day(to)}`)
  const commits: CommitMade[] = []
  for (let page = 1; page <= COMMIT_PAGES; page++) {
    let json: {
      total_count: number
      items: { sha: string; html_url: string; repository: { full_name: string }; commit: { message: string; committer: { date: string } | null } }[]
    } | null = null
    for (let attempt = 0; attempt < 3 && !json; attempt++) {
      await searchSlot(true)
      try {
        json = await (await gh(`/search/commits?q=${q}&sort=committer-date&order=desc&per_page=100&page=${page}`)).json()
      } catch (e) {
        if (attempt === 2 || !/rate limit|GitHub 50[234]/i.test((e as Error).message)) throw e
        await sleep(20_000 * (attempt + 1))
      }
    }
    for (const c of json!.items)
      commits.push({
        sha: c.sha,
        repo: c.repository.full_name,
        message: c.commit.message.split('\n')[0].slice(0, 200),
        url: c.html_url,
        committedAt: new Date(c.commit.committer?.date ?? 0).toISOString()
      })
    if (json!.items.length < 100) return { commits, truncated: false }
  }
  return { commits, truncated: true }
}

interface BaseChanges {
  nodes: { createdAt?: string; previousRefName?: string; currentRefName?: string }[]
}

interface GqlPr {
  number: number
  title: string
  body?: string
  url: string
  isDraft: boolean
  updatedAt: string
  createdAt: string
  additions: number
  deletions: number
  changedFiles: number
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  headRefOid: string
  headRefName: string
  baseRefName: string
  repository: { nameWithOwner: string }
  author: { login: string; avatarUrl: string } | null
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] }
  reviewThreads: { nodes: { isResolved: boolean; comments: { nodes: { author: { login: string } | null }[] } }[] }
  latestReviews: { nodes: { author: { login: string } | null; state: string; commit: { oid: string } | null }[] }
  reviewRequests: { nodes: { requestedReviewer: { login?: string; name?: string } | null }[] }
  timelineItems?: BaseChanges
}

function ciOf(pr: GqlPr): CiState {
  const s = pr.commits.nodes[0]?.commit.statusCheckRollup?.state
  if (!s) return 'none'
  if (s === 'SUCCESS') return 'success'
  if (s === 'FAILURE' || s === 'ERROR') return 'failure'
  return 'pending'
}

const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])

/** Merge states GitHub will merge in. UNSTABLE means checks are failing but none of them is required. */
const MERGEABLE_STATES = new Set(['CLEAN', 'HAS_HOOKS', 'UNSTABLE'])

interface CheckContext {
  __typename: string
  name?: string
  status?: string
  conclusion?: string | null
  detailsUrl?: string | null
  checkSuite?: { workflowRun: { workflow: { name: string } } | null } | null
  context?: string
  state?: string
  targetUrl?: string | null
  /** Whether branch protection requires this check before the pull request can merge. */
  isRequired?: boolean
}

function failingChecksOf(contexts: CheckContext[]): FailingCheck[] {
  const out: FailingCheck[] = []
  for (const c of contexts) {
    const required = c.isRequired ?? null
    if (c.__typename === 'CheckRun' && c.conclusion && FAILED_CONCLUSIONS.has(c.conclusion)) {
      const workflow = c.checkSuite?.workflowRun?.workflow.name
      const job = c.detailsUrl?.match(/\/actions\/runs\/(\d+)\/job\/(\d+)/)
      out.push({
        name: workflow && workflow !== c.name ? `${workflow} / ${c.name}` : (c.name ?? 'check'),
        workflow: workflow ?? null,
        url: c.detailsUrl ?? null,
        required,
        jobId: job ? Number(job[2]) : null,
        runId: job ? Number(job[1]) : null
      })
    } else if (c.__typename === 'StatusContext' && (c.state === 'FAILURE' || c.state === 'ERROR')) {
      out.push({ name: c.context ?? 'status', workflow: null, url: c.targetUrl ?? null, required, jobId: null, runId: null })
    }
  }
  // A workflow that runs on both push and pull_request reports each job twice; show it once,
  // keeping the copy branch protection requires.
  const byName = new Map<string, FailingCheck>()
  for (const c of out) {
    const seen = byName.get(c.name)
    if (!seen || (c.required === true && seen.required !== true)) byName.set(c.name, c)
  }
  out.splice(0, out.length, ...byName.values())
  // Required failures first: those are what stands between the pull request and a merge.
  return out.sort((a, b) => Number(b.required === true) - Number(a.required === true))
}

const isRunning = (c: CheckContext): boolean =>
  c.__typename === 'CheckRun' ? c.status !== 'COMPLETED' : c.state === 'PENDING' || c.state === 'EXPECTED'

/** What CI means for one pull request: its overall state, what failed, and whether that stops a merge. */
interface Ci {
  state: CiState
  failing: FailingCheck[]
  /** Some checks have not finished, even though others already failed. */
  running: boolean
  blocks: boolean
}

/** What the second query adds for a pull request whose CI is red. */
interface LoadedChecks {
  mergeState: string
  contexts: CheckContext[]
}

function ciFor(pr: GqlPr, loaded: LoadedChecks | undefined): Ci {
  const state = ciOf(pr)
  const contexts = loaded?.contexts ?? []
  const failing = state === 'failure' ? failingChecksOf(contexts) : []
  // Failing checks only hold a pull request back when one of them is required. Without the
  // per-check answer we go by the merge state, which errs towards calling the failure blocking.
  const blocks =
    state === 'failure' &&
    !MERGEABLE_STATES.has(loaded?.mergeState ?? 'UNKNOWN') &&
    !(failing.length > 0 && failing.every((c) => c.required === false))
  return { state, failing, running: state === 'pending' || contexts.some(isRunning), blocks }
}

const keyOf = (pr: GqlPr): string => `${pr.repository.nameWithOwner}#${pr.number}`

/**
 * The checks and merge state of the pull requests whose CI is red, keyed like PrSummary.key. Asked
 * separately because it is too heavy to request for every PR, and one alias per pull request because
 * GitHub only says whether a check is required when told which pull request it is for.
 */
async function loadChecks(prs: GqlPr[]): Promise<Map<string, LoadedChecks>> {
  const out = new Map<string, LoadedChecks>()
  const chunks: GqlPr[][] = []
  for (let i = 0; i < prs.length; i += 10) chunks.push(prs.slice(i, i + 10))
  await Promise.all(
    chunks.map(async (chunk) => {
      const parts = chunk.map((pr, i) => {
        const [owner, name] = pr.repository.nameWithOwner.split('/')
        return `p${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${pr.number}) {
          headRefOid mergeStateStatus
          commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
            __typename
            ... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber: ${pr.number}) checkSuite { workflowRun { workflow { name } } } }
            ... on StatusContext { context state targetUrl isRequired(pullRequestNumber: ${pr.number}) }
          } } } } } }
        } }`
      })
      try {
        const res = await gh('/graphql', { method: 'POST', body: JSON.stringify({ query: `query { ${parts.join('\n')} }` }) })
        const json = (await res.json()) as {
          data?: Record<
            string,
            { pullRequest: { headRefOid: string; mergeStateStatus: string; commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: CheckContext[] } } | null } }[] } } | null } | null
          >
        }
        chunk.forEach((pr, i) => {
          const found = json.data?.[`p${i}`]?.pullRequest
          // A push between the two queries would make these the checks of a different commit.
          if (found && found.headRefOid === pr.headRefOid)
            out.set(keyOf(pr), {
              mergeState: found.mergeStateStatus,
              contexts: found.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []
            })
        })
      } catch (e) {
        console.error('could not load failing checks:', e) // the row still says CI is failing
      }
    })
  )
  return out
}

const names = (list: string[]): string =>
  list.length <= 2 ? list.join(' and ') : `${list[0]}, ${list[1]} and ${list.length - 2} more`

function classifyMine(pr: GqlPr, viewer: string, { failing, running, blocks }: Ci): Reason[] {
  const reasons: Reason[] = []
  // Failures that are not required do not need the author; the CI line on the row still shows them.
  if (blocks) {
    const required = failing.filter((c) => c.required).length
    const n = required || failing.length
    const kind = required ? 'required check' : 'check'
    reasons.push({
      level: 'action',
      failing: true,
      text: n ? `${n} ${kind}${n === 1 ? ' is' : 's are'} failing` : 'Checks are failing',
      short: n ? `${n} ${required ? 'required ' : ''}failing` : 'Checks failing'
    })
  }
  if (pr.mergeable === 'CONFLICTING') reasons.push({ level: 'action', text: 'Has merge conflicts', short: 'Conflicts' })

  const changes = pr.latestReviews.nodes
    .filter((r) => r.state === 'CHANGES_REQUESTED' && r.author)
    .map((r) => r.author!.login)
  if (pr.reviewDecision === 'CHANGES_REQUESTED' || changes.length)
    reasons.push({
      level: 'action',
      text: changes.length ? `${names(changes)} requested changes` : 'Changes requested',
      short: 'Changes requested'
    })

  const unanswered = pr.reviewThreads.nodes.filter(
    (t) => !t.isResolved && t.comments.nodes[0]?.author?.login !== viewer
  ).length
  if (unanswered)
    reasons.push({
      level: 'action',
      text: `${unanswered} review ${unanswered === 1 ? 'thread is' : 'threads are'} waiting for your reply`,
      short: `${unanswered} to answer`
    })

  if (pr.isDraft) {
    reasons.push({ level: 'waiting', text: 'Still a draft', short: 'Draft' })
    return reasons
  }
  if (reasons.length) return reasons

  if (pr.reviewDecision === 'APPROVED') {
    reasons.push(
      running
        ? { level: 'waiting', text: 'Approved, checks still running', short: 'Checks running' }
        : { level: 'ready', text: 'Approved and ready to merge', short: 'Ready to merge' }
    )
    return reasons
  }
  const reviewers = pr.reviewRequests.nodes
    .map((n) => n.requestedReviewer?.login ?? n.requestedReviewer?.name)
    .filter((x): x is string => !!x)
  const reviewedBy = pr.latestReviews.nodes.filter((r) => r.author && r.author.login !== viewer)
  if (!reviewers.length && !reviewedBy.length)
    reasons.push({ level: 'action', text: 'No reviewer assigned yet', short: 'No reviewer' })
  else if (reviewers.length)
    reasons.push({ level: 'waiting', text: `Waiting on review from ${names(reviewers)}`, short: 'Awaiting review' })
  else if (pr.reviewDecision === null && reviewedBy.some((r) => r.state === 'APPROVED'))
    reasons.push({ level: 'ready', text: 'Approved and ready to merge', short: 'Ready to merge' })
  else reasons.push({ level: 'waiting', text: 'Waiting on reviewers', short: 'Awaiting review' })
  if (running) reasons.push({ level: 'waiting', text: 'Checks are running', short: 'Checks running' })
  return reasons
}

function classifyReview(pr: GqlPr, viewer: string, requested: boolean): Reason[] {
  const mine = pr.latestReviews.nodes.find((r) => r.author?.login === viewer)
  const author = pr.author?.login ?? 'The author'
  if (pr.isDraft) return [{ level: 'waiting', text: 'Still a draft', short: 'Draft' }]
  if (requested)
    return [
      {
        level: 'action',
        text: mine ? `${author} asked you to review again` : `${author} is waiting for your review`,
        short: mine ? 'Review again' : 'Needs your review'
      }
    ]
  if (!mine) return [{ level: 'waiting', text: 'You commented earlier', short: 'You commented' }]
  const moved = mine.commit?.oid && mine.commit.oid !== pr.headRefOid
  if (mine.state === 'APPROVED')
    return [{ level: 'waiting', text: moved ? 'You approved; new commits since' : 'You approved', short: moved ? 'Approved, new commits' : 'You approved' }]
  if (moved) return [{ level: 'action', text: 'New commits since your review', short: 'New commits' }]
  if (mine.state === 'CHANGES_REQUESTED')
    return [{ level: 'waiting', text: `You requested changes; waiting on ${author}`, short: 'You asked for changes' }]
  return [{ level: 'waiting', text: `You reviewed; waiting on ${author}`, short: 'You reviewed' }]
}

const rank: Record<Level, number> = { action: 0, ready: 1, waiting: 2 }

/** Review and merge standing, the same for your own pull requests and other people's. */
function mergeStatus(pr: GqlPr, ci: Ci): Pick<PrSummary, 'approval' | 'approvedBy' | 'changesRequestedBy' | 'merge' | 'mergeBlockers'> {
  const by = (state: string): string[] =>
    pr.latestReviews.nodes.filter((r) => r.state === state && r.author).map((r) => r.author!.login)
  const approvedBy = by('APPROVED')
  const changesRequestedBy = by('CHANGES_REQUESTED')
  const approval: PrSummary['approval'] =
    pr.reviewDecision === 'CHANGES_REQUESTED' || changesRequestedBy.length
      ? 'changes_requested'
      : pr.reviewDecision === 'APPROVED' || (pr.reviewDecision === null && approvedBy.length)
        ? 'approved'
        : pr.reviewDecision === 'REVIEW_REQUIRED'
          ? 'review_required'
          : 'none'

  const mergeBlockers: string[] = []
  if (pr.isDraft) mergeBlockers.push('still a draft')
  if (pr.mergeable === 'CONFLICTING') mergeBlockers.push('merge conflicts')
  if (approval === 'changes_requested') mergeBlockers.push('changes requested')
  if (ci.blocks) {
    const required = ci.failing.filter((c) => c.required).length
    mergeBlockers.push(required ? `${required} required ${required === 1 ? 'check' : 'checks'} failing` : 'checks failing')
  }
  const merge: PrSummary['merge'] = mergeBlockers.length
    ? 'blocked'
    : approval !== 'approved'
      ? 'unapproved'
      : ci.running
        ? 'pending'
        : 'mergeable'
  return { approval, approvedBy, changesRequestedBy, merge, mergeBlockers }
}

/**
 * Whether the description carries a visual of the change. An uploaded video is a bare attachment
 * link on its own; an uploaded image is the same link inside markdown or an <img>.
 */
function previewOf(body: string | undefined): PrSummary['preview'] {
  if (!body) return undefined
  if (
    /<video\b|\.(mp4|mov|webm)\b|loom\.com\/share|(^|[\s>])https:\/\/github\.com\/user-attachments\/assets\/[\w-]+/im.test(body)
  )
    return 'video'
  if (/!\[[^\]]*\]\(|<img\b/i.test(body)) return 'image'
  return undefined
}

const MY_REVIEW = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', COMMENTED: 'commented', DISMISSED: 'commented' } as const

function toSummary(pr: GqlPr, role: Role, reasons: Reason[], ci: Ci, viewer: string): PrSummary {
  const mine = pr.latestReviews.nodes.find((r) => r.author?.login === viewer)
  const level = reasons.reduce<Level>((best, r) => (rank[r.level] < rank[best] ? r.level : best), 'waiting')
  return {
    key: keyOf(pr),
    repo: pr.repository.nameWithOwner,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author ?? { login: 'ghost', avatarUrl: '' },
    isDraft: pr.isDraft,
    updatedAt: pr.updatedAt,
    createdAt: pr.createdAt,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    headSha: pr.headRefOid,
    baseRef: pr.baseRefName,
    headRef: pr.headRefName,
    role,
    ci: ci.state,
    failingChecks: ci.failing,
    ciBlocksMerge: ci.blocks,
    ...mergeStatus(pr, ci),
    preview: previewOf(pr.body),
    myReview: mine ? MY_REVIEW[mine.state as keyof typeof MY_REVIEW] : undefined,
    level,
    reasons,
    draftState: 'none'
  }
}

export async function listPrs(): Promise<{ viewer: string; prs: PrSummary[] }> {
  type Result = { viewer: { login: string }; search: { nodes: GqlPr[] } }
  const results = await Promise.all(Object.values(SEARCHES).map((q) => graphql<Result>(LIST_QUERY, { q })))
  const [mine, requested, reviewed] = results.map((r) => r.search)
  const me = results[0].viewer.login
  // search can return empty nodes for inaccessible items
  const real = (list: GqlPr[]): GqlPr[] => list.filter((pr) => pr?.repository)
  const groups = { mine: real(mine.nodes), requested: real(requested.nodes), reviewed: real(reviewed.nodes) }
  const red = new Map<string, GqlPr>()
  for (const pr of [...groups.mine, ...groups.requested, ...groups.reviewed])
    if (ciOf(pr) === 'failure') red.set(keyOf(pr), pr)
  const checks = await loadChecks([...red.values()])

  const prs: PrSummary[] = []
  const seen = new Set<string>()
  const add = (pr: GqlPr, role: Role, reasons: (ci: Ci) => Reason[]): void => {
    if (seen.has(keyOf(pr))) return
    seen.add(keyOf(pr))
    const ci = ciFor(pr, checks.get(keyOf(pr)))
    prs.push(toSummary(pr, role, reasons(ci), ci, me))
  }
  for (const pr of groups.mine) add(pr, 'mine', (ci) => classifyMine(pr, me, ci))
  for (const pr of groups.requested) add(pr, 'review', () => classifyReview(pr, me, true))
  for (const pr of groups.reviewed) add(pr, 'review', () => classifyReview(pr, me, false))
  prs.sort((a, b) => rank[a.level] - rank[b.level] || b.updatedAt.localeCompare(a.updatedAt))
  try {
    await attachMergedBelow(prs, [...groups.mine, ...groups.requested, ...groups.reviewed])
  } catch (e) {
    console.error('could not look up the merged parts of stacks:', e) // the list is still right without them
  }
  return { viewer: me, prs }
}

// ---------- Merged parts of stacks ----------

const MERGED_FIELDS = `number title url createdAt mergedAt additions deletions headRefName baseRefName ${BASE_CHANGES}`
const MAX_STACK_DEPTH = 10
const MISS_TTL_MS = 15 * 60_000

interface GqlMerged {
  number: number
  title: string
  url: string
  createdAt: string
  mergedAt: string | null
  additions: number
  deletions: number
  headRefName: string
  baseRefName: string
  timelineItems?: BaseChanges
}

/** The branch this pull request sat on before GitHub moved it, and when that happened. */
function previousBase(pr: { createdAt: string; baseRefName: string; timelineItems?: BaseChanges }) {
  const moves = (pr.timelineItems?.nodes ?? []).filter((n) => n.previousRefName && n.currentRefName && n.createdAt)
  // Walk back from the newest move to the one that put it on its current base.
  const last = [...moves].reverse().find((n) => n.currentRefName === pr.baseRefName)
  return last ? { ref: last.previousRefName!, onto: last.currentRefName!, at: last.createdAt!, since: pr.createdAt } : null
}

// Merged pull requests never change, so a hit is kept for good; a miss is asked again later.
const mergedCache = new Map<string, { pr: GqlMerged | null; at: number }>()

/**
 * Look up, in one request, the merged pull request each branch came from. It must have merged into
 * the branch the child was moved onto, after the child was opened and before (or as) it was moved.
 */
async function findMerged(
  asks: { repo: string; ref: string; onto: string; at: string; since: string }[]
): Promise<(GqlMerged | null)[]> {
  const cacheKey = (a: (typeof asks)[number]): string => `${a.repo}:${a.ref}:${a.onto}:${a.at}`
  const todo = asks.filter((a) => {
    const hit = mergedCache.get(cacheKey(a))
    return !hit || (!hit.pr && Date.now() - hit.at > MISS_TTL_MS)
  })
  if (todo.length) {
    const vars: Record<string, string> = {}
    const parts = todo.map((a, i) => {
      const [owner, name] = a.repo.split('/')
      Object.assign(vars, { [`o${i}`]: owner, [`n${i}`]: name, [`h${i}`]: a.ref, [`b${i}`]: a.onto })
      return `r${i}: repository(owner: $o${i}, name: $n${i}) {
        pullRequests(headRefName: $h${i}, baseRefName: $b${i}, states: MERGED, first: 5, orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes { ${MERGED_FIELDS} }
        }
      }`
    })
    const decl = todo.map((_, i) => `$o${i}: String!, $n${i}: String!, $h${i}: String!, $b${i}: String!`).join(', ')
    const data = await graphql<Record<string, { pullRequests: { nodes: GqlMerged[] } } | null>>(
      `query(${decl}) { ${parts.join('\n')} }`,
      vars
    )
    todo.forEach((a, i) => {
      const atMs = new Date(a.at).getTime() + 60_000
      const pr =
        (data[`r${i}`]?.pullRequests.nodes ?? [])
          .filter((m) => m.mergedAt && m.mergedAt >= a.since && new Date(m.mergedAt).getTime() <= atMs)
          .sort((x, y) => y.mergedAt!.localeCompare(x.mergedAt!))[0] ?? null
      mergedCache.set(cacheKey(a), { pr, at: Date.now() })
    })
  }
  return asks.map((a) => mergedCache.get(cacheKey(a))?.pr ?? null)
}

/**
 * For the bottom pull request of each stack, the parts below it that have already merged, oldest
 * first. A pull request that was never moved onto another base gets none, so only stacks show them.
 */
async function attachMergedBelow(prs: PrSummary[], raw: GqlPr[]): Promise<void> {
  const rawByKey = new Map(raw.map((r) => [keyOf(r), r]))
  const openHeads = new Set(prs.map((p) => `${p.repo}:${p.headRef}`))
  type Chain = { pr: PrSummary; merged: GqlMerged[]; next: ReturnType<typeof previousBase>; seen: Set<string> }
  let chains: Chain[] = prs
    .filter((p) => !openHeads.has(`${p.repo}:${p.baseRef}`)) // the bottom of its stack, or on its own
    .map((p) => {
      const r = rawByKey.get(p.key)
      return { pr: p, merged: [], next: r ? previousBase(r) : null, seen: new Set([p.headRef]) }
    })
    .filter((c) => c.next && !openHeads.has(`${c.pr.repo}:${c.next.ref}`))
  for (let depth = 0; depth < MAX_STACK_DEPTH && chains.length; depth++) {
    const found = await findMerged(chains.map((c) => ({ repo: c.pr.repo, ...c.next! })))
    const going: Chain[] = []
    chains.forEach((c, i) => {
      const m = found[i]
      if (!m || c.seen.has(m.headRefName)) return
      c.seen.add(m.headRefName)
      c.merged.unshift(m)
      c.pr.mergedBelow = c.merged.map((x) => ({
        key: `${c.pr.repo}#${x.number}`,
        number: x.number,
        title: x.title,
        url: x.url,
        mergedAt: x.mergedAt!,
        additions: x.additions,
        deletions: x.deletions,
        baseRef: x.baseRefName,
        headRef: x.headRefName
      }))
      c.next = previousBase(m)
      if (c.next) going.push(c)
    })
    chains = going
  }
}

const OPEN_QUERY = `
query($q: String!, $after: String) {
  viewer { login }
  search(query: $q, type: ISSUE, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
}`
const OPEN_PAGES = 3

/**
 * Every open pull request by other people in the given repositories, whether or not it involves you.
 * Capped at OPEN_PAGES pages of the most recently updated; `truncated` says when there were more.
 */
export async function listOpenPrs(repos: string[]): Promise<{ prs: PrSummary[]; truncated: boolean }> {
  const valid = [...new Set(repos)].filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r)).slice(0, 10)
  if (!valid.length) return { prs: [], truncated: false }
  const q = `is:pr is:open -author:@me archived:false sort:updated-desc ${valid.map((r) => `repo:${r}`).join(' ')}`
  type Page = {
    viewer: { login: string }
    search: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GqlPr[] }
  }
  const nodes: GqlPr[] = []
  let after: string | null = null
  let me = ''
  let truncated = false
  for (let page = 0; page < OPEN_PAGES; page++) {
    const data: Page = await graphql<Page>(OPEN_QUERY, { q, after })
    me = data.viewer.login
    nodes.push(...data.search.nodes.filter((pr) => pr?.repository))
    after = data.search.pageInfo.endCursor
    truncated = data.search.pageInfo.hasNextPage
    if (!truncated) break
  }
  const checks = await loadChecks(nodes.filter((pr) => ciOf(pr) === 'failure'))
  const prs = nodes.map((pr) => {
    const ci = ciFor(pr, checks.get(keyOf(pr)))
    const asked = pr.reviewRequests.nodes.some((n) => n.requestedReviewer?.login === me)
    const reviewed = pr.latestReviews.nodes.some((r) => r.author?.login === me)
    const reasons: Reason[] =
      asked || reviewed
        ? classifyReview(pr, me, asked)
        : [{ level: 'waiting', text: pr.isDraft ? 'Still a draft' : 'Not waiting on you', short: pr.isDraft ? 'Draft' : 'Not on you' }]
    return toSummary(pr, 'review', reasons, ci, me)
  })
  return { prs, truncated }
}

const MAX_FILE_PAGES = 5
const MAX_COMMENT_PAGES = 5

export async function prDetail(repo: string, number: number): Promise<PrDetail> {
  const base = `/repos/${repo}/pulls/${number}`
  // The "full" media type adds body_html, where attachments carry links this app is allowed to load.
  const prRes = await gh(base, { accept: 'application/vnd.github.full+json' })
  const pr = (await prRes.json()) as { body: string | null; body_html?: string | null; head: { sha: string }; changed_files: number }
  const files: PrFile[] = []
  for (let page = 1; page <= MAX_FILE_PAGES; page++) {
    const batch = (await (await gh(`${base}/files?per_page=100&page=${page}`)).json()) as {
      filename: string
      previous_filename?: string
      status: string
      additions: number
      deletions: number
      patch?: string
    }[]
    for (const f of batch)
      files.push({
        path: f.filename,
        previousPath: f.previous_filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch
      })
    if (batch.length < 100) break
  }
  const comments: ExistingComment[] = []
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const batch = (await (await gh(`${base}/comments?per_page=100&page=${page}`)).json()) as {
      id: number
      path: string
      line: number | null
      original_line: number | null
      side: 'LEFT' | 'RIGHT' | null
      user: { login: string; avatar_url: string } | null
      body: string
      created_at: string
      html_url: string
      in_reply_to_id?: number
    }[]
    for (const c of batch)
      comments.push({
        replyTo: c.in_reply_to_id ?? null,
        thread: '',
        resolved: null,
        resolvedBy: null,
        id: c.id,
        path: c.path,
        line: c.line,
        side: c.side ?? 'RIGHT',
        originalLine: c.original_line,
        author: c.user?.login ?? 'ghost',
        avatarUrl: c.user?.avatar_url ?? '',
        body: c.body,
        createdAt: c.created_at,
        url: c.html_url
      })
    if (batch.length < 100) break
  }
  // Resolution lives only in GraphQL. Without it the comments still show, just without the label.
  const threads = await reviewThreads(repo, number).catch((e) => {
    console.error('could not load review threads:', e)
    return new Map<number, ThreadInfo>()
  })
  const byId = new Map(comments.map((c) => [c.id, c]))
  for (const c of comments) {
    let root = c
    for (let hops = 0; root.replyTo !== null && byId.has(root.replyTo) && hops < 100; hops++) root = byId.get(root.replyTo)!
    const info = threads.get(c.id) ?? threads.get(root.id)
    c.thread = info?.id ?? `c${root.id}`
    c.resolved = info ? info.resolved : null
    c.resolvedBy = info?.resolvedBy ?? null
  }
  return {
    body: pr.body ?? '',
    bodyHtml: pr.body_html ?? '',
    headSha: pr.head.sha,
    files,
    comments,
    truncated: files.length < pr.changed_files
  }
}

const LOG_CONTEXT_LINES = 60
const LOG_LINE_LIMIT = 400

/** The lines leading up to the first error in an Actions job log, which is where the cause usually is. */
export function logExcerpt(log: string): string {
  const lines = log
    .split('\n')
    .map((l) => l.replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\x1b\[[0-9;*]*m/g, '').trimEnd())
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  const err = lines.findIndex((l) => l.startsWith('##[error]'))
  let start: number
  let end: number
  if (err === -1) {
    end = lines.length - 1
    start = Math.max(0, end - 40)
  } else {
    // Walk back to where the failing step's own output starts, skipping the setup noise before it.
    start = err
    while (start > 0 && err - start < LOG_CONTEXT_LINES && !/^##\[(group|endgroup)\]/.test(lines[start - 1])) start--
    end = err
    while (lines[end + 1]?.startsWith('##[error]')) end++
  }
  return lines
    .slice(start, end + 1)
    .map((l) => l.replace(/^##\[error\]/, 'Error: ').replace(/^##\[warning\]/, 'Warning: '))
    .map((l) => (l.length > LOG_LINE_LIMIT ? `${l.slice(0, LOG_LINE_LIMIT)}…` : l))
    .join('\n')
}

interface ThreadInfo {
  id: string
  resolved: boolean
  resolvedBy: string | null
}

const THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved resolvedBy { login } comments(first: 100) { nodes { databaseId } } }
      }
    }
  }
}`

/** Each review comment's thread and whether that thread is resolved, keyed by the comment's REST id. */
async function reviewThreads(repo: string, number: number): Promise<Map<number, ThreadInfo>> {
  const [owner, name] = repo.split('/')
  type Page = {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null }
          nodes: { id: string; isResolved: boolean; resolvedBy: { login: string } | null; comments: { nodes: { databaseId: number | null }[] } }[]
        }
      } | null
    } | null
  }
  const out = new Map<number, ThreadInfo>()
  let after: string | null = null
  for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
    const data: Page = await graphql<Page>(THREADS_QUERY, { owner, name, number, after })
    const threads = data.repository?.pullRequest?.reviewThreads
    if (!threads) break
    for (const t of threads.nodes) {
      const info = { id: t.id, resolved: t.isResolved, resolvedBy: t.resolvedBy?.login ?? null }
      for (const c of t.comments.nodes) if (c.databaseId !== null) out.set(c.databaseId, info)
    }
    if (!threads.pageInfo.hasNextPage) break
    after = threads.pageInfo.endCursor
  }
  return out
}

/** Why a failed GitHub Actions job failed: the step that broke and the log around its first error. */
export async function checkLog(repo: string, jobId: number): Promise<CheckLog> {
  const base = `/repos/${repo}/actions/jobs/${jobId}`
  const [job, log] = await Promise.allSettled([
    gh(base).then((r) => r.json() as Promise<{ conclusion: string | null; steps?: { name: string; conclusion: string | null }[] }>),
    gh(`${base}/logs`).then((r) => r.text())
  ])
  if (job.status === 'rejected' && log.status === 'rejected') throw log.reason
  const steps = job.status === 'fulfilled' ? (job.value.steps ?? []) : []
  return {
    step: steps.find((s) => s.conclusion && FAILED_CONCLUSIONS.has(s.conclusion.toUpperCase()))?.name ?? null,
    excerpt: log.status === 'fulfilled' ? logExcerpt(log.value) : '',
    logError:
      log.status === 'fulfilled'
        ? undefined
        : job.status === 'fulfilled' && !steps.length
          ? `the job ${job.value.conclusion === 'cancelled' ? 'was cancelled' : 'ended'} before it ran any steps`
          : (log.reason as Error).message
  }
}

const rerunError = (e: unknown): Error => {
  const msg = (e as Error).message
  if (/already running/i.test(msg)) return new Error('That workflow run is already running again. Wait for it to finish.')
  if (/GitHub 40[34]: (Resource not accessible|Must have admin rights|Not Found)/i.test(msg))
    return new Error(`You do not have permission to re-run workflows in this repository. (${msg})`)
  return e as Error
}

/** Re-run one failed GitHub Actions job (and the jobs that depend on it). */
export async function rerunJob(repo: string, jobId: number): Promise<void> {
  try {
    await gh(`/repos/${repo}/actions/jobs/${jobId}/rerun`, { method: 'POST' })
  } catch (e) {
    throw rerunError(e)
  }
}

/** Re-run every failed job in these GitHub Actions workflow runs. */
export async function rerunFailedJobs(repo: string, runIds: number[]): Promise<void> {
  const results = await Promise.allSettled(
    [...new Set(runIds)].map((id) => gh(`/repos/${repo}/actions/runs/${id}/rerun-failed-jobs`, { method: 'POST' }))
  )
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed.length) throw rerunError(failed[0].reason)
}

const MAX_VOICE_SAMPLES = 120
const VOICE_SAMPLE_CHARS = 500

/**
 * Review comments and summaries the signed-in user wrote on other people's pull requests, newest
 * first, with code removed: the raw material for learning how they write.
 */
export async function myReviewComments(): Promise<string[]> {
  const query = `
  query {
    viewer { login }
    search(query: "is:pr reviewed-by:@me -author:@me sort:updated-desc", type: ISSUE, first: 30) {
      nodes { ... on PullRequest {
        reviews(last: 30) { nodes { author { login } body comments(first: 20) { nodes { body } } } }
      } }
    }
  }`
  const res = await gh('/graphql', { method: 'POST', body: JSON.stringify({ query }) })
  const json = (await res.json()) as {
    data?: {
      viewer: { login: string }
      search: {
        nodes: ({ reviews?: { nodes: { author: { login: string } | null; body: string; comments: { nodes: { body: string }[] } }[] } } | null)[]
      }
    }
    errors?: { message: string }[]
  }
  if (!json.data) throw new Error(`GitHub: ${json.errors?.map((e) => e.message).join('; ') ?? 'empty response'}`)
  const me = json.data.viewer.login
  const seen = new Set<string>()
  const out: string[] = []
  for (const pr of json.data.search.nodes)
    for (const review of [...(pr?.reviews?.nodes ?? [])].reverse()) {
      if (review.author?.login !== me) continue
      for (const body of [review.body, ...review.comments.nodes.map((c) => c.body)]) {
        // Code says nothing about voice, and quoted lines are someone else's words.
        const text = body
          .replace(/```[\s\S]*?```/g, '')
          .replace(/^>.*$/gm, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
        if (text.length < 4 || seen.has(text)) continue
        seen.add(text)
        out.push(text.slice(0, VOICE_SAMPLE_CHARS))
        if (out.length >= MAX_VOICE_SAMPLES) return out
      }
    }
  return out
}

export async function prDiff(repo: string, number: number): Promise<string> {
  const res = await gh(`/repos/${repo}/pulls/${number}`, { accept: 'application/vnd.github.v3.diff' })
  return res.text()
}

export async function postReview(req: PostRequest): Promise<{ url: string }> {
  const event = { comment: 'COMMENT', approve: 'APPROVE', request_changes: 'REQUEST_CHANGES' }[req.verdict]
  const res = await gh(`/repos/${req.repo}/pulls/${req.number}/reviews`, {
    method: 'POST',
    body: JSON.stringify({
      commit_id: req.headSha,
      body: req.body,
      event,
      comments: req.comments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body }))
    })
  })
  const json = (await res.json()) as { html_url: string }
  return { url: json.html_url }
}
