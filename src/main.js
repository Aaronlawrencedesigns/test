// Main process: creates a small transparent, always-on-top window in the
// bottom-right corner and streams the global cursor position to it so the
// dog can watch the mouse anywhere on screen (not just over its own window).
const { app, BrowserWindow, screen, ipcMain, Menu, Tray, nativeImage } = require('electron');
const path = require('path');

const WIN_W = 240;
const WIN_H = 240;
const MARGIN = 8;

let win;
let tray;
let clickThrough = null;

function cornerPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: Math.round(workArea.x + workArea.width - WIN_W - MARGIN),
    y: Math.round(workArea.y + workArea.height - WIN_H),
  };
}

function createWindow() {
  const { x, y } = cornerPosition();
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x,
    y,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'index.html'));
  setClickThrough(true);

  // Stream cursor position ~60fps. The renderer turns it into eye movement.
  const timer = setInterval(() => {
    if (!win || win.isDestroyed()) return clearInterval(timer);
    const cursor = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    win.webContents.send('cursor', { cursor, bounds });
  }, 16);
}

// The window is transparent but still a rectangle. Let clicks pass through to
// whatever is behind it, except when the cursor is over the dog itself (the
// renderer tells us via 'hover').
function setClickThrough(on) {
  if (!win || clickThrough === on) return;
  clickThrough = on;
  win.setIgnoreMouseEvents(on, { forward: true });
}

ipcMain.on('hover', (_e, overDog) => setClickThrough(!overDog));

ipcMain.on('context-menu', () => {
  Menu.buildFromTemplate([
    { label: 'Back to corner', click: () => win.setPosition(...Object.values(cornerPosition())) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]).popup({ window: win });
});

// Dragging the dog around: renderer sends deltas while the mouse is held.
ipcMain.on('drag', (_e, { dx, dy }) => {
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
});

function createTray() {
  // Draw a tiny 16x16 brown dot so there's always a way to quit, even if the
  // dog is hidden behind something.
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inside = Math.hypot(x - 7.5, y - 7.5) < 7;
      buf[i] = 0x4f; buf[i + 1] = 0x8b; buf[i + 2] = 0xc9; // BGRA
      buf[i + 3] = inside ? 255 : 0;
    }
  }
  const icon = nativeImage.createFromBitmap(buf, { width: size, height: size });
  tray = new Tray(icon);
  tray.setToolTip('Desk Dog');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show dog', click: () => win.show() },
      { label: 'Hide dog', click: () => win.hide() },
      { label: 'Back to corner', click: () => win.setPosition(...Object.values(cornerPosition())) },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  createWindow();
  try { createTray(); } catch (_) { /* tray unsupported on some Linux setups */ }
});

app.on('window-all-closed', () => app.quit());
