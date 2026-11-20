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

// Several pets can be out at once: each shown pet has its own window (wins: code -> entry).
const wins = new Map();  // code -> { win, extraTop, clickThrough, timer }
let addWin = null;       // "Add your pet"
let tray = null;
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
const findPet = (code) => listPets().find((p) => p.code === code) || null;
const petName = (code) => (findPet(code)?.manifest.name) || 'your pet';
// which pets are out on the desktop (older settings had one `pet`; default: the first pet)
function shownCodes() {
  const have = listPets().map((p) => p.code);
  if (!Array.isArray(settings.shown)) settings.shown = [settings.pet && have.includes(settings.pet) ? settings.pet : have[0]].filter(Boolean);
  return settings.shown.filter((c) => have.includes(c));
}
// per-pet size + Playful Mode (older settings kept one of each for the only pet)
function petPrefs(code) {
  settings.petPrefs = settings.petPrefs || {};
  if (!settings.petPrefs[code]) settings.petPrefs[code] = { scale: settings.scale || 1, playful: settings.playful !== false };
  return settings.petPrefs[code];
}

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
    const shown = shownCodes();
    if (!shown.includes(code)) settings.shown = [...shown, code];   // a new pet joins the others
    saveSettings();
    showPet(code);   // (re-adding a pet that's out reloads it with the fresh footage)
    setTimeout(() => addWin && !addWin.isDestroyed() && addWin.close(), 1600);
    return { name: meta.name };
  } catch (e) {
    return { error: `Couldn't add the pet: ${e.message}. Check your internet connection and try again.` };
  }
}

// ------------------------------------------------------------------ pet windows
const GAP = 8;
const winSize = (code) => {
  const k = petPrefs(code).scale || 1;
  const extra = wins.get(code)?.extraTop || 0;
  return [Math.round(WIN_W * k), Math.round(WIN_H * k) + extra];
};
// each shown pet has its own spot along the bottom: the first in the corner, the next to its left, ...
function cornerPosition(code) {
  const { workArea } = screen.getPrimaryDisplay();
  let right = workArea.x + workArea.width - MARGIN;
  for (const c of shownCodes()) {
    if (c === code) break;
    right -= Math.round(WIN_W * (petPrefs(c).scale || 1)) + GAP;
  }
  const [w, h] = winSize(code);
  return [Math.round(right - w), Math.round(workArea.y + workArea.height - h)];
}
function applySize(code) {
  const e = wins.get(code);
  if (!e || e.win.isDestroyed()) return;
  const b = e.win.getBounds();
  const [w, h] = winSize(code);
  e.win.setResizable(true);
  e.win.setBounds({ x: b.x + b.width - w, y: b.y + b.height - h, width: w, height: h });
  e.win.setResizable(false);
}
function setScale(code, scale) {
  petPrefs(code).scale = scale;
  saveSettings();
  applySize(code);
  refreshMenus();
}
function setClickThrough(code, on) {
  const e = wins.get(code);
  if (!e || e.win.isDestroyed() || e.clickThrough === on) return;
  e.clickThrough = on;
  e.win.setIgnoreMouseEvents(on, { forward: true });
}
function closePet(code) {
  const e = wins.get(code);
  if (!e) return;
  clearInterval(e.timer);
  wins.delete(code);
  if (!e.win.isDestroyed()) e.win.destroy();
}
function setShown(code, on) {
  const shown = shownCodes().filter((c) => c !== code);
  settings.shown = on ? [...shown, code] : shown;
  saveSettings();
  if (on) showPet(code);
  else closePet(code);
  refreshMenus();
}

function showPet(code) {
  if (!findPet(code)) return;
  closePet(code);   // re-showing a pet: a fresh window with its current footage
  const e = { win: null, extraTop: 0, clickThrough: null, timer: null };
  wins.set(code, e);
  const [x, y] = cornerPosition(code);
  const [width, height] = winSize(code);
  const win = new BrowserWindow({
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
  e.win = win;
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'pet.html'));
  win.webContents.on('did-finish-load', () => { if (petPrefs(code).playful === false) send(code, 'playful:off')(); });
  setClickThrough(code, true);
  e.timer = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(e.timer);
    win.webContents.send('cursor', { cursor: screen.getCursorScreenPoint(), bounds: win.getBounds() });
  }, 8);
  refreshMenus();
}
function showAllPets() {
  for (const code of shownCodes()) showPet(code);
}

// which pet a message came from
const codeOf = (sender) => [...wins.entries()].find(([, e]) => !e.win.isDestroyed() && e.win.webContents === sender)?.[0];

