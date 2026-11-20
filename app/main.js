// Desktop Sidekicks (macOS): the customer's pet in a transparent, always-on-top,
// click-through window in the bottom-right corner. Pets are added with the code from the
// "is ready" email (or the desktopsidekicks://add/<CODE> link) and downloaded from
// desktopsidekicks.com into ~/Library/Application Support/Desktop Sidekicks/pets/<CODE>/.
// Window behaviour mirrors Chunky's app (src/main.js); the player is petgen/engine.
const { app, BrowserWindow, screen, ipcMain, Menu, Tray, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');

const SITE = process.env.SIDEKICKS_SITE || 'https://desktopsidekicks.com';
const WIN_W = 400;
const WIN_H = 400;
const MARGIN = 4;
const SIZES = [
  { label: 'Tiny', scale: 0.4 },
  { label: 'Small', scale: 0.6 },
  { label: 'Medium', scale: 0.8 },
  { label: 'Normal', scale: 1 },
  { label: 'Large', scale: 1.3 },
];
const ACTIONS = [
  ['Sit (Default - Mouse Tracking)', 'sit'], ['Lie down', 'lie'], ['Sleep (Pause)', 'sleep'], ['Stand up', 'stand'],
  ['Happy wiggle', 'wag'], ['Puppy eyes', 'puppy'], ['Bark', 'bark'], ['Poop', 'poop'],
];

let win = null;          // the pet
let addWin = null;       // "Add your pet"
let tray = null;
let clickThrough = null;
let extraTop = 0;
let pendingCode = null;  // from a desktopsidekicks:// link that arrived before we were ready

// ------------------------------------------------------------------ settings + pets
const petsDir = () => path.join(app.getPath('userData'), 'pets');
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings)); } catch { /* not fatal */ }
}
let settings = {};

const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(.{4})(?=.)/g, '$1-');
const validCode = (c) => /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(c);

function listPets() {
  try {
    return fs.readdirSync(petsDir())
      .filter((d) => validCode(d) && fs.existsSync(path.join(petsDir(), d, 'manifest.json')))
      .map((code) => ({ code, manifest: JSON.parse(fs.readFileSync(path.join(petsDir(), code, 'manifest.json'), 'utf8')) }));
  } catch { return []; }
}
const currentPet = () => {
  const pets = listPets();
  return pets.find((p) => p.code === settings.pet) || pets[0] || null;
};
const petName = () => (currentPet()?.manifest.name) || 'your pet';

async function addPet(code, progress = () => {}) {
  code = normCode(code);
  if (!validCode(code)) return { error: 'That code doesn\'t look right. Check it against your email.' };
  try {
    const info = await fetch(`${SITE}/api/pet/${code}?info=1`);
    const meta = await info.json().catch(() => ({}));
    if (!info.ok) return { error: meta.error || `The server said ${info.status}. Try again in a minute.` };
    progress(`Downloading ${meta.name}…`);
    const r = await fetch(`${SITE}/api/pet/${code}`);
    if (!r.ok) return { error: `Download failed (${r.status}). Try again in a minute.` };
    const zip = path.join(os.tmpdir(), `sidekick-${code}.zip`);
    fs.writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
    progress(`Unpacking ${meta.name}…`);
    const dest = path.join(petsDir(), code);
    const tmp = `${dest}.part`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    if (process.platform === 'darwin') execFileSync('ditto', ['-x', '-k', zip, tmp]);
    else execFileSync('unzip', ['-q', '-o', zip, '-d', tmp]);
    fs.rmSync(zip, { force: true });
    if (!fs.existsSync(path.join(tmp, 'manifest.json'))) throw new Error('the download was incomplete');
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
    settings.pet = code;
    saveSettings();
    showPet();
    setTimeout(() => addWin && !addWin.isDestroyed() && addWin.close(), 1600);
    return { name: meta.name };
  } catch (e) {
    return { error: `Couldn't add the pet: ${e.message}. Check your internet connection and try again.` };
  }
}

// ------------------------------------------------------------------ pet window
const winSize = () => {
  const k = settings.scale || 1;
  return [Math.round(WIN_W * k), Math.round(WIN_H * k) + extraTop];
};
function cornerPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  const [w, h] = winSize();
  return [Math.round(workArea.x + workArea.width - w - MARGIN), Math.round(workArea.y + workArea.height - h)];
}
function applySize() {
  if (!win) return;
  const b = win.getBounds();
  const [w, h] = winSize();
  win.setResizable(true);
  win.setBounds({ x: b.x + b.width - w, y: b.y + b.height - h, width: w, height: h });
  win.setResizable(false);
}
function setScale(scale) {
  settings.scale = scale;
  saveSettings();
  applySize();
  refreshMenus();
}
function setClickThrough(on) {
  if (!win || clickThrough === on) return;
  clickThrough = on;
  win.setIgnoreMouseEvents(on, { forward: true });
}

function showPet() {
  const pet = currentPet();
  if (!pet) return showAdd();
  if (win && !win.isDestroyed()) win.destroy();   // switching pets: a fresh window with the new footage
  clickThrough = null;
  extraTop = 0;
  const [x, y] = cornerPosition();
  const [width, height] = winSize();
  win = new BrowserWindow({
    width, height, x, y,
    transparent: true, frame: false, resizable: false, hasShadow: false, skipTaskbar: true,
    alwaysOnTop: true, fullscreenable: false, backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'pet.html'));
  win.webContents.on('did-finish-load', () => { if (settings.playful === false) send('playful:off')(); });
  setClickThrough(true);
  const timer = setInterval(() => {
    if (!win || win.isDestroyed()) return clearInterval(timer);
    win.webContents.send('cursor', { cursor: screen.getCursorScreenPoint(), bounds: win.getBounds() });
  }, 8);
  refreshMenus();
}

