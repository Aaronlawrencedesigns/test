// Main process (macOS): a transparent, always-on-top window in the
// bottom-right corner. Streams the global cursor position to the renderer so
// Chunky can watch the mouse anywhere on screen.
const { app, BrowserWindow, screen, ipcMain, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const WIN_W = 400; // square, matches the 640x640 footage (at "Normal" size)
const WIN_H = 400;
const MARGIN = 4;
const SIZES = [
  { label: 'Tiny', scale: 0.4 },
  { label: 'Small', scale: 0.6 },
  { label: 'Medium', scale: 0.8 },
  { label: 'Normal', scale: 1 },
  { label: 'Large', scale: 1.3 },
];

let win;
let tray;
let clickThrough = null;

// ---- remembered settings (size) ----
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function saveSettings(s) {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(s)); } catch { /* not fatal */ }
}
let settings = {};
const winSize = () => {
  const k = settings.scale || 1;
  return [Math.round(WIN_W * k), Math.round(WIN_H * k)];
};

function cornerPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  const [w, h] = winSize();
  return [
    Math.round(workArea.x + workArea.width - w - MARGIN),
    Math.round(workArea.y + workArea.height - h),
  ];
}

// Resize around the bottom-right corner, so he stays put on his "floor".
function setScale(scale) {
  settings.scale = scale;
  saveSettings(settings);
  if (win) {
    const b = win.getBounds();
    const [w, h] = winSize();
    win.setResizable(true);
    win.setBounds({ x: b.x + b.width - w, y: b.y + b.height - h, width: w, height: h });
    win.setResizable(false);
  }
  refreshTrayMenu();
}

function createWindow() {
  const [x, y] = cornerPosition();
  const [width, height] = winSize();
  win = new BrowserWindow({
    width,
    height,
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
  }, 8); // ~120 Hz, so head-tracking keeps up on ProMotion displays
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
    { label: 'Stand up', click: send('stand') },
    { label: 'Happy wiggle', click: send('wag') },
    { label: 'Puppy eyes', click: send('puppy') },
    { label: 'Bark', click: send('bark') },
    { label: 'Poop', click: send('poop') },
    { type: 'separator' },
    {
      label: 'Size',
      submenu: SIZES.map((s) => ({
        label: s.label,
        type: 'radio',
        checked: (settings.scale || 1) === s.scale,
        click: () => setScale(s.scale),
      })),
    },
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
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(actionMenu()));
}

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();
  settings = loadSettings();
  createWindow();
  createTray();
});

app.on('window-all-closed', () => app.quit());
