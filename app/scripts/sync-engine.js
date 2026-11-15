// Copies the product's pet player (petgen/engine) into the app before running or building.
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', '..', 'petgen', 'engine');
const dst = path.join(__dirname, '..', 'renderer');
for (const f of ['app.js', 'style.css']) fs.copyFileSync(path.join(src, f), path.join(dst, f));
console.log('player synced from petgen/engine');
