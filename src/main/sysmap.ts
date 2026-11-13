import { ipcMain, Notification, type BrowserWindow } from 'electron'
import type { ChildProcess } from 'node:child_process'
import { readStore, writeStore } from './persist'
import { runClaude } from './review'
import { getSettings, reviewDefaults } from './settings'
import { run as exec } from './env'
import { listAccounts } from './accounts'
import { gh } from './github'
import { branchCheckout, commitRange, dropBranchCheckout, remoteBranches, remoteHead, validBranch } from './repo'
import { registerMapChat } from './sysmapChat'
import {
  applyPatch,
  assemble,
  bareComponent,
  bareFeature,
  componentsOf,
  componentsPrompt,
  COMPONENTS_SCHEMA,
  featuresOf,
  featuresPrompt,
  FEATURES_SCHEMA,
  filesUnder,
  layoutOf,
  surveyOf,
  surveyPrompt,
  SURVEY_SCHEMA,
  updatePrompt,
  UPDATE_SCHEMA,
  type FeatureOutline,
  type Outline,
  type StudiedComponent,
  type StudiedFeature
} from './sysmapCore'
import { mapId, type MapBranches, type MapFreshness, type MapProgress, type MapSummary, type MapUpdate, type SystemMap } from '../shared/sysmap'

/**
 * System maps: one per repository and branch, drawn by Claude from a checkout of the branch.
 *
 * The first scan is done in passes. One finds the parts (components and features); the next study
 * a few components each, in depth; the last trace how each feature runs through the components.
 * After that the map remembers the commit it describes, and an update reads only the commits
 * since then and changes what they change, so a branch is never scanned from nothing twice.
 */

// ---------- Saved maps ----------
// A map takes minutes of Claude's work to draw, so it is kept like the user's other work: see persist.ts.
// Entries are only ever read or replaced one at a time; one that cannot be read is left as it is.

let store: Record<string, unknown> | null = null
const all = (): Record<string, unknown> => (store ??= readStore<Record<string, unknown>>('sysmaps.json', {}))
const persist = (): void => writeStore('sysmaps.json', store)

/** Fills in whatever a map saved by an older version lacks. */
function readable(raw: unknown): SystemMap | null {
  const m = raw as Partial<SystemMap> | null
  if (!m || typeof m !== 'object' || typeof m.account !== 'string' || typeof m.repo !== 'string' || typeof m.branch !== 'string' || !Array.isArray(m.nodes))
    return null
  return {
    id: mapId(m.account, m.repo, m.branch),
    repo: m.repo,
    branch: m.branch,
    account: m.account,
    headSha: m.headSha ?? '',
    createdAt: m.createdAt ?? m.updatedAt ?? new Date().toISOString(),
    updatedAt: m.updatedAt ?? m.createdAt ?? new Date().toISOString(),
    title: m.title ?? '',
    summary: m.summary ?? '',
    stack: m.stack ?? [],
    // Maps drawn before components listed what is inside them have none to show.
    nodes: m.nodes.map((n) => ({ ...n, contents: n.contents ?? [] })),
    edges: m.edges ?? [],
    features: m.features ?? [],
    history: m.history ?? [],
    model: m.model
  }
}

const getMap = (id: string): SystemMap | null => readable(all()[id])

function saveMap(map: SystemMap): void {
  all()[map.id] = map
  persist()
}

const summaryOf = (m: SystemMap): MapSummary => ({
  id: m.id,
  repo: m.repo,
  branch: m.branch,
  account: m.account,
  headSha: m.headSha,
  updatedAt: m.updatedAt,
  title: m.title,
  nodes: m.nodes.length,
  features: m.features.length
})

const listMaps = (account: string): MapSummary[] =>
  Object.values(all())
    .map(readable)
    .filter((m): m is SystemMap => !!m && m.account === account)
    .map(summaryOf)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

// ---------- Running Claude ----------

