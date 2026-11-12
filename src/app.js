// Chunky: realistic footage edition.
//
// Sitting & watching: blends the 4 nearest images of a 5x3 grid of head
// directions (assets/gaze/{col}_{row}.webp) so his head follows the cursor.
// Everything else plays transparent video clips (assets/clips/*.webm) that
// start and end on shared keyframes, so they chain seamlessly.
(() => {
  const api = window.dogApi;
  const $ = (id) => document.getElementById(id);
  const canvas = $('dog');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const gazeCanvas = document.createElement('canvas');
  const gctx = gazeCanvas.getContext('2d');
  // What the head-tracking showed when the last head change began; each new
  // change fades from exactly this, so fast mouse moves never pop.
  const gazeFrom = document.createElement('canvas');
  const gfctx = gazeFrom.getContext('2d');
  const GAZE_FADE_MS = 160;
  // Snapshot of the last frame shown before a cut; faded out over the new
  // picture so clip boundaries never pop even if the AI frames differ slightly.
  const fadeCanvas = document.createElement('canvas');
  const fctx = fadeCanvas.getContext('2d');
  const FADE_MS = 280;
  let fadeStart = -1e9;
  let dogLayer = null; // what was drawn last frame (for snapshots)

  // Where his head and the ground are inside the 640x640 asset frame (0..1)
  const HEAD = { x: 0.5, y: 0.44 };
  const GROUND_Y = 0.96;
  // Chunky lives in the square at the BOTTOM of the window. The window can be
  // taller than that (it grows upward while the food tray is open).
  const SZ = () => window.innerWidth;
  const stageTop = () => Math.max(0, window.innerHeight - window.innerWidth);
  const EAR_TOP = 0.30;   // top of his ears when sitting, in the square (0..1)
  const SHADOW_W = { sit: 0.19, lie: 0.36, sleep: 0.36 };

  // Clip graph: every clip goes from one resting state to another.
  const CLIPS = {
    wag:         { from: 'sit', to: 'sit', say: '♥' },
    bark:        { from: 'sit', to: 'sit', say: () => pick(['Woof!', 'Arf!', 'Boof!']) },
    puppy:       { from: 'sit', to: 'sit', say: '🥺' },
    poop:        { from: 'sit', to: 'sit', say: '💩 …oops', sayAt: 0.6 },
    lie_down:    { from: 'sit', to: 'lie' },
    get_up:      { from: 'lie', to: 'sit' },
    fall_asleep: { from: 'lie', to: 'sleep' },
    sleep_loop:  { from: 'sleep', to: 'sleep', loop: true },
    wake_up:     { from: 'sleep', to: 'sit', say: '!', sayAt: 0.3 },
    stand:       { from: 'sit', to: 'sit' },   // stands up on his hind legs
    eat:         { from: 'sit', to: 'sit' },   // chews, swallows, licks his lips
  };
  // How to get from one resting state to another
  const ROUTES = { 'lie>sit': 'get_up', 'sit>lie': 'lie_down', 'lie>sleep': 'fall_asleep', 'sleep>sit': 'wake_up' };

  // Where the footage lives (the web version sets window.CHUNKY_ASSETS).
  const ASSETS = window.CHUNKY_ASSETS || '../assets/';
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const rand = (a, b) => a + Math.random() * (b - a);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------ assets
  const loadImg = (src) => new Promise((res) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = src;
  });
  const gaze = [];
  // Head-tracking frames (tools/build_look_frames.py): real video frames only,
  // rows = head heights top->bottom, cols = far left -> far right. Exactly one
  // is shown at a time, so there is never a blended/ghosted in-between.
  // Regenerating them? Update this from assets/look/meta.json.
  const LOOK = {"rows": 5, "cols": 33, "x": 162, "y": 191, "w": 317, "h": 425, "frame": 640};
  const look = Array.from({ length: LOOK.rows }, () => []);
  const stills = {};
  const videos = {};

  async function loadAssets() {
    const jobs = [];
    for (let r = 0; r < 3; r++) {
      gaze[r] = [];
      for (let c = 0; c < 5; c++) jobs.push(loadImg(`${ASSETS}gaze/${c}_${r}.webp`).then((im) => (gaze[r][c] = im)));
    }
    for (const n of ['sit', 'lie', 'sleep']) jobs.push(loadImg(`${ASSETS}stills/${n}.webp`).then((im) => (stills[n] = im)));
    // tracking frames load in the background; the 5x3 grid is used until they're ready
    const lj = [];
    for (let r = 0; r < LOOK.rows; r++) for (let i = 0; i < LOOK.cols; i++) lj.push(loadImg(`${ASSETS}look/${r}_${i}.webp`).then((im) => (look[r][i] = im)));
    Promise.all(lj).then(() => { S.sweepReady = look.every((row) => row.length === LOOK.cols && row.every(Boolean)); });
    await Promise.all(jobs);
    for (const name of Object.keys(CLIPS)) {
      const v = document.createElement('video');
      v.src = `${ASSETS}clips/${name}.webm`;
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.loop = !!CLIPS[name].loop;
      v.addEventListener('error', () => (CLIPS[name].missing = true));
      videos[name] = v;
    }
  }

  // ------------------------------------------------------------- state
  const S = {
    rest: 'sit',          // resting state: sit | lie | sleep
    clip: null,           // name of clip playing
    busy: false,
    cursor: { x: -1e4, y: -1e4 },
    lastMoveAt: performance.now(),
    over: false,
    dragging: false,
    dragMoved: 0,
    u: 2, v: 1,           // current gaze grid position (smoothed)
    gc: 2, gr: 1,         // grid cell shown
    cellAt: 0,
    centerGaze: false,
  };

  // ------------------------------------------------------------ bubble
  const bubble = $('bubble');
  let bubbleTimer;
  function say(text, ms = 1300) {
    if (!text) return;
    bubble.textContent = typeof text === 'function' ? text() : text;
    bubble.classList.add('show');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.remove('show'), ms);
  }
  const zzz = $('zzz');

  // ------------------------------------------------------------- clips
  function playClip(name) {
    const meta = CLIPS[name];
    const v = videos[name];
    if (!v || meta.missing) return Promise.resolve(false);
    return new Promise(async (resolve) => {
      // Let his head swing back to centre first so the cut into the clip is invisible.
      if (S.rest === 'sit' && !S.clip) {
        S.centerGaze = true;
        const t0 = performance.now();
        while ((Math.abs(S.u - 2) > 0.06 || Math.abs(S.v - 1) > 0.06 || performance.now() - S.cellAt < GAZE_FADE_MS + 20) && performance.now() - t0 < 700) await wait(16);
      }
      v.currentTime = 0;
      try { await v.play(); } catch (err) { console.warn('clip failed', name, err); S.centerGaze = false; return resolve(false); }
      snapshot();
      S.clip = name;
      S.centerGaze = false;
      if (meta.say) setTimeout(() => say(meta.say), (meta.sayAt || 0.15) * v.duration * 1000);
      if (meta.loop) return resolve(true);
      v.onended = () => {
        v.onended = null;
        snapshot();
        S.rest = meta.to;
        S.clip = null;
        resolve(true);
      };
    });
  }

  function snapshot() {
    fctx.clearRect(0, 0, fadeCanvas.width, fadeCanvas.height);
    if (dogLayer) fctx.drawImage(dogLayer, 0, 0, fadeCanvas.width, fadeCanvas.height);
    fadeStart = performance.now();
  }

  function stopLoop() {
    if (S.clip && CLIPS[S.clip].loop) {
      snapshot();
      videos[S.clip].pause();
      S.clip = null;
    }
  }

  async function goTo(state) {
    stopLoop();
    let guard = 0;
    while (S.rest !== state && guard++ < 4) {
      let route = ROUTES[`${S.rest}>${state}`];
      if (!route) route = S.rest === 'sleep' ? 'wake_up' : S.rest === 'lie' ? 'get_up' : 'lie_down';
      if (!(await playClip(route))) S.rest = CLIPS[route].to; // missing clip: just jump
    }
    if (S.rest === 'sleep') { zzz.classList.add('show'); playClip('sleep_loop'); } else zzz.classList.remove('show');
  }

  async function act(name, fromUser = true) {
    if (S.busy) {
      if (fromUser) S.pending = name; // remember the latest request, run it next
      return;
    }
    S.busy = true;
    try {
      if (fromUser) S.lastMoveAt = performance.now();   // only YOUR activity resets the nap timer
      if (name === 'sit' || name === 'lie' || name === 'sleep') await goTo(name);
      else if (name.startsWith('eat:')) {
        await goTo('sit');
        await eat(name.slice(4));
      } else {
        await goTo(CLIPS[name].from);
        await playClip(name);
      }
    } finally {
      S.busy = false;
    }
    if (S.pending) {
      const next = S.pending;
      S.pending = null;
      act(next);
    }
  }

  // --------------------------------------------------------- autonomy
  // No mouse movement for NAP_AFTER_MS: he lies down and falls asleep, and stays
  // asleep until the mouse moves again. His little tricks only happen while
  // you're around (mouse moved recently).
  const NAP_AFTER_MS = 30000;
  let nextIdleAt = performance.now() + rand(15000, 30000);
  function autonomy(now) {
    if (S.busy || S.dragging || S.noAuto || S.food) return;
    const idle = now - S.lastMoveAt;
    if (idle > NAP_AFTER_MS) {
      if (S.rest !== 'sleep') { S.napping = true; act('sleep', false); }
      return;
    }
    if (S.rest === 'sleep' || now < nextIdleAt) return;
    nextIdleAt = now + rand(20000, 45000);
    if (S.rest === 'lie') { act('sit', false); return; }
    // (no barking on his own: bark only plays when chosen from the menu)
    const r = Math.random();
    if (r < 0.03) act('poop', false);
    else if (r < 0.35) act('wag', false);
    else if (r < 0.55) act('puppy', false);
    else if (r < 0.7) act('stand', false);
    else act('lie', false);
  }

  // ------------------------------------------------------------ input
  api.onCursor(({ cursor, bounds }) => {
    const now = performance.now();
    const prev = S.screenCursor;
    const moved = !prev || prev.x !== cursor.x || prev.y !== cursor.y;
    if (S.dragging && prev && moved) {
      const dx = cursor.x - prev.x, dy = cursor.y - prev.y;
      S.dragMoved += Math.abs(dx) + Math.abs(dy);
      if (S.dragMoved > 4) api.drag(dx, dy);
    }
    S.screenCursor = cursor;
    if (moved) {
      S.lastMoveAt = now;
      // Mouse moved: wake him from a nap (even if he's still settling down; the
      // wake-up is queued). If you chose Sleep yourself, he stays asleep until
      // you pick something else.
      if ((S.rest === 'sleep' || S.napping) && !S.dragging && !S.stayAsleep) {
        S.napping = false;
        act('sit');
      }
    }
    const sx = bounds.width / window.innerWidth;
    const sy = bounds.height / window.innerHeight;
    S.cursor.x = (cursor.x - bounds.x) / sx;
    S.cursor.y = (cursor.y - bounds.y) / sy;

    // Click-through everywhere except on Chunky's pixels.
    let over = false;
    const { x, y } = S.cursor;
    const yc = y - stageTop();   // y inside his square
    if (x >= 0 && yc >= 0 && x < SZ() && yc < SZ()) {
      const d = window.devicePixelRatio || 1;
      over = ctx.getImageData(Math.floor(x * d), Math.floor(yc * d), 1, 1).data[3] > 40;
    }
    const overTray = trayOpen() && inRect(tray.getBoundingClientRect(), x, y, 6);
    S.overDog = over;
    if (overTray || S.food) over = true;   // the tray and a food you're holding stay clickable
    if (over !== S.over) {
      S.over = over;
      api.setHover(over || S.dragging);
    }
  });

  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !S.over || S.food || (e.target.closest && e.target.closest('#tray'))) return;
    S.dragging = true;
    S.dragMoved = 0;
    api.setHover(true);
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button !== 0 || !S.dragging) return;
    S.dragging = false;
    api.setHover(S.over);
    if (S.dragMoved > 4) return say('Wheee!', 900);
    S.lastMoveAt = performance.now();
    if (S.stayAsleep) return say('zzz…', 1100);
    if (S.rest === 'sleep' || S.rest === 'lie') act('sit');
    else act(pick(['wag', 'puppy', 'stand']));
  });
  window.addEventListener('contextmenu', (e) => { e.preventDefault(); api.contextMenu(); });
  api.onAction((name) => {
    S.napping = false;
    if (name === 'feed') return showTray();
    S.stayAsleep = name === 'sleep'; // chosen sleep lasts until another action is chosen
    act(name);
  });


  // ----------------------------------------------------------- feeding
  // A tray of foods (menu: Feed Chunky). Drag one onto him: he eats it in
  // three bites, chews and licks his lips (eat clip), then does a happy wiggle.
  const tray = $('tray');
  const held = $('held');
  const FOODS = ['🍩', '🌭', '🧁', '🍕', '🍔'];
  const CRUMBS = {
    '🍩': ['#8a5a3b', '#f4a7c1', '#f7d774'], '🌭': ['#c97b4a', '#e8b04b', '#c0392b'],
    '🧁': ['#f6e7b0', '#f19cc0', '#7ec8e3'], '🍕': ['#f2c14e', '#c0392b', '#e9a23b'],
    '🍔': ['#c58b52', '#5c3a21', '#7cb342'],
  };
  const MOUTH = { x: 0.5, y: 0.54 };   // in the 640x640 frame, sitting
  tray.innerHTML = FOODS.map((f) => `<span class="food" data-food="${f}" role="button" aria-label="Drag to feed Chunky">${f}</span>`).join('');
  const inRect = (r, x, y, pad = 0) => x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
  const trayOpen = () => tray.classList.contains('show');
  let trayTimer;
  function showTray(on = !trayOpen()) {
    tray.classList.toggle('show', on);
    clearTimeout(trayTimer);
    if (on) keepTray();
    fitTray();
  }
  // The tray stands on top of his head; ask for just enough extra window
  // height above his square to fit it (0 when it's closed).
  let extraAsked = -1;
  function fitTray() {
    const need = trayOpen() ? Math.ceil(tray.offsetHeight + 14 - EAR_TOP * SZ()) : 0;
    const px = Math.max(0, need);
    if (Math.abs(px - extraAsked) > 1) { extraAsked = px; api.setExtraTop && api.setExtraTop(px); }
  }
  function keepTray() {   // the tray tucks itself away after a quiet minute
    clearTimeout(trayTimer);
    trayTimer = setTimeout(() => { if (!S.food) showTray(false); }, 60000);
  }
  function placeHeld(x, y) { held.style.left = `${x}px`; held.style.top = `${y}px`; }

  tray.addEventListener('mousedown', (e) => {
    const f = e.target.closest('.food');
    if (!f || e.button !== 0) return;
    e.preventDefault();
    S.food = f.dataset.food;
    S.foodFrom = f.getBoundingClientRect();
    held.textContent = S.food;
    held.style.transition = 'none';
    held.style.transform = 'translate(-50%, -50%) scale(1)';
    placeHeld(e.clientX, e.clientY);
    held.classList.add('show');
    f.classList.add('taken');
    S.lastMoveAt = performance.now();
    keepTray();
    api.setHover(true);
  });
  window.addEventListener('mousemove', (e) => { if (S.food && !S.eating) placeHeld(e.clientX, e.clientY); });
  window.addEventListener('mouseup', (e) => {
    if (!S.food || e.button !== 0 || S.eating) return;
    const { x, y } = S.cursor;
    const W = SZ();
    const nearMouth = Math.hypot(x - MOUTH.x * W, y - (stageTop() + MOUTH.y * W)) < 0.2 * W;
    if (S.overDog || nearMouth) {
      S.eating = true;
      S.stayAsleep = false;
      act(`eat:${S.food}`);
    } else {
      // missed him: the food floats back to the tray
      const r = S.foodFrom, food = S.food;
      held.style.transition = 'left .35s ease, top .35s ease, transform .35s ease';
      placeHeld(r.left + r.width / 2, r.top + r.height / 2);
      held.style.transform = 'translate(-50%, -50%) scale(.8)';
      setTimeout(() => { held.classList.remove('show'); tray.querySelector(`[data-food="${food}"]`)?.classList.remove('taken'); }, 360);
      S.food = null;
      api.setHover(S.over);
    }
  });

  function crumbs(food, x, y) {
    const colors = CRUMBS[food] || ['#c58b52'];
    for (let i = 0; i < 7; i++) {
      const c = document.createElement('i');
      c.className = 'crumb';
      c.style.left = `${x + rand(-10, 10)}px`;
      c.style.top = `${y + rand(-4, 6)}px`;
      c.style.background = pick(colors);
      c.style.setProperty('--dx', `${rand(-26, 26)}px`);
      c.style.setProperty('--dy', `${rand(18, 46)}px`);
      document.body.appendChild(c);
      setTimeout(() => c.remove(), 800);
    }
  }

  async function eat(food) {
    const W = SZ();
    const mx = MOUTH.x * W, my = stageTop() + MOUTH.y * W;
    // look straight at you, then the food goes to his mouth
    S.centerGaze = true;
    held.style.transition = 'left .3s ease, top .3s ease, transform .3s ease';
    placeHeld(mx, my);
    await wait(330);
    for (const k of [0.66, 0.33, 0]) {          // three bites
      held.style.transform = `translate(-50%, -50%) scale(${k})`;
      crumbs(food, mx, my);
      say(pick(['nom!', 'nom nom', 'mmm!']), 450);
      await wait(360);
    }
    held.classList.remove('show');
    tray.querySelector(`[data-food="${food}"]`)?.classList.remove('taken');
    S.food = null;
    S.eating = false;
    S.centerGaze = false;
    api.setHover(S.over);
    keepTray();
    await playClip('eat');                          // chew, swallow, lick lips
    await playClip('wag');                          // happy wiggle
  }

  // ----------------------------------------------------------- render
  function resize() {
    const d = window.devicePixelRatio || 1;
    canvas.width = Math.round(SZ() * d);
    canvas.height = Math.round(SZ() * d);
    gazeCanvas.width = fadeCanvas.width = gazeFrom.width = canvas.width;
    gazeCanvas.height = fadeCanvas.height = gazeFrom.height = canvas.height;
  }
  window.addEventListener('resize', () => { resize(); fitTray(); });
  resize();

  function drawShadow(w) {
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H * GROUND_Y;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, W * w);
    g.addColorStop(0, 'rgba(0,0,0,0.28)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, 0.12);
    ctx.translate(-cx, -cy);
    ctx.fillStyle = g;
    ctx.fillRect(0, cy - W * w, W, W * w * 2);
    ctx.restore();
  }

  function drawGaze(t) {
    // target grid position from the cursor's direction relative to his head
    const W = SZ();
    let tu = 2, tv = 1;
    if (!S.centerGaze) {
      const dx = S.cursor.x - HEAD.x * W;
      const dy = S.cursor.y - (stageTop() + HEAD.y * W);
      tu = 2 + 2 * Math.tanh(dx / 380);
      tv = 1 + Math.tanh(dy / 260);
    }
    // Critically damped spring: snappy start, settles without overshoot.
    const dt = Math.min(0.05, (t - (S.lastGazeT || t)) / 1000);
    S.lastGazeT = t;
    const w = S.centerGaze ? 30 : 24;           // stiffness (higher = snappier)
    S.vu = (S.vu || 0) + (w * w * (tu - S.u) - 2 * w * (S.vu || 0)) * dt;
    S.vv = (S.vv || 0) + (w * w * (tv - S.v) - 2 * w * (S.vv || 0)) * dt;
    S.u = Math.min(4, Math.max(0, S.u + S.vu * dt));
    S.v = Math.min(2, Math.max(0, S.v + S.vv * dt));

    const smooth = S.sweepReady;
    if (smooth !== S.wasSmooth) {               // grid -> sweeps switch: fade once
      gfctx.clearRect(0, 0, gazeFrom.width, gazeFrom.height);
      gfctx.drawImage(gazeCanvas, 0, 0);
      S.cellAt = t;
      S.wasSmooth = smooth;
    }
    const lin = Math.min(1, (t - S.cellAt) / GAZE_FADE_MS);
    const a = lin * lin * (3 - 2 * lin);   // ease in-out
    gctx.clearRect(0, 0, gazeCanvas.width, gazeCanvas.height);
    gctx.globalCompositeOperation = 'lighter';
    if (a < 1) { gctx.globalAlpha = 1 - a; gctx.drawImage(gazeFrom, 0, 0); }

    if (smooth) {
      // Show the single nearest real frame (head and body from the same video
      // frame). Neighbouring frames are tiny steps, so switching between them
      // at display rate reads as smooth motion with no blur. A little
      // hysteresis stops flicker when the cursor sits on a boundary.
      const M = LOOK;
      const x = (S.u / 4) * (M.cols - 1);
      const y = (S.v / 2) * (M.rows - 1);
      const nc = S.lc != null && Math.abs(x - S.lc) < 0.6 ? S.lc : Math.round(x);
      const nr = S.lr != null && Math.abs(y - S.lr) < 0.6 ? S.lr : Math.round(y);
      S.lc = nc; S.lr = nr;
      S.gr = Math.round(S.v); S.gc = nc;
      const k = gazeCanvas.width / M.frame;
      const im = look[nr][nc];
      if (im) { gctx.globalAlpha = a; gctx.drawImage(im, M.x * k, M.y * k, M.w * k, M.h * k); }
    } else {
      // Before the sweeps load: snap to the nearest grid image (with a little
      // hysteresis) and crossfade from whatever is on screen.
      const nc = S.gcGrid != null && Math.abs(S.u - S.gcGrid) <= 0.6 ? S.gcGrid : Math.round(S.u);
      const nr = Math.abs(S.v - S.gr) > 0.6 ? Math.round(S.v) : S.gr;
      if (nr !== S.gr || nc !== S.gcGrid) {
        gfctx.clearRect(0, 0, gazeFrom.width, gazeFrom.height);
        gfctx.drawImage(gazeCanvas, 0, 0);
        S.cellAt = t;
      }
      S.gr = nr; S.gcGrid = nc;
      const im = gaze[S.gr]?.[S.gcGrid];
      if (im) { gctx.globalAlpha = a; gctx.drawImage(im, 0, 0, gazeCanvas.width, gazeCanvas.height); }
    }
    gctx.globalAlpha = 1;
    gctx.globalCompositeOperation = 'source-over';
    // gentle breathing
    const b = 1 + Math.sin(t / 600) * 0.006;
    const gy = canvas.height * GROUND_Y;
    ctx.save();
    ctx.translate(0, gy);
    ctx.scale(1, b);
    ctx.translate(0, -gy);
    ctx.drawImage(gazeCanvas, 0, 0);
    ctx.restore();
  }

  function frame(t) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const shadowState = S.clip ? CLIPS[S.clip].to : S.rest;
    drawShadow(SHADOW_W[shadowState] || 0.3);
    const fade = Math.min(1, (performance.now() - fadeStart) / FADE_MS);
    if (fade < 1) ctx.globalAlpha = fade;
    if (S.clip && videos[S.clip].readyState >= 2) {
      dogLayer = videos[S.clip];
      ctx.drawImage(dogLayer, 0, 0, canvas.width, canvas.height);
    } else if (S.rest === 'sit') {
      drawGaze(t);
      dogLayer = gazeCanvas;
    } else if (stills[S.rest]) {
      dogLayer = stills[S.rest];
      ctx.drawImage(dogLayer, 0, 0, canvas.width, canvas.height);
    }
    if (fade < 1) {
      ctx.globalAlpha = 1 - fade;
      ctx.drawImage(fadeCanvas, 0, 0);
      ctx.globalAlpha = 1;
    }
    // keep the speech bubble / Zzz above his head
    // (kept inside the window so it isn't clipped at small sizes)
    const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
    const W = SZ(), top = stageTop();
    const side = trayOpen() ? 0.27 * W : 0;   // tray is above his head: speak from beside it
    const bx = Math.min(W - bw / 2 - 2, Math.max(bw / 2 + 2, HEAD.x * W + side));
    const by = Math.max(bh + 2, top + ((S.rest === 'sit' ? HEAD.y : 0.66) - 0.08) * W);
    bubble.style.left = `${bx}px`;
    bubble.style.top = `${by}px`;
    zzz.style.left = `${0.74 * W}px`;
    zzz.style.top = `${top + 0.6 * W}px`;
    autonomy(performance.now());
    requestAnimationFrame(frame);
  }

  loadAssets().then(() => requestAnimationFrame(frame));

  // for automated checks
  window.__chunky = { S, act, CLIPS, videos };
})();
