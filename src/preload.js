const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dogApi', {
  onCursor: (fn) => ipcRenderer.on('cursor', (_e, data) => fn(data)),
  setHover: (over) => ipcRenderer.send('hover', over),
  drag: (dx, dy) => ipcRenderer.send('drag', { dx, dy }),
  contextMenu: () => ipcRenderer.send('context-menu'),
});