type Entry = { child?: ChildProcess; cancelled: boolean }
interface Run {
  progress: MapProgress
  cancelled: boolean
  /** One per Claude process; several run side by side while parts are studied. */
  entries: Set<Entry>
}

const running = new Map<string, Run>()
// One scan at a time; within a scan a few passes run side by side.
let queue: Promise<void> = Promise.resolve()
let emit: (p: MapProgress) => void = () => {}

// How many parts one Claude run studies. Fewer runs cost less; fewer parts per run get a closer look.
const BATCH = { brief: 8, normal: 5, detailed: 3 } as const
// How many Claude runs work at once. More finish a scan sooner; too many run into the account's rate limits.
const SIDE_BY_SIDE = 5
const MAX_HISTORY = 200

function set(run: Run, patch: Partial<MapProgress>): void {
  run.progress = { ...run.progress, ...patch }
  emit(run.progress)
}

const check = (run: Run): void => {
  if (run.cancelled) throw new Error('cancelled')
}

async function ask(run: Run, dir: string, prompt: string, schema: object): Promise<Record<string, unknown>> {
  check(run)
  const entry: Entry = { cancelled: false }
  run.entries.add(entry)
  const { model, effort } = getSettings().map
  try {
    return await runClaude<Record<string, unknown>>(
      prompt,
      dir,
      'Read,Grep,Glob',
      schema,
      entry,
      (s) => set(run, { step: s === 'Writing up findings' ? 'Writing it up' : s }),
      { model, effort }
    )
  } finally {
    run.entries.delete(entry)
  }
}

/** Asks again once when a pass fails for a reason other than the user stopping it. */
async function askTwice(run: Run, dir: string, prompt: string, schema: object): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await ask(run, dir, prompt, schema)
    } catch (e) {
      if (run.cancelled) throw e
      console.error(`a system map pass failed (attempt ${attempt + 1}):`, e)
      // Several runs at once can hit the account's rate limit; a short wait lets it clear.
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 15_000))
    }
  }
  return null
}

/** Runs `work` over the items, a few at a time, keeping the order of the results. */
async function sideBySide<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      results[i] = await work(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(SIDE_BY_SIDE, items.length) }, worker))
  return results
}

