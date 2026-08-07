const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ds', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  updateConfig: (patch) => ipcRenderer.invoke('config:update', patch),
  fetchBalance: () => ipcRenderer.invoke('balance:fetch'),
  capture: (rect) => ipcRenderer.invoke('card:capture', rect),
  quit: () => ipcRenderer.invoke('app:quit'),
  hide: () => ipcRenderer.invoke('window:hide'),
  moveTo: (x, y) => ipcRenderer.invoke('window:move-to', x, y),
  moveBy: (dx, dy) => ipcRenderer.invoke('window:move-by', dx, dy),
  setIgnoreMouseEvents: (v) => ipcRenderer.invoke('window:set-ignore-mouse', v),
  setDragActive: (v) => ipcRenderer.invoke('window:set-drag-active', v),
  getPosition: () => ipcRenderer.invoke('window:get-position'),
  notify: (title, body) => ipcRenderer.invoke('app:notify', title, body),
  showContextMenu: () => ipcRenderer.invoke('card:context-menu'),
  onMenuAction: (cb) => {
    ipcRenderer.on('menu:action', (_e, action) => cb(action));
  },
  onModeChanged: (cb) => {
    ipcRenderer.on('mode:changed', (_e, collapsed) => cb(collapsed));
  },
});
