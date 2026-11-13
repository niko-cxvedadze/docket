import { app, BrowserWindow, clipboard, ClipboardItem, ipcMain, nativeTheme, shell } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkLog, listOpenPrs, listPrs, postReview, prDetail, rerunFailedJobs, rerunJob } from './github'
import { adoptOldWork, discardDraft, getDraft, listReviews, recordPostedReview, saveDraft } from './store'
import { randomUUID } from 'node:crypto'
import { getPerformance, recordSnapshot } from './performance'
import { cancelReview, runningReviews, startReview } from './review'
import { getSettings, reviewDefaults, saveSettings } from './settings'
import { learnVoice } from './voice'
import { adoptOldChats, cancelChat, deleteChat, listChats, runningChats, sendChat } from './chat'
import { pruneCheckouts, validRepo } from './repo'
import { accountFor, enabledAccounts, enabledAccountsIfKnown, listAccounts, rememberAccounts, setAccountEnabled, signedIn } from './accounts'
import { listNotices, markNoticesRead, noticeChanges, notify, setNoticeWindow } from './notify'
import { readStore, writeStore } from './persist'
import { clearStorage, revealStorage, storageUsage } from './storage'
import { registerSystemMap } from './sysmap'
import { shortName, type PostRequest, type PrList, type PrSummary, type ReviewDraft, type ReviewProgress, type Settings, type Theme } from '../shared/types'

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

/** An account's pull request, from the last list, so a notice can name it. */
const prFor = (account: string | undefined, key: string): PrSummary | undefined =>
  listCache?.prs.find((p) => p.key === key && (!account || p.account === account))
const named = (account: string | undefined, key: string): string => {
  const pr = prFor(account, key)
  return pr ? `${shortName(pr)} ${pr.title}` : key
}

const emit = (p: ReviewProgress): void => {
  win?.webContents.send('review:progress', p)
  const url = prFor(p.account, p.key)?.url
  if (p.state === 'done') notify('review-done', 'Review drafted', named(p.account, p.key), p.account, p.key, url)
  else if (p.state === 'error')
    notify('review-failed', 'Review did not finish', `${named(p.account, p.key)}\n${p.error ?? ''}`.trim(), p.account, p.key, url)
}

