// Make sure Electron's app binary is present after `npm install`.
// 1) Run Electron's own installer.  2) If that silently didn't install it (seen
// with newer npm/Node versions), download the official release zip from GitHub
// and unpack it with macOS's `ditto`, which keeps the .app bundle intact.
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = path.join(__dirname, '..', 'node_modules', 'electron');
const pathTxt = path.join(dir, 'path.txt');
const installed = () => fs.existsSync(pathTxt) && fs.existsSync(path.join(dir, 'dist', fs.readFileSync(pathTxt, 'utf8')));

if (!fs.existsSync(dir)) process.exit(0);
spawnSync(process.execPath, [path.join(dir, 'install.js')], { stdio: 'inherit' });
if (installed()) process.exit(0);
if (process.platform !== 'darwin') {
  console.error('Electron did not install; delete node_modules/electron and run npm install again.');
  process.exit(1);
}

const version = require(path.join(dir, 'package.json')).version;
const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';
const url = `https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-darwin-${arch}.zip`;
const zip = path.join(os.tmpdir(), `electron-v${version}-darwin-${arch}.zip`);
console.log(`Downloading Electron ${version} (${arch})…`);
execFileSync('curl', ['-L', '--fail', '-o', zip, url], { stdio: 'inherit' });
fs.rmSync(path.join(dir, 'dist'), { recursive: true, force: true });
fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
execFileSync('ditto', ['-x', '-k', zip, path.join(dir, 'dist')], { stdio: 'inherit' });
fs.writeFileSync(pathTxt, 'Electron.app/Contents/MacOS/Electron');
console.log('Electron installed.');
