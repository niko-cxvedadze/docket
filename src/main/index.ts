import { app, BrowserWindow, clipboard, ClipboardItem, ipcMain, nativeTheme, shell } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkLog, listOpenPrs, listPrs, postReview, prDetail, rerunFailedJobs, rerunJob } from './github'
import { discardDraft, getDraft, listReviews, recordPostedReview, saveDraft } from './store'
import { randomUUID } from 'node:crypto'
import { getPerformance, recordSnapshot } from './performance'
import { cancelReview, runningReviews, startReview } from './review'
import { getSettings, reviewDefaults, saveSettings } from './settings'
import { learnVoice } from './voice'
import { cancelChat, deleteChat, listChats, runningChats, sendChat } from './chat'
import { pruneCheckouts } from './repo'
import { listNotices, markNoticesRead, noticeChanges, notify, setNoticeWindow } from './notify'
import { readStore, writeStore } from './persist'
import { clearStorage, revealStorage, storageUsage } from './storage'
import type { PostRequest, PrList, PrSummary, ReviewDraft, ReviewProgress, Settings, Theme } from '../shared/types'

let win: BrowserWindow | null = null

// ---------- Appearance ----------
// Setting nativeTheme.themeSource flips prefers-color-scheme in the renderer, so the CSS needs no other switch.
const THEMES: readonly Theme[] = ['system', 'light', 'dark']
function loadTheme(): Theme {
  const t = readStore<Theme>('theme.json', 'system')
  return THEMES.includes(t) ? t : 'system'
}
// Matches --bg in styles.css, so the window does not flash a different colour while it loads.
const windowBackground = (): string => (nativeTheme.shouldUseDarkColors ? '#0f0f11' : '#fafafa')
ipcMain.handle('theme:get', () => nativeTheme.themeSource)
ipcMain.handle('theme:set', (_e, theme: Theme) => {
  if (!THEMES.includes(theme)) return
  nativeTheme.themeSource = theme
  try {
    writeStore('theme.json', theme)
  } catch (e) {
    console.error('could not save the theme:', e)
  }
})

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 980,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: windowBackground(),
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

/** The pull request behind a key, from the last list, so a notice can name it. */
const prFor = (key: string): PrSummary | undefined => listCache?.prs.find((p) => p.key === key)
const named = (key: string): string => {
  const pr = prFor(key)
  return pr ? `${pr.repo.split('/')[1]}#${pr.number} ${pr.title}` : key
}

const emit = (p: ReviewProgress): void => {
  win?.webContents.send('review:progress', p)
  if (p.state === 'done') notify('review-done', 'Review drafted', named(p.key), p.key, prFor(p.key)?.url)
  else if (p.state === 'error') notify('review-failed', 'Review did not finish', `${named(p.key)}\n${p.error ?? ''}`.trim(), p.key, prFor(p.key)?.url)
}

