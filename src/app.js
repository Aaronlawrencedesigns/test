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
  // Snapshot of the last frame shown before a cut; faded out over the new
  // picture so clip boundaries never pop even if the AI frames differ slightly.
  const fadeCanvas = document.createElement('canvas');
  const fctx = fadeCanvas.getContext('2d');
  const FADE_MS = 280;
  let fadeStart = -1e9;
  let dogLayer = null; // what was drawn last frame (for snapshots)

  // Where his head and the ground are inside the 640x480 asset frame (0..1)
  const HEAD = { x: 0.5, y: 0.27 };
  const GROUND_Y = 0.969;
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
  const stills = {};
  const videos = {};

  async function loadAssets() {
    const jobs = [];
    for (let r = 0; r < 3; r++) {
      gaze[r] = [];
      for (let c = 0; c < 5; c++) jobs.push(loadImg(`${ASSETS}gaze/${c}_${r}.webp`).then((im) => (gaze[r][c] = im)));
    }
    for (const n of ['sit', 'lie', 'sleep']) jobs.push(loadImg(`${ASSETS}stills/${n}.webp`).then((im) => (stills[n] = im)));
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
    pc: 2, pr: 1,         // previous cell (fading out)
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
        while ((S.gc !== 2 || S.gr !== 1 || performance.now() - S.cellAt < 140) && performance.now() - t0 < 800) await wait(16);
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
    else if (r < 0.4) act('wag', false);
    else if (r < 0.65) act('puppy', false);
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
    else act(pick(['wag', 'puppy']));
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
    gazeCanvas.width = fadeCanvas.width = canvas.width;
    gazeCanvas.height = fadeCanvas.height = canvas.height;
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
    const k = S.centerGaze ? 0.25 : 0.12;
    S.u += (tu - S.u) * k;
    S.v += (tv - S.v) * k;
    // Snap to the nearest head direction (with a little hysteresis) and
    // crossfade quickly from the previous one; blending 4 at once ghosts.
    const nc = Math.abs(S.u - S.gc) > 0.62 ? Math.round(S.u) : S.gc;
    const nr = Math.abs(S.v - S.gr) > 0.62 ? Math.round(S.v) : S.gr;
    if (nc !== S.gc || nr !== S.gr) {
      S.pc = S.gc; S.pr = S.gr; S.gc = nc; S.gr = nr; S.cellAt = t;
    }
    const a = Math.min(1, (t - S.cellAt) / 130);
    gctx.clearRect(0, 0, gazeCanvas.width, gazeCanvas.height);
    gctx.globalCompositeOperation = 'lighter';
    for (const [c, r, w] of [[S.pc, S.pr, 1 - a], [S.gc, S.gr, a]]) {
      const im = gaze[r]?.[c];
      if (!im || w < 0.002) continue;
      gctx.globalAlpha = w;
      gctx.drawImage(im, 0, 0, gazeCanvas.width, gazeCanvas.height);
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
    const by = Math.max(bh + 2, (S.rest === 'sit' ? HEAD.y : 0.55) * window.innerHeight - 0.1 * window.innerHeight);
    bubble.style.left = `${bx}px`;
    bubble.style.top = `${by}px`;
    zzz.style.left = `${0.74 * window.innerWidth}px`;
    zzz.style.top = `${0.48 * window.innerHeight}px`;
    autonomy(performance.now());
    requestAnimationFrame(frame);
  }

  loadAssets().then(() => requestAnimationFrame(frame));

  // for automated checks
  window.__chunky = { S, act, CLIPS, videos };
})();
