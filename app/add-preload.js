const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sidekicks', {
  addPet: (code) => ipcRenderer.invoke('add-pet', code),
  onProgress: (fn) => ipcRenderer.on('add-progress', (_e, msg) => fn(msg)),
  onPrefill: (fn) => ipcRenderer.on('prefill', (_e, code) => fn(code)),
  openSite: () => ipcRenderer.send('open-site'),
  close: () => ipcRenderer.send('close-add'),
});
