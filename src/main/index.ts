import { app, BrowserWindow, clipboard, ClipboardItem, ipcMain, Notification, shell } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkLog, listOpenPrs, listPrs, postReview, prDetail } from './github'
import { discardDraft, getDraft, saveDraft } from './store'
import { getPerformance, recordSnapshot } from './performance'
import { cancelReview, runningReviews, startReview } from './review'
import { getSettings, reviewDefaults, saveSettings } from './settings'
import { learnVoice } from './voice'
import type { PostRequest, PrList, PrSummary, ReviewDraft, ReviewProgress, Settings } from '../shared/types'

let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 980,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#1b1c1f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  // The top bar leaves room for the traffic lights, which disappear in full screen.
  const sendFullScreen = (): void => win?.webContents.send('window:fullscreen', win.isFullScreen())
  win.on('enter-full-screen', sendFullScreen)
  win.on('leave-full-screen', sendFullScreen)
  win.on('closed', () => (win = null))
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

const emit = (p: ReviewProgress): void => {
  win?.webContents.send('review:progress', p)
  if (p.state === 'done' && Notification.isSupported() && !win?.isFocused())
    new Notification({ title: 'Review drafted', body: `${p.key} is ready for you to look over.` }).show()
}

// Keys that needed the user at the last refresh, so we only notify about new ones.
let knownAttention: Set<string> | null = null

function noteAttention(prs: PrSummary[]): void {
  const now = prs.filter((p) => p.level !== 'waiting')
  app.dock?.setBadge(now.length ? String(now.length) : '')
  if (knownAttention && Notification.isSupported()) {
    const fresh = now.filter((p) => !knownAttention!.has(p.key))
    if (fresh.length === 1)
      new Notification({ title: fresh[0].reasons[0]?.text ?? 'Needs you', body: `${fresh[0].key} ${fresh[0].title}` }).show()
    else if (fresh.length > 1)
      new Notification({ title: `${fresh.length} pull requests need you`, body: fresh.map((p) => p.key).join(', ') }).show()
  }
  knownAttention = new Set(now.map((p) => p.key))
}

// ---------- Cached lists ----------
// The dashboard asks often (a timer, every window focus, every relaunch). Answering from a recent
// result keeps Docket well inside GitHub's limits, and the last list is kept on disk so there is
// something to show when GitHub cannot be reached.

const LIST_FRESH_MS = 45_000
const LIST_FORCED_MS = 10_000 // even the Refresh button does not refetch more often than this
const OPEN_FRESH_MS = 5 * 60_000
const listFile = (): string => join(app.getPath('userData'), 'prs.json')
let listCache: PrList | null | undefined
let listInflight: Promise<PrList> | null = null
const openCache = new Map<string, { at: number; result: { prs: PrSummary[]; truncated: boolean } }>()

const withDrafts = <T extends { prs: PrSummary[] }>(result: T): T => {
  for (const pr of result.prs) {
    const d = getDraft(pr.key)
    pr.draftState = !d ? 'none' : d.posted ? 'posted' : d.headSha === pr.headSha ? 'draft' : 'stale'
  }
  return result
}
const clock = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const short = (e: unknown): string => (e as Error).message.replace(/ for user ID \d+/, '')

ipcMain.handle('prs:list', async (_e, force?: boolean): Promise<PrList> => {
  if (listCache === undefined) {
    try {
      listCache = JSON.parse(readFileSync(listFile(), 'utf8')) as PrList
    } catch {
      listCache = null
    }
  }
  const cached = listCache
  const age = cached ? Date.now() - new Date(cached.fetchedAt).getTime() : Infinity
  if (cached && age < (force ? LIST_FORCED_MS : LIST_FRESH_MS)) return withDrafts({ ...cached, notice: undefined })
  listInflight ??= (async () => {
    const { viewer, prs } = await listPrs()
    const fresh: PrList = { viewer, prs, fetchedAt: new Date().toISOString() }
    listCache = fresh
    try {
      writeFileSync(listFile(), JSON.stringify(fresh))
    } catch (e) {
      console.error('could not save the pull request list:', e)
    }
    noteAttention(prs)
    recordSnapshot(prs)
    return fresh
  })().finally(() => (listInflight = null))
  try {
    return withDrafts(await listInflight)
  } catch (e) {
    if (!cached) throw e
    return withDrafts({ ...cached, notice: `Showing the list from ${clock(cached.fetchedAt)}. ${short(e)}` })
  }
})
ipcMain.handle('prs:open', async (_e, repos: string[]) => {
  const list = Array.isArray(repos) ? repos.filter((r) => typeof r === 'string').sort() : []
  const key = list.join(',')
  const hit = openCache.get(key)
  if (hit && Date.now() - hit.at < OPEN_FRESH_MS) return withDrafts(hit.result)
  try {
    const result = await listOpenPrs(list)
    openCache.set(key, { at: Date.now(), result })
    return withDrafts(result)
  } catch (e) {
    if (hit) return withDrafts(hit.result) // older, but better than nothing
    throw e
  }
})
ipcMain.handle('performance:get', (_e, force: boolean) => getPerformance(!!force))
ipcMain.handle('pr:detail', (_e, repo: string, number: number) => prDetail(repo, number))
ipcMain.handle('check:log', (_e, repo: string, jobId: number) => {
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(jobId))
    throw new Error('Not a valid check.')
  return checkLog(repo, jobId)
})
ipcMain.handle('settings:get', () => getSettings())
ipcMain.handle('review:defaults', () => reviewDefaults())
ipcMain.handle('settings:save', (_e, settings: Settings) => saveSettings(settings))
ipcMain.handle('voice:learn', () => learnVoice())
ipcMain.handle('draft:get', (_e, key: string) => getDraft(key))
ipcMain.handle('draft:save', (_e, draft: ReviewDraft) => saveDraft(draft))
ipcMain.handle('draft:discard', (_e, key: string) => discardDraft(key))
ipcMain.handle('review:start', (_e, pr: PrSummary, focus: string) => startReview(pr, focus, emit))
ipcMain.handle('review:cancel', (_e, key: string) => cancelReview(key))
ipcMain.handle('review:running', () => runningReviews())
ipcMain.handle('review:post', async (_e, req: PostRequest) => {
  const result = await postReview(req)
  const draft = getDraft(`${req.repo}#${req.number}`)
  if (draft) saveDraft({ ...draft, posted: { url: result.url, at: new Date().toISOString() } })
  return result
})
ipcMain.handle('window:is-fullscreen', () => win?.isFullScreen() ?? false)
ipcMain.handle('clipboard:write', (_e, text: string, html?: string) => {
  if (typeof text !== 'string') return
  // With an HTML version alongside, apps like Slack paste titled links instead of bare URLs.
  if (typeof html === 'string')
    return clipboard.write([
      new ClipboardItem({ 'text/plain': text.slice(0, 100_000), 'text/html': html.slice(0, 200_000) })
    ])
  return clipboard.writeText(text.slice(0, 100_000))
})
ipcMain.handle('open:external', (_e, url: string) => {
  if (typeof url === 'string' && url.startsWith('https://')) return shell.openExternal(url)
})

void app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