/** The dock badge counts what needs the user; the window shows the same number and where it comes from. */
function noteAttention(prs: PrSummary[]): void {
  const now = prs.filter((p) => p.level !== 'waiting')
  app.dock?.setBadge(now.length ? String(now.length) : '')
  noticeChanges(prs)
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
let lastPrune = 0
/** Set when something the user did (posting a review) changed what GitHub would answer. */
let listStale = false
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
  if (cached && !listStale && age < (force ? LIST_FORCED_MS : LIST_FRESH_MS)) return withDrafts({ ...cached, notice: undefined })
  listInflight ??= (async () => {
    const { viewer, prs } = await listPrs()
    const fresh: PrList = { viewer, prs, fetchedAt: new Date().toISOString() }
    listCache = fresh
    listStale = false
    try {
      writeFileSync(listFile(), JSON.stringify(fresh))
    } catch (e) {
      console.error('could not save the pull request list:', e)
    }
    noteAttention(prs)
    recordSnapshot(prs)
    // At most hourly: drop the code of pull requests that left the dashboard days ago.
    if (Date.now() - lastPrune > 60 * 60_000) {
      lastPrune = Date.now()
      void pruneCheckouts(new Set(prs.map((p) => p.key)))
    }
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
const validRepo = (repo: unknown): repo is string => typeof repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repo)
ipcMain.handle('check:log', (_e, repo: string, jobId: number) => {
  if (!validRepo(repo) || !Number.isSafeInteger(jobId)) throw new Error('Not a valid check.')
  return checkLog(repo, jobId)
})
ipcMain.handle('check:rerun-job', (_e, repo: string, jobId: number) => {
  if (!validRepo(repo) || !Number.isSafeInteger(jobId)) throw new Error('Not a valid check.')
  return rerunJob(repo, jobId)
})
ipcMain.handle('check:rerun-failed', (_e, repo: string, runIds: number[]) => {
  if (!validRepo(repo) || !Array.isArray(runIds) || !runIds.length || !runIds.every(Number.isSafeInteger))
    throw new Error('Not a valid workflow run.')
  return rerunFailedJobs(repo, runIds)
})
ipcMain.handle('settings:get', () => getSettings())
ipcMain.handle('review:defaults', () => reviewDefaults())
ipcMain.handle('settings:save', (_e, settings: Settings) => saveSettings(settings))
ipcMain.handle('voice:learn', () => learnVoice())
ipcMain.handle('draft:get', (_e, key: string) => getDraft(key))
ipcMain.handle('draft:save', (_e, draft: ReviewDraft) => saveDraft(draft))
ipcMain.handle('draft:discard', (_e, key: string, why?: string) => discardDraft(key, typeof why === 'string' ? why.slice(0, 80) : 'window'))
ipcMain.handle('reviews:list', (_e, key: string) => (typeof key === 'string' ? listReviews(key) : []))
ipcMain.handle('review:start', (_e, pr: PrSummary, focus: string, mode?: string) =>
  startReview(pr, focus, emit, mode === 'extend' ? 'extend' : 'replace')
)
ipcMain.handle('review:cancel', (_e, key: string) => cancelReview(key))
ipcMain.handle('review:running', () => runningReviews())
ipcMain.handle('review:post', async (_e, req: PostRequest) => {
  const result = await postReview(req)
  const key = `${req.repo}#${req.number}`
  const at = new Date().toISOString()
  const draft = getDraft(key)
  // The history keeps exactly what went to GitHub, whatever later happens to the draft.
  recordPostedReview({
    id: randomUUID(),
    key,
    at,
    url: result.url,
    verdict: req.verdict,
    body: req.body,
    comments: req.comments,
    headSha: req.headSha,
    model: draft?.model,
    effort: draft?.effort
  })
  if (draft) saveDraft({ ...draft, posted: { url: result.url, at } })
  // The review changes the pull request's standing; the next list asks GitHub instead of the cache.
  listStale = true
  openCache.clear()
  return result
})
ipcMain.handle('storage:usage', () => storageUsage())
ipcMain.handle('storage:clear', (_e, id: string) => clearStorage(id))
ipcMain.handle('storage:reveal', () => revealStorage())
ipcMain.handle('notices:list', () => listNotices())
ipcMain.handle('notices:read', () => markNoticesRead())
ipcMain.handle('chat:list', (_e, key: string) => {
  const chats = typeof key === 'string' ? listChats(key) : []
  const running = runningChats()
  return { chats, running: chats.filter((c) => running.includes(c.id)).map((c) => c.id) }
})
ipcMain.handle('chat:send', (_e, pr: PrSummary, chatId: string | null, question: string) => {
  if (!pr || typeof pr.key !== 'string' || typeof question !== 'string') return null
  if (chatId !== null && typeof chatId !== 'string') return null
  return sendChat(pr, chatId, question, (ev) => win?.webContents.send('chat:event', ev))
})
ipcMain.handle('chat:cancel', (_e, chatId: string) => cancelChat(chatId))
ipcMain.handle('chat:delete', (_e, chatId: string) => deleteChat(chatId))
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
  nativeTheme.themeSource = loadTheme()
  nativeTheme.on('updated', () => win?.setBackgroundColor(windowBackground()))
  // A packaged app carries its own icon; in development the dock would show Electron's.
  if (!app.isPackaged) app.dock?.setIcon(join(__dirname, '../../build/icon.png'))
  setNoticeWindow(() => win)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
