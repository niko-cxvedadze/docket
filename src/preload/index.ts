import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api, ChatEvent, Notice, ReviewProgress } from '../shared/types'

const api: Api = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  reviewDefaults: () => ipcRenderer.invoke('review:defaults'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  learnVoice: () => ipcRenderer.invoke('voice:learn'),
  performance: (force) => ipcRenderer.invoke('performance:get', force),
  listPrs: (force) => ipcRenderer.invoke('prs:list', force),
  listOpenPrs: (repos) => ipcRenderer.invoke('prs:open', repos),
  prDetail: (repo, number) => ipcRenderer.invoke('pr:detail', repo, number),
  checkLog: (repo, jobId) => ipcRenderer.invoke('check:log', repo, jobId),
  rerunJob: (repo, jobId) => ipcRenderer.invoke('check:rerun-job', repo, jobId),
  rerunFailedJobs: (repo, runIds) => ipcRenderer.invoke('check:rerun-failed', repo, runIds),
  getDraft: (key) => ipcRenderer.invoke('draft:get', key),
  saveDraft: (draft) => ipcRenderer.invoke('draft:save', draft),
  discardDraft: (key, why) => ipcRenderer.invoke('draft:discard', key, why),
  listReviews: (key) => ipcRenderer.invoke('reviews:list', key),
  startReview: (pr, focus, mode) => ipcRenderer.invoke('review:start', pr, focus, mode),
  cancelReview: (key) => ipcRenderer.invoke('review:cancel', key),
  runningReviews: () => ipcRenderer.invoke('review:running'),
  postReview: (req) => ipcRenderer.invoke('review:post', req),
  copyText: (text, html) => ipcRenderer.invoke('clipboard:write', text, html),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  storageUsage: () => ipcRenderer.invoke('storage:usage'),
  clearStorage: (id) => ipcRenderer.invoke('storage:clear', id),
  revealStorage: () => ipcRenderer.invoke('storage:reveal'),
  listChats: (key) => ipcRenderer.invoke('chat:list', key),
  sendChat: (pr, chatId, question) => ipcRenderer.invoke('chat:send', pr, chatId, question),
  cancelChat: (chatId) => ipcRenderer.invoke('chat:cancel', chatId),
  deleteChat: (chatId) => ipcRenderer.invoke('chat:delete', chatId),
  onChatEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, ev: ChatEvent): void => cb(ev)
    ipcRenderer.on('chat:event', listener)
    return () => ipcRenderer.removeListener('chat:event', listener)
  },
  listNotices: () => ipcRenderer.invoke('notices:list'),
  markNoticesRead: () => ipcRenderer.invoke('notices:read'),
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