ipcMain.on('pet-info', (e) => {
  const pet = currentPet();
  e.returnValue = pet
    ? { manifest: pet.manifest, assets: pathToFileURL(path.join(petsDir(), pet.code)).href + '/' }
    : { manifest: {}, assets: '' };
});
ipcMain.on('hover', (_e, over) => setClickThrough(!over));
ipcMain.on('extend', (_e, px) => {
  extraTop = Math.max(0, Math.min(800, Math.round(Number(px) || 0)));
  applySize();
});
// The pet's menu opens just above its head (macOS draws a popup downward from its top-left
// corner, so place it a menu-height above; macOS keeps it on screen near the top edge).
const MENU_W = 230, ITEM_H = 22, SEP_H = 11;
ipcMain.on('context-menu', (_e, at) => {
  if (!win) return;
  const tpl = menu();
  const opts = { window: win };
  if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) {
    const h = tpl.reduce((n, it) => n + (it.type === 'separator' ? SEP_H : ITEM_H), 10);
    opts.x = Math.round(at.x - MENU_W / 2);
    opts.y = Math.round(at.y - h - 8);
  }
  Menu.buildFromTemplate(tpl).popup(opts);
});
ipcMain.on('drag', (_e, { dx, dy }) => {
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
});

// ------------------------------------------------------------------ add-a-pet window
function showAdd(code) {
  if (addWin && !addWin.isDestroyed()) {
    addWin.show();
    addWin.focus();
    if (code) addWin.webContents.send('prefill', code);
    return;
  }
  addWin = new BrowserWindow({
    width: 440, height: 400, resizable: false, show: false, title: 'Add your pet',
    titleBarStyle: 'hiddenInset', fullscreenable: false, minimizable: false,
    webPreferences: { preload: path.join(__dirname, 'add-preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  addWin.loadFile(path.join(__dirname, 'add.html'));
  addWin.once('ready-to-show', () => {
    addWin.show();
    app.focus({ steal: true });
    if (code) addWin.webContents.send('prefill', code);
  });
  addWin.on('closed', () => {
    addWin = null;
    if (!currentPet()) app.quit();          // nothing to show yet
  });
}
ipcMain.handle('add-pet', (e, code) => addPet(code, (m) => e.sender.send('add-progress', m)));
ipcMain.on('open-site', () => shell.openExternal(SITE));
ipcMain.on('close-add', () => addWin && addWin.close());

// ------------------------------------------------------------------ menus
const send = (name) => () => win && !win.isDestroyed() && win.webContents.send('action', name);
function menu() {
  const pets = listPets();
  const name = petName();
  return [
    { label: '✕  Close menu', click: () => {} },   // clicking any item closes the menu
    { type: 'separator' },
    { label: `Feed ${name}`, click: send('feed') },
    { type: 'separator' },
    ...ACTIONS.map(([label, a]) => ({ label: (currentPet()?.manifest.labels || {})[a] || label, click: send(a) })),
    { type: 'separator' },
    {
      label: 'Size',
      submenu: SIZES.map((s) => ({
        label: s.label, type: 'radio', checked: (settings.scale || 1) === s.scale, click: () => setScale(s.scale),
      })),
    },
    {
      label: 'Playful mode', type: 'checkbox', checked: settings.playful !== false,
      click: (item) => { settings.playful = item.checked; saveSettings(); send(item.checked ? 'playful:on' : 'playful:off')(); },
    },
    { label: 'Back to corner', click: () => win && win.setPosition(...cornerPosition()) },
    { label: 'Show / hide', click: () => win && (win.isVisible() ? win.hide() : win.show()) },
    { type: 'separator' },
    ...(pets.length > 1 ? [{
      label: 'Pets',
      submenu: pets.map((p) => ({
        label: p.manifest.name || p.code, type: 'radio', checked: p.code === currentPet()?.code,
        click: () => { settings.pet = p.code; saveSettings(); showPet(); },
      })),
    }] : []),
    { label: 'Add a pet…', click: () => showAdd() },
    {
      label: 'Open at login', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: 'Quit Desktop Sidekicks', role: 'quit' },
  ];
}

function createTray() {
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
  tray.setToolTip('Desktop Sidekicks');
  refreshMenus();
}
function refreshMenus() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(menu()));
}

// ------------------------------------------------------------------ desktopsidekicks://add/<CODE>
function handleLink(url) {
  const m = /^desktopsidekicks:\/\/add\/([A-Za-z0-9-]+)/.exec(url || '');
  if (!m) return;
  if (app.isReady()) showAdd(m[1]);
  else pendingCode = m[1];
}
app.on('open-url', (e, url) => { e.preventDefault(); handleLink(url); });   // macOS
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const link = argv.find((a) => a.startsWith('desktopsidekicks://'));
    if (link) handleLink(link);
    else if (!currentPet()) showAdd();
  });
}

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();
  app.setAsDefaultProtocolClient('desktopsidekicks');
  settings = loadSettings();
  fs.mkdirSync(petsDir(), { recursive: true });
  const argLink = /^desktopsidekicks:\/\/add\/([A-Za-z0-9-]+)/.exec(process.argv.find((a) => a.startsWith('desktopsidekicks://')) || '');
  if (argLink) pendingCode = argLink[1];
  createTray();
  if (currentPet()) showPet();
  if (pendingCode || !currentPet()) showAdd(pendingCode);
});

app.on('window-all-closed', () => { /* keep running in the menu bar */ });