function batches<T>(items: T[]): T[][] {
  const size = BATCH[getSettings().map.verbosity]
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

// ---------- A full scan ----------

interface Checkout {
  dir: string
  head: string
}

/** Every tracked file of the checkout, so each pass can be told where its parts live instead of searching. */
async function trackedFiles(dir: string): Promise<string[]> {
  try {
    return (await exec('git', ['ls-files'], { cwd: dir, timeoutMs: 60_000 })).split('\n').filter(Boolean)
  } catch (e) {
    console.error('could not list the files of the checkout:', e)
    return []
  }
}

interface Studied {
  components: StudiedComponent[]
  features: StudiedFeature[]
  discovered: Outline[]
}

async function scan(run: Run, checkout: Checkout, previous: SystemMap | null): Promise<SystemMap> {
  const { account, repo, branch } = run.progress
  const { dir, head } = checkout
  const files = await trackedFiles(dir)

  set(run, { phase: 'survey', step: 'Claude is exploring the codebase', done: 0, total: 0 })
  const survey = surveyOf(await ask(run, dir, surveyPrompt(repo, branch, layoutOf(files)), SURVEY_SCHEMA))
  if (!survey.components.length) throw new Error('Claude did not find anything to map on this branch.')

  // Both halves at once: features are traced through the components the survey found, so they
  // need not wait for those to be studied. That roughly halves the time a scan takes.
  const unstudied: string[] = []
  const step = (n: number): void => set(run, { done: run.progress.done + n })
  const studyComponents = (known: Outline[], batch: Outline[]) => async (): Promise<Studied> => {
    const under = filesUnder(files, batch.flatMap((o) => o.paths))
    const raw = await askTwice(run, dir, componentsPrompt(repo, branch, survey, known, batch, under), COMPONENTS_SCHEMA)
    const result = raw ? componentsOf(raw, batch) : { studied: batch.map(bareComponent), discovered: [], missed: batch }
    unstudied.push(...result.missed.map((o) => o.name))
    step(batch.length)
    return { components: result.studied, features: [], discovered: result.discovered }
  }
  const traceFeatures = (batch: FeatureOutline[]) => async (): Promise<Studied> => {
    const under = filesUnder(files, batch.flatMap((o) => o.paths))
    const raw = await askTwice(run, dir, featuresPrompt(repo, branch, survey, survey.components, batch, under), FEATURES_SCHEMA)
    const result = raw ? featuresOf(raw, batch) : { studied: batch.map(bareFeature), missed: batch }
    unstudied.push(...result.missed.map((o) => o.name))
    step(batch.length)
    return { components: [], features: result.studied, discovered: [] }
  }
  set(run, { phase: 'study', step: 'Studying each component and tracing each feature', done: 0, total: survey.components.length + survey.features.length })
  const passes = await sideBySide(
    [...batches(survey.components).map((b) => studyComponents(survey.components, b)), ...batches<FeatureOutline>(survey.features).map(traceFeatures)],
    (pass) => pass()
  )
  let components = passes.flatMap((p) => p.components)
  const features = passes.flatMap((p) => p.features)

  // Parts the survey missed and a closer look turned up get the same study, once. A quick scan stops at what the survey found.
  const have = new Set(components.map((c) => c.id))
  const names = new Set(components.map((c) => c.name.toLowerCase()))
  const extra = passes
    .flatMap((p) => p.discovered)
    .filter((d, i, list) => !have.has(d.id) && !names.has(d.name.toLowerCase()) && list.findIndex((o) => o.id === d.id) === i)
    .slice(0, getSettings().map.verbosity === 'brief' ? 0 : 15)
  if (extra.length) {
    const known = [...survey.components, ...extra]
    set(run, { step: `Studying ${plural(extra.length, 'part')} found along the way`, total: run.progress.total + extra.length })
    components = [...components, ...(await sideBySide(batches(extra).map((b) => studyComponents(known, b)), (pass) => pass())).flatMap((p) => p.components)]
  }
  check(run)

  const now = new Date().toISOString()
  const drawn = assemble(components, features, head)
  const entry: MapUpdate = {
    at: now,
    kind: 'scan',
    from: '',
    to: head,
    commits: [],
    commitCount: 0,
    notes:
      `Mapped ${plural(drawn.nodes.length, 'component')} and ${plural(drawn.features.length, 'feature')} from the whole branch.` +
      (unstudied.length ? ` Could not be studied in depth, so only outlined: ${unstudied.join(', ')}.` : ''),
    added: [],
    changed: [],
    removed: []
  }
  return {
    id: mapId(account, repo, branch),
    repo,
    branch,
    account,
    headSha: head,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    title: survey.title || repo.split('/')[1],
    summary: survey.summary,
    stack: survey.stack,
    ...drawn,
    history: [entry, ...(previous?.history ?? [])].slice(0, MAX_HISTORY),
    model: getSettings().map.model || undefined
  }
}

// ---------- An update from new commits ----------

/** Null when the map already describes the branch as it is. */
async function update(run: Run, checkout: Checkout, map: SystemMap): Promise<SystemMap | null> {
  const { dir, head } = checkout
  if (head === map.headSha) return null

  set(run, { phase: 'update', step: 'Reading the new commits', done: 0, total: 0 })
  const range = await commitRange(map.repo, map.account, map.headSha, head)
  if (!range) {
    // The commit the map was drawn from is gone, so there is nothing to compare with.
    const fresh = await scan(run, checkout, map)
    fresh.history[0].notes = `The commit this map described is no longer in the repository (the branch was rewritten), so the whole branch was scanned again. ${fresh.history[0].notes}`
    return fresh
  }

  const now = new Date().toISOString()
  const entry: MapUpdate = {
    at: now,
    kind: 'update',
    from: map.headSha,
    to: head,
    commits: range.commits.slice(0, 40),
    commitCount: range.total,
    notes: '',
    added: [],
    changed: [],
    removed: []
  }
  const history = (e: MapUpdate): MapUpdate[] => [e, ...map.history].slice(0, MAX_HISTORY)
  if (!range.files.trim())
    return { ...map, headSha: head, updatedAt: now, history: history({ ...entry, notes: 'The new commits changed no files.' }) }

  set(run, { step: `Claude is reading ${plural(range.total, 'new commit')}` })
  const patch = applyPatch(map, await ask(run, dir, updatePrompt(map, range, head), UPDATE_SCHEMA), head)
  check(run)
  const touched = patch.added.length + patch.changed.length + patch.removed.length
  return {
    ...map,
    ...patch.fields,
    headSha: head,
    updatedAt: now,
    history: history({
      ...entry,
      notes: patch.notes || (touched ? '' : 'The new commits did not change the map.'),
      added: patch.added,
      changed: patch.changed,
      removed: patch.removed
    }),
    model: getSettings().map.model || map.model
  }
}

// ---------- Starting, stopping, reporting ----------

function describeOutcome(map: SystemMap): string {
  const last = map.history[0]
  if (!last || last.kind === 'scan') return `Mapped ${plural(map.nodes.length, 'component')} and ${plural(map.features.length, 'feature')}`
  const parts = [
    last.added.length && `${last.added.length} added`,
    last.changed.length && `${last.changed.length} changed`,
    last.removed.length && `${last.removed.length} removed`
  ].filter(Boolean)
  return parts.length ? `Updated from ${plural(last.commitCount, 'commit')}: ${parts.join(', ')}` : `${plural(last.commitCount, 'new commit')}, no change to the map`
}

function startScan(account: string, repo: string, branch: string, mode: 'scan' | 'update', getWindow: () => BrowserWindow | null): void {
  const id = mapId(account, repo, branch)
  if (running.has(id)) return
  const chosen = getSettings().map
  const defaults = reviewDefaults()
  const run: Run = {
    cancelled: false,
    entries: new Set(),
    progress: {
      id,
      repo,
      branch,
      account,
      mode: mode === 'update' && getMap(id) ? 'update' : 'scan',
      state: 'running',
      phase: 'prepare',
      step: running.size ? 'Waiting for another scan to finish' : 'Getting ready',
      done: 0,
      total: 0,
      model: chosen.model || defaults.model,
      effort: chosen.effort || defaults.effort,
      startedAt: new Date().toISOString()
    }
  }
  running.set(id, run)
  emit(run.progress)

  queue = queue.then(async () => {
    let checkout: Awaited<ReturnType<typeof branchCheckout>> | null = null
    try {
      check(run)
      set(run, { step: 'Fetching the branch', startedAt: new Date().toISOString() })
      checkout = await branchCheckout(repo, branch, account, (s) => set(run, { step: s }))
      check(run)
      // Read now, not when the scan was asked for: another scan of this branch may have finished since.
      const existing = getMap(id)
      const map = run.progress.mode === 'update' && existing ? await update(run, checkout, existing) : await scan(run, checkout, existing)
      check(run)
      if (map) saveMap(map)
      run.progress = { ...run.progress, state: 'done', step: map ? describeOutcome(map) : 'Already up to date', done: 0, total: 0 }
    } catch (e) {
      run.progress = run.cancelled
        ? { ...run.progress, state: 'cancelled', step: 'Scan stopped' }
        : { ...run.progress, state: 'error', step: 'The scan did not finish', error: (e as Error).message }
    } finally {
      checkout?.done()
      running.delete(id)
      emit(run.progress)
      // In front, the window says so itself; behind, macOS does.
      const win = getWindow()
      if (!run.cancelled && (!win || !win.isFocused()) && Notification.isSupported()) {
        const failed = run.progress.state === 'error'
        const note = new Notification({
          title: failed ? 'System map did not finish' : 'System map ready',
          body: `${repo.split('/')[1]} · ${branch}\n${failed ? (run.progress.error ?? '') : run.progress.step}`.trim()
        })
        note.on('click', () => {
          win?.show()
          win?.focus()
        })
        note.show()
      }
    }
  })
}

function cancelScan(id: string): void {
  const run = running.get(id)
  if (!run) return
  run.cancelled = true
  for (const entry of run.entries) {
    entry.cancelled = true
    entry.child?.kill('SIGTERM')
  }
  set(run, { step: 'Stopping' })
}

/** How far the branch on GitHub has moved past the commit the map describes. */
async function freshness(id: string): Promise<MapFreshness> {
  const map = getMap(id)
  if (!map) return { head: null, behind: null }
  try {
    const account = await signedIn(map.account)
    const head = await remoteHead(map.repo, map.branch, account)
    if (!head || head === map.headSha) return { head, behind: head ? 0 : null }
    try {
      const res = await gh(account, `/repos/${map.repo}/compare/${map.headSha}...${head}?per_page=1`)
      const compared = (await res.json()) as { ahead_by?: number }
      return { head, behind: typeof compared.ahead_by === 'number' ? compared.ahead_by : null }
    } catch {
      // The old commit may be gone from GitHub (a rewritten branch); the branch has moved all the same.
      return { head, behind: null }
    }
  } catch (e) {
    console.error('could not check the branch for new commits:', e)
    return { head: null, behind: null }
  }
}

const validRepo = (repo: unknown): repo is string => typeof repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repo)