/** The dock badge counts what needs the user; the window shows the same number and where it comes from. */
function noteAttention(prs: PrSummary[], accountsChanged: boolean): void {
  const now = prs.filter((p) => p.level !== 'waiting')
  app.dock?.setBadge(now.length ? String(now.length) : '')
  noticeChanges(prs, accountsChanged)
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
const forgetLists = (): void => {
  listStale = true
  openCache.clear()
}

/**
 * Marks drafts on a list about to go to the window. On the way it notes which account each pull
 * request belongs to, and files work saved before accounts were kept apart under that account.
 */
const withDrafts = <T extends { prs: PrSummary[] }>(result: T): T => {
  rememberAccounts(result.prs)
  try {
    const listed = new Map(result.prs.map((p) => [p.key, p.account]))
    adoptOldWork(listed)
    adoptOldChats(listed)
  } catch (e) {
    console.error('could not file earlier work under its account:', e) // it stays where it was, and still shows
  }
  for (const pr of result.prs) {
    const d = getDraft(pr.account, pr.key)
    pr.draftState = !d ? 'none' : d.posted ? 'posted' : d.headSha === pr.headSha ? 'draft' : 'stale'
  }
  return result
}
const clock = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const short = (e: unknown): string => (e as Error).message.replace(/ for user ID \d+/, '')

/** The list as saved on disk. One saved before there could be several accounts names a single `viewer`, who owns all of it. */
function readSavedList(): PrList | null {
  try {
    const saved = JSON.parse(readFileSync(listFile(), 'utf8')) as PrList & { viewer?: string }
    const accounts = Array.isArray(saved.accounts) ? saved.accounts : saved.viewer ? [saved.viewer] : []
    for (const pr of saved.prs) pr.account ??= accounts[0] ?? ''
    return { accounts, fetchedAt: saved.fetchedAt, prs: saved.prs, notice: saved.notice }
  } catch {
    return null
  }
}
const sameAccounts = (a: string[], b: string[]): boolean => a.length === b.length && a.every((login) => b.includes(login))

ipcMain.handle('prs:list', async (_e, force?: boolean): Promise<PrList> => {
  if (listCache === undefined) listCache = readSavedList()
  const cached = listCache
  const age = cached ? Date.now() - new Date(cached.fetchedAt).getTime() : Infinity
  // A list for other accounts than the ones switched on now is out of date however recent it is.
  const known = enabledAccountsIfKnown()
  const current = !!cached && (!known || sameAccounts(known, cached.accounts))
  if (cached && current && !listStale && age < (force ? LIST_FORCED_MS : LIST_FRESH_MS)) return withDrafts(cached)
  listInflight ??= (async () => {
    // The Refresh button also asks gh again who is signed in, so a new sign-in shows up at once.
    const accounts = await enabledAccounts(!!force)
    const { prs, failed } = await listPrs(accounts, cached?.prs)
    const fresh: PrList = {
      accounts,
      prs,
      fetchedAt: new Date().toISOString(),
      notice: failed.length
        ? `${failed.map((f) => `Could not refresh ${f.account}: ${short(new Error(f.error))}`).join(' ')} Its pull requests are shown as they were before.`
        : undefined
    }
    listCache = fresh
    // Unless an account was switched on or off while GitHub was answering: then this list is already old.
    listStale = !sameAccounts(enabledAccountsIfKnown() ?? accounts, accounts)
    try {
      writeFileSync(listFile(), JSON.stringify(fresh))
    } catch (e) {
      console.error('could not save the pull request list:', e)
    }
    noteAttention(prs, !!cached && !sameAccounts(cached.accounts, accounts))
    recordSnapshot(prs, accounts)
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
ipcMain.handle('prs:open', async (_e, account: string, repos: string[]) => {
  const list = Array.isArray(repos) ? repos.filter((r) => typeof r === 'string').sort() : []
  const as = await signedIn(account)
  const key = `${as}|${list.join(',')}`
  const hit = openCache.get(key)
  if (hit && Date.now() - hit.at < OPEN_FRESH_MS) return withDrafts(hit.result)
  try {
    const result = await listOpenPrs(as, list)
    openCache.set(key, { at: Date.now(), result })
    return withDrafts(result)
  } catch (e) {
    if (hit) return withDrafts(hit.result) // older, but better than nothing
    throw e
  }
})
ipcMain.handle('performance:get', async (_e, account: string, force: boolean) => getPerformance(await signedIn(account), !!force))
// The window says which account a pull request is listed for; everything done to it is done as that account.
ipcMain.handle('pr:detail', async (_e, account: string, repo: string, number: number) => prDetail(await signedIn(account), repo, number))
for (const [channel, job] of [['check:log', checkLog], ['check:rerun-job', rerunJob]] as const)
  ipcMain.handle(channel, async (_e, account: string, repo: string, jobId: number) => {
    if (!validRepo(repo) || !Number.isSafeInteger(jobId)) throw new Error('Not a valid check.')
    return job(await signedIn(account), repo, jobId)
  })
ipcMain.handle('check:rerun-failed', async (_e, account: string, repo: string, runIds: number[]) => {
  if (!validRepo(repo) || !Array.isArray(runIds) || !runIds.length || !runIds.every(Number.isSafeInteger))
    throw new Error('Not a valid workflow run.')
  return rerunFailedJobs(await signedIn(account), repo, runIds)
})
ipcMain.handle('accounts:list', (_e, force?: boolean) => listAccounts(!!force))
ipcMain.handle('accounts:enable', async (_e, login: string, enabled: boolean) => {
  if (typeof login !== 'string') throw new Error('Not a GitHub account.')
  const accounts = await setAccountEnabled(login, !!enabled)
  // The lists on screen are for the accounts as they were; the next ones ask GitHub.
  forgetLists()
  return accounts
})
ipcMain.handle('settings:get', () => getSettings())
ipcMain.handle('review:defaults', () => reviewDefaults())
ipcMain.handle('settings:save', (_e, settings: Settings) => saveSettings(settings))
ipcMain.handle('voice:learn', async (_e, account: string) => learnVoice(await signedIn(account)))
ipcMain.handle('draft:get', (_e, account: string, key: string) => (typeof account === 'string' && typeof key === 'string' ? getDraft(account, key) : null))
ipcMain.handle('draft:save', (_e, draft: ReviewDraft) => saveDraft(draft))
ipcMain.handle('draft:discard', (_e, account: string, key: string, why?: string) => {
  if (typeof account !== 'string' || typeof key !== 'string') return
  discardDraft(account, key, typeof why === 'string' ? why.slice(0, 80) : 'window')
})
ipcMain.handle('reviews:list', (_e, account: string, key: string) =>
  typeof account === 'string' && typeof key === 'string' ? listReviews(account, key) : []
)
ipcMain.handle('review:start', (_e, pr: PrSummary, focus: string, mode?: string) =>
  startReview(pr, focus, emit, mode === 'extend' ? 'extend' : 'replace')
)
ipcMain.handle('review:cancel', (_e, account: string, key: string) => cancelReview(String(account), String(key)))
ipcMain.handle('review:running', () => runningReviews())
ipcMain.handle('review:post', async (_e, req: PostRequest) => {
  const account = await accountFor(req.repo, req.number, req.account)
  const result = await postReview(account, req)
  const key = `${req.repo}#${req.number}`
  const at = new Date().toISOString()
  const draft = getDraft(account, key)
  // The history keeps exactly what went to GitHub, whatever later happens to the draft.
  recordPostedReview({
    id: randomUUID(),
    key,
    account,
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
  forgetLists()
  return result
})
ipcMain.handle('storage:usage', async (_e, account: string) => storageUsage(await signedIn(account)))
ipcMain.handle('storage:clear', async (_e, account: string, id: string) => clearStorage(await signedIn(account), id))
ipcMain.handle('storage:reveal', () => revealStorage())
ipcMain.handle('notices:list', (_e, account: string) => (typeof account === 'string' ? listNotices(account) : []))
ipcMain.handle('notices:read', (_e, account: string) => {
  if (typeof account === 'string') markNoticesRead(account)
})
ipcMain.handle('chat:list', (_e, account: string, key: string) => {
  const chats = typeof account === 'string' && typeof key === 'string' ? listChats(account, key) : []
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

registerSystemMap(() => win)

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
