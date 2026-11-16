// Bridge for the pet window: the same dogApi the player uses in Chunky's app, plus the
// pet's own measurements (window.PET) and where its footage lives (window.CHUNKY_ASSETS).
const { contextBridge, ipcRenderer } = require('electron');

const pet = ipcRenderer.sendSync('pet-info');
contextBridge.exposeInMainWorld('PET', pet.manifest);
contextBridge.exposeInMainWorld('CHUNKY_ASSETS', pet.assets);
contextBridge.exposeInMainWorld('dogApi', {
  menuButton: true,   // show the "Menu" pill when the pointer is on the pet
  onCursor: (fn) => ipcRenderer.on('cursor', (_e, data) => fn(data)),
  onAction: (fn) => ipcRenderer.on('action', (_e, name) => fn(name)),
  setHover: (over) => ipcRenderer.send('hover', over),
  drag: (dx, dy) => ipcRenderer.send('drag', { dx, dy }),
  contextMenu: (at) => ipcRenderer.send('context-menu', at),
  setExtraTop: (px) => ipcRenderer.send('extend', px),
});