/** The account the window names, once gh confirms it is signed in to it. A map is only ever read or scanned as its own account. */
async function signedIn(account: unknown): Promise<string> {
  if (typeof account !== 'string' || !(await listAccounts()).some((a) => a.login === account)) throw new Error('Not a signed-in GitHub account.')
  return account
}

/** Hooks the system map up to the window. Called once, before the window opens. */
export function registerSystemMap(getWindow: () => BrowserWindow | null): void {
  emit = (p) => getWindow()?.webContents.send('map:progress', p)
  registerMapChat(getWindow, getMap)
  ipcMain.handle('map:list', (_e, account: string) => ({
    maps: typeof account === 'string' ? listMaps(account) : [],
    running: [...running.values()].map((r) => r.progress).filter((p) => p.account === account)
  }))
  ipcMain.handle('map:get', (_e, id: string) => (typeof id === 'string' ? getMap(id) : null))
  ipcMain.handle('map:branches', async (_e, account: string, repo: string): Promise<MapBranches> => {
    if (!validRepo(repo)) throw new Error('Not a repository.')
    return remoteBranches(repo, await signedIn(account))
  })
  ipcMain.handle('map:freshness', (_e, id: string) => (typeof id === 'string' ? freshness(id) : { head: null, behind: null }))
  ipcMain.handle('map:scan', async (_e, account: string, repo: string, branch: string, mode: string) => {
    if (!validRepo(repo) || !validBranch(branch)) throw new Error('Not a branch that can be scanned.')
    startScan(await signedIn(account), repo, branch, mode === 'update' ? 'update' : 'scan', getWindow)
  })
  ipcMain.handle('map:cancel', (_e, id: string) => {
    if (typeof id === 'string') cancelScan(id)
  })
  ipcMain.handle('map:delete', (_e, id: string) => {
    if (typeof id !== 'string' || !(id in all())) return
    cancelScan(id)
    const gone = getMap(id)
    // The entry goes; the file stays and the version before this is in the backups.
    delete all()[id]
    persist()
    // Its checkout goes too, unless another account still has a map of the same branch.
    const shared = (m: SystemMap | null): boolean => !!m && !!gone && m.repo === gone.repo && m.branch === gone.branch
    if (gone && !Object.values(all()).map(readable).some(shared)) void dropBranchCheckout(gone.repo, gone.branch)
  })
}
