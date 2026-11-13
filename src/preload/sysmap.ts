import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { MapChatEvent, MapProgress, SystemMapApi } from '../shared/sysmap'

/** The system map's part of window.api. */
export const systemMapApi: SystemMapApi = {
  mapList: (account) => ipcRenderer.invoke('map:list', account),
  mapGet: (id) => ipcRenderer.invoke('map:get', id),
  mapBranches: (account, repo) => ipcRenderer.invoke('map:branches', account, repo),
  mapFreshness: (id) => ipcRenderer.invoke('map:freshness', id),
  mapScan: (account, repo, branch, mode) => ipcRenderer.invoke('map:scan', account, repo, branch, mode),
  mapCancel: (id) => ipcRenderer.invoke('map:cancel', id),
  mapDelete: (id) => ipcRenderer.invoke('map:delete', id),
  onMapProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, p: MapProgress): void => cb(p)
    ipcRenderer.on('map:progress', listener)
    return () => ipcRenderer.removeListener('map:progress', listener)
  },
  mapChats: (mapId) => ipcRenderer.invoke('map:chats', mapId),
  mapAsk: (mapId, subject, chatId, question) => ipcRenderer.invoke('map:ask', mapId, subject, chatId, question),
  mapChatCancel: (chatId) => ipcRenderer.invoke('map:chat-cancel', chatId),
  mapChatDelete: (chatId) => ipcRenderer.invoke('map:chat-delete', chatId),
  onMapChatEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, ev: MapChatEvent): void => cb(ev)
    ipcRenderer.on('map:chat', listener)
    return () => ipcRenderer.removeListener('map:chat', listener)
  }
}