ipcMain.on('pet-info', (ev) => {
  const pet = findPet(codeOf(ev.sender));
  ev.returnValue = pet
    ? { manifest: pet.manifest, assets: pathToFileURL(path.join(petsDir(), pet.code)).href + '/' }
    : { manifest: {}, assets: '' };
});
ipcMain.on('hover', (ev, over) => { const c = codeOf(ev.sender); if (c) setClickThrough(c, !over); });
ipcMain.on('extend', (ev, px) => {
  const c = codeOf(ev.sender);
  if (!c) return;
  wins.get(c).extraTop = Math.max(0, Math.min(800, Math.round(Number(px) || 0)));
  applySize(c);
});
// The pet's menu opens just above its head (macOS draws a popup downward from its top-left
// corner, so place it a menu-height above; macOS keeps it on screen near the top edge).
const MENU_W = 230, ITEM_H = 22, SEP_H = 11;
ipcMain.on('context-menu', (ev, at) => {
  const c = codeOf(ev.sender);
  if (!c) return;
  const tpl = petMenu(c);
  const opts = { window: wins.get(c).win };
  if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) {
    const h = tpl.reduce((n, it) => n + (it.type === 'separator' ? SEP_H : ITEM_H), 10);
    opts.x = Math.round(at.x - MENU_W / 2);
    opts.y = Math.round(at.y - h - 8);
  }
  Menu.buildFromTemplate(tpl).popup(opts);
});
ipcMain.on('drag', (ev, { dx, dy }) => {
  const c = codeOf(ev.sender);
  if (!c) return;
  const w = wins.get(c).win;
  const [x, y] = w.getPosition();
  w.setPosition(Math.round(x + dx), Math.round(y + dy));
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
    if (!listPets().length) app.quit();     // nothing to show yet
  });
}
ipcMain.handle('add-pet', (e, code) => addPet(code, (m) => e.sender.send('add-progress', m)));
ipcMain.on('open-site', () => shell.openExternal(SITE));
ipcMain.on('close-add', () => addWin && addWin.close());

// ------------------------------------------------------------------ menus
const send = (code, name) => () => { const e = wins.get(code); if (e && !e.win.isDestroyed()) e.win.webContents.send('action', name); };
// this pet's own items: feed, tricks, size, Playful Mode, corner, hide
function petItems(code) {
  const pet = findPet(code);
  const name = petName(code);
  const prefs = petPrefs(code);
  const several = listPets().length > 1;
  return [
    { label: `Feed ${name}`, click: send(code, 'feed') },
    { type: 'separator' },
    ...ACTIONS.map(([label, a]) => ({ label: (pet?.manifest.labels || {})[a] || label, click: send(code, a) })),
    { type: 'separator' },
    {
      label: 'Size',
      submenu: SIZES.map((s) => ({
        label: s.label, type: 'radio', checked: (prefs.scale || 1) === s.scale, click: () => setScale(code, s.scale),
      })),
    },
    {
      label: 'Playful Mode (Do Random Tricks)',
      submenu: [['On', true], ['Off', false]].map(([label, on]) => ({
        label, type: 'radio', checked: (prefs.playful !== false) === on,
        click: () => { prefs.playful = on; saveSettings(); send(code, on ? 'playful:on' : 'playful:off')(); },
      })),
    },
    { label: 'Back to corner', click: () => { const e = wins.get(code); if (e && !e.win.isDestroyed()) e.win.setPosition(...cornerPosition(code)); } },
    several
      ? { label: `Hide ${name}`, click: () => setShown(code, false) }
      : { label: 'Show / hide', click: () => { const e = wins.get(code); if (e && !e.win.isDestroyed()) (e.win.isVisible() ? e.win.hide() : e.win.show()); } },
  ];
}
// app-wide items: which pets are out, add a pet, login, quit
function appItems() {
  const pets = listPets();
  const shown = shownCodes();
  return [
    ...(pets.length > 1 ? [{
      label: 'Pets on desktop',
      submenu: pets.map((p) => ({
        label: p.manifest.name || p.code, type: 'checkbox', checked: shown.includes(p.code),
        click: (item) => setShown(p.code, item.checked),
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
// right-click / Menu pill on a pet: that pet's items, then the app's
function petMenu(code) {
  return [
    { label: '✕  Close menu', click: () => {} },   // clicking any item closes the menu
    { type: 'separator' },
    ...petItems(code),
    { type: 'separator' },
    ...appItems(),
  ];
}
// menu-bar icon: one pet out -> its menu as before; several -> a submenu per pet
function trayMenu() {
  const shown = shownCodes();
  if (shown.length === 1) return petMenu(shown[0]);
  return [
    { label: '✕  Close menu', click: () => {} },
    { type: 'separator' },
    ...shown.map((c) => ({ label: petName(c), submenu: petItems(c) })),
    ...(shown.length ? [{ type: 'separator' }] : []),
    ...appItems(),
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
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(trayMenu()));
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
    else if (!listPets().length) showAdd();
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
  showAllPets();
  if (pendingCode || !listPets().length) showAdd(pendingCode);
});

app.on('window-all-closed', () => { /* keep running in the menu bar */ });
