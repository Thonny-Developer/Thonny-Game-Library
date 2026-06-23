// Мост между интерфейсом и main-процессом. Renderer получает только этот
// безопасный API (никакого прямого доступа к Node).
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('api', {
  // авторизация
  bootstrap: () => invoke('auth:bootstrap'),
  login: (username, password, remember) =>
    invoke('auth:login', { username, password, remember }),
  logout: () => invoke('auth:logout'),
  account: () => invoke('account:info'),

  // трекер
  search: (query, opts) => invoke('search', { query, opts }),
  getTopic: (id) => invoke('topic:get', id),
  copyMagnet: (id, title) => invoke('topic:magnet', { id, title }),
  downloadTorrent: (id, title) => invoke('torrent:download', { id, title }),

  // загрузки содержимого (BitTorrent)
  startDownload: (id, title) => invoke('download:start', { id, title }),
  downloadList: () => invoke('download:list'),
  pauseDownload: (id) => invoke('download:pause', id),
  resumeDownload: (id) => invoke('download:resume', id),
  removeDownload: (id, deleteFiles) => invoke('download:remove', { id, deleteFiles }),
  openDownloadFolder: (id) => invoke('download:openFolder', id),
  openDownloadFile: (id) => invoke('download:openFile', id),

  // данные приложения
  getSettings: () => invoke('settings:get'),
  setSettings: (patch) => invoke('settings:set', patch),
  getStats: () => invoke('stats:get'),
  library: () => invoke('library:list'),
  removeLibrary: (topicId, type) => invoke('library:remove', { topicId, type }),
  pingMirrors: () => invoke('mirrors:ping'),
  version: () => invoke('app:version'),
  openExternal: (url) => invoke('shell:open', url),

  // управление окном
  winMinimize: () => invoke('win:minimize'),
  winMaximize: () => invoke('win:maximize'),
  winClose: () => invoke('win:close'),

  // события main → renderer
  onLog: (cb) => ipcRenderer.on('log', (_e, msg) => cb(msg)),
  onDownloadUpdate: (cb) => ipcRenderer.on('download:update', (_e, snap) => cb(snap)),
  onDownloadTick: (cb) => ipcRenderer.on('download:tick', (_e, list) => cb(list)),
  onDownloadDone: (cb) => ipcRenderer.on('download:done', (_e, snap) => cb(snap)),
  onDownloadRemoved: (cb) => ipcRenderer.on('download:removed', (_e, id) => cb(id)),
});
