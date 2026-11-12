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
      S.lastMoveAt = performance.now();
      if (name === 'sit' || name === 'lie' || name === 'sleep') await goTo(name);
      else {
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
  let nextIdleAt = performance.now() + rand(15000, 30000);
  function autonomy(now) {
    if (S.busy || S.dragging || S.noAuto) return;
    const idle = now - S.lastMoveAt;
    if (S.rest !== 'sleep' && idle > 30000) {
      act(S.rest === 'lie' ? 'sleep' : 'lie', false);
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
      // (if you chose Sleep yourself, he stays asleep until you pick something else)
      if (S.rest === 'sleep' && !S.busy && !S.dragging && !S.stayAsleep) act('sit', false);
    }
    const sx = bounds.width / window.innerWidth;
    const sy = bounds.height / window.innerHeight;
    S.cursor.x = (cursor.x - bounds.x) / sx;
    S.cursor.y = (cursor.y - bounds.y) / sy;

    // Click-through everywhere except on Chunky's pixels.
    let over = false;
    const { x, y } = S.cursor;
    if (x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight) {
      const d = window.devicePixelRatio || 1;
      over = ctx.getImageData(Math.floor(x * d), Math.floor(y * d), 1, 1).data[3] > 40;
    }
    if (over !== S.over) {
      S.over = over;
      api.setHover(over || S.dragging);
    }
  });

  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !S.over) return;
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
    S.stayAsleep = name === 'sleep'; // chosen sleep lasts until another action is chosen
    act(name);
  });

  // ----------------------------------------------------------- render
  function resize() {
    const d = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * d);
    canvas.height = Math.round(window.innerHeight * d);
    gazeCanvas.width = fadeCanvas.width = gazeFrom.width = canvas.width;
    gazeCanvas.height = fadeCanvas.height = gazeFrom.height = canvas.height;
  }
  window.addEventListener('resize', resize);
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
    const W = window.innerWidth, H = window.innerHeight;
    let tu = 2, tv = 1;
    if (!S.centerGaze) {
      const dx = S.cursor.x - HEAD.x * W;
      const dy = S.cursor.y - HEAD.y * H;
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
    const bx = Math.min(window.innerWidth - bw / 2 - 2, Math.max(bw / 2 + 2, HEAD.x * window.innerWidth));
    const by = Math.max(bh + 2, (S.rest === 'sit' ? HEAD.y : 0.66) * window.innerHeight - 0.08 * window.innerHeight);
    bubble.style.left = `${bx}px`;
    bubble.style.top = `${by}px`;
    zzz.style.left = `${0.74 * window.innerWidth}px`;
    zzz.style.top = `${0.6 * window.innerHeight}px`;
    autonomy(performance.now());
    requestAnimationFrame(frame);
  }

  loadAssets().then(() => requestAnimationFrame(frame));

  // for automated checks
  window.__chunky = { S, act, CLIPS, videos };
})();
