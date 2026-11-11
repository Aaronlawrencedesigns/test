// Main process (macOS): a transparent, always-on-top window in the
// bottom-right corner. Streams the global cursor position to the renderer so
// Chunky can watch the mouse anywhere on screen.
const { app, BrowserWindow, screen, ipcMain, Menu, Tray, nativeImage } = require('electron');
const path = require('path');

const WIN_W = 400; // 4:3, matches the 640x480 footage
const WIN_H = 300;
const MARGIN = 4;

let win;
let tray;
let clickThrough = null;

function cornerPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  return [
    Math.round(workArea.x + workArea.width - WIN_W - MARGIN),
    Math.round(workArea.y + workArea.height - WIN_H),
  ];
}

function createWindow() {
  const [x, y] = cornerPosition();
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
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep animating when another app is focused
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'index.html'));
  setClickThrough(true);

  const timer = setInterval(() => {
    if (!win || win.isDestroyed()) return clearInterval(timer);
    win.webContents.send('cursor', { cursor: screen.getCursorScreenPoint(), bounds: win.getBounds() });
  }, 16);
}

// The window is a transparent rectangle; let clicks fall through to the apps
// underneath except when the cursor is actually over Chunky.
function setClickThrough(on) {
  if (!win || clickThrough === on) return;
  clickThrough = on;
  win.setIgnoreMouseEvents(on, { forward: true });
}

const send = (name) => () => win && win.webContents.send('action', name);

function actionMenu() {
  return [
    { label: 'Sit', click: send('sit') },
    { label: 'Lie down', click: send('lie') },
    { label: 'Sleep', click: send('sleep') },
    { label: 'Happy wiggle', click: send('wag') },
    { label: 'Puppy eyes', click: send('puppy') },
    { label: 'Bark', click: send('bark') },
    { label: 'Poop', click: send('poop') },
    { type: 'separator' },
    { label: 'Back to corner', click: () => win.setPosition(...cornerPosition()) },
    { label: 'Show / hide', click: () => (win.isVisible() ? win.hide() : win.show()) },
    { type: 'separator' },
    { label: 'Quit Chunky', role: 'quit' },
  ];
}

ipcMain.on('hover', (_e, overDog) => setClickThrough(!overDog));
ipcMain.on('context-menu', () => Menu.buildFromTemplate(actionMenu()).popup({ window: win }));
ipcMain.on('drag', (_e, { dx, dy }) => {
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
});

function createTray() {
  // Small paw print drawn into a template image (adapts to light/dark menu bar)
  const size = 18;
  const buf = Buffer.alloc(size * size * 4);
  const blobs = [[9, 12, 4.2], [4.2, 7.5, 2], [7.3, 4.6, 2], [10.7, 4.6, 2], [13.8, 7.5, 2]];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = blobs.some(([cx, cy, r]) => Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < r);
      buf[(y * size + x) * 4 + 3] = inside ? 255 : 0;
    }
  }
  const icon = nativeImage.createFromBitmap(buf, { width: size, height: size });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Chunky');
  tray.setContextMenu(Menu.buildFromTemplate(actionMenu()));
}

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();
  createWindow();
  createTray();
});

app.on('window-all-closed', () => app.quit());
