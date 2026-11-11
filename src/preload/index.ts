import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api, ReviewProgress } from '../shared/types'

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
  discardDraft: (key) => ipcRenderer.invoke('draft:discard', key),
  startReview: (pr, focus) => ipcRenderer.invoke('review:start', pr, focus),
  cancelReview: (key) => ipcRenderer.invoke('review:cancel', key),
  runningReviews: () => ipcRenderer.invoke('review:running'),
  postReview: (req) => ipcRenderer.invoke('review:post', req),
  copyText: (text, html) => ipcRenderer.invoke('clipboard:write', text, html),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  storageUsage: () => ipcRenderer.invoke('storage:usage'),
  clearStorage: (id) => ipcRenderer.invoke('storage:clear', id),
  revealStorage: () => ipcRenderer.invoke('storage:reveal'),
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
