import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api, ChatEvent, Notice, ReviewProgress } from '../shared/types'
import { systemMapApi } from './sysmap'

const api: Api = {
  ...systemMapApi,
  getSettings: () => ipcRenderer.invoke('settings:get'),
  reviewDefaults: () => ipcRenderer.invoke('review:defaults'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  listAccounts: (force) => ipcRenderer.invoke('accounts:list', force),
  setAccountEnabled: (login, enabled) => ipcRenderer.invoke('accounts:enable', login, enabled),
  learnVoice: (account) => ipcRenderer.invoke('voice:learn', account),
  performance: (account, force) => ipcRenderer.invoke('performance:get', account, force),
  listPrs: (force) => ipcRenderer.invoke('prs:list', force),
  listOpenPrs: (account, repos) => ipcRenderer.invoke('prs:open', account, repos),
  prDetail: (account, repo, number) => ipcRenderer.invoke('pr:detail', account, repo, number),
  checkLog: (account, repo, jobId) => ipcRenderer.invoke('check:log', account, repo, jobId),
  rerunJob: (account, repo, jobId) => ipcRenderer.invoke('check:rerun-job', account, repo, jobId),
  rerunFailedJobs: (account, repo, runIds) => ipcRenderer.invoke('check:rerun-failed', account, repo, runIds),
  getDraft: (account, key) => ipcRenderer.invoke('draft:get', account, key),
  saveDraft: (draft) => ipcRenderer.invoke('draft:save', draft),
  discardDraft: (account, key, why) => ipcRenderer.invoke('draft:discard', account, key, why),
  listReviews: (account, key) => ipcRenderer.invoke('reviews:list', account, key),
  startReview: (pr, focus, mode) => ipcRenderer.invoke('review:start', pr, focus, mode),
  cancelReview: (account, key) => ipcRenderer.invoke('review:cancel', account, key),
  runningReviews: () => ipcRenderer.invoke('review:running'),
  postReview: (req) => ipcRenderer.invoke('review:post', req),
  copyText: (text, html) => ipcRenderer.invoke('clipboard:write', text, html),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  storageUsage: (account) => ipcRenderer.invoke('storage:usage', account),
  clearStorage: (account, id) => ipcRenderer.invoke('storage:clear', account, id),
  revealStorage: () => ipcRenderer.invoke('storage:reveal'),
  listChats: (account, key) => ipcRenderer.invoke('chat:list', account, key),
  sendChat: (pr, chatId, question) => ipcRenderer.invoke('chat:send', pr, chatId, question),
  cancelChat: (chatId) => ipcRenderer.invoke('chat:cancel', chatId),
  deleteChat: (chatId) => ipcRenderer.invoke('chat:delete', chatId),
  onChatEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, ev: ChatEvent): void => cb(ev)
    ipcRenderer.on('chat:event', listener)
    return () => ipcRenderer.removeListener('chat:event', listener)
  },
  listNotices: (account) => ipcRenderer.invoke('notices:list', account),
  markNoticesRead: (account) => ipcRenderer.invoke('notices:read', account),
  onNotice: (cb) => {
    const listener = (_e: IpcRendererEvent, n: Notice): void => cb(n)
    ipcRenderer.on('notice', listener)
    return () => ipcRenderer.removeListener('notice', listener)
  },
  onOpenNotice: (cb) => {
    const listener = (_e: IpcRendererEvent, n: Notice): void => cb(n)
    ipcRenderer.on('notice:open', listener)
    return () => ipcRenderer.removeListener('notice:open', listener)
  },
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),
  isFullScreen: () => ipcRenderer.invoke('window:is-fullscreen'),
  onFullScreen: (cb) => {
    const listener = (_e: IpcRendererEvent, on: boolean): void => cb(on)
    ipcRenderer.on('window:fullscreen', listener)
    return () => ipcRenderer.removeListener('window:fullscreen', listener)
  },
  onReviewProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, p: ReviewProgress): void => cb(p)
    ipcRenderer.on('review:progress', listener)
    return () => ipcRenderer.removeListener('review:progress', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
