// Renderer: eye tracking, idle behaviour, and click tricks.
(() => {
  const root = document.body;
  const head = document.getElementById('head');
  const bubble = document.getElementById('bubble');
  const jumper = document.getElementById('jumper');
  const eyes = [
    { pupil: document.getElementById('pupilL'), white: document.querySelector('[clip-path="url(#clipEyeL)"] .eye-white') },
    { pupil: document.getElementById('pupilR'), white: document.querySelector('[clip-path="url(#clipEyeR)"] .eye-white') },
  ];

  const MAX_PUPIL = 4.5;     // how far pupils can travel inside the eye (svg units)
  const SLEEP_AFTER = 25000; // ms of no mouse movement before napping
  const BARKS = ['Woof!', 'Arf!', 'Bork!', 'Ruff!', '♥', 'Wan wan!', 'Treat?'];
  const TRICKS = ['trick-jump', 'trick-spin', 'trick-tilt', 'trick-wiggle'];

  // Smoothed state
  const pupilCur = eyes.map(() => ({ x: 0, y: 0 }));
  const pupilTarget = eyes.map(() => ({ x: 0, y: 0 }));
  let headCur = { r: 0, x: 0, y: 0 };
  let headTarget = { r: 0, x: 0, y: 0 };

  let lastCursor = null;
  let lastMoveAt = performance.now();
  let sleeping = false;
  let busy = false;          // during a trick, don't start another
  let overDog = false;

  // ---------------------------------------------------------------- helpers
  const addTemp = (cls, ms) => {
    root.classList.add(cls);
    setTimeout(() => root.classList.remove(cls), ms);
  };
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  let bubbleTimer;
  function say(text, ms = 1100) {
    bubble.textContent = text;
    bubble.classList.add('show');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.remove('show'), ms);
  }

  // ------------------------------------------------------------ eye tracking
  function onCursor({ cursor, bounds }) {
    const moved = !lastCursor || cursor.x !== lastCursor.x || cursor.y !== lastCursor.y;
    if (moved) {
      lastMoveAt = performance.now();
      if (sleeping) wake();
    }
    if (dragging) handleDrag(cursor);
    lastCursor = cursor;

    // Convert window-relative CSS px -> screen px.
    const sx = bounds.width / window.innerWidth;
    const sy = bounds.height / window.innerHeight;
    const localX = (cursor.x - bounds.x) / sx;
    const localY = (cursor.y - bounds.y) / sy;

    // Hit-test the cursor against the dog's painted shapes. This is how we
    // make the transparent window click-through everywhere *except* the dog.
    const inside = localX >= 0 && localY >= 0 && localX < window.innerWidth && localY < window.innerHeight;
    const el = inside ? document.elementFromPoint(localX, localY) : null;
    const nowOver = !!(el && jumper.contains(el));
    if (nowOver !== overDog) {
      overDog = nowOver;
      window.dogApi.setHover(overDog || dragging);
    }
    const onHead = nowOver && head.contains(el);
    root.classList.toggle('petted', onHead && !dragging && !sleeping);

    if (sleeping) return;

    // Aim each pupil at the cursor.
    let nearest = Infinity;
    eyes.forEach((eye, i) => {
      const r = eye.white.getBoundingClientRect();
      const ex = bounds.x + (r.left + r.width / 2) * sx;
      const ey = bounds.y + (r.top + r.height / 2) * sy;
      const dx = cursor.x - ex;
      const dy = cursor.y - ey;
      const dist = Math.hypot(dx, dy) || 1;
      nearest = Math.min(nearest, dist);
      // Pupils reach full travel once the cursor is ~120px away.
      const amt = Math.min(1, dist / 120) * MAX_PUPIL;
      pupilTarget[i].x = (dx / dist) * amt;
      pupilTarget[i].y = (dy / dist) * amt;
    });

    // Lean the head a little toward the cursor.
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height * 0.45;
    const hdx = cursor.x - cx;
    const hdy = cursor.y - cy;
    headTarget.r = Math.max(-10, Math.min(10, hdx / 60));
    headTarget.x = Math.max(-5, Math.min(5, hdx / 120));
    headTarget.y = Math.max(-4, Math.min(4, hdy / 150));

    // Get excited when the cursor comes close.
    root.classList.toggle('happy', nearest < 140 || overDog);
  }

  function tick() {
    const k = 0.25; // smoothing
    eyes.forEach((eye, i) => {
      pupilCur[i].x += (pupilTarget[i].x - pupilCur[i].x) * k;
      pupilCur[i].y += (pupilTarget[i].y - pupilCur[i].y) * k;
      eye.pupil.setAttribute('transform', `translate(${pupilCur[i].x.toFixed(2)} ${pupilCur[i].y.toFixed(2)})`);
    });
    if (!root.className.includes('trick-tilt')) {
      headCur.r += (headTarget.r - headCur.r) * 0.12;
      headCur.x += (headTarget.x - headCur.x) * 0.12;
      headCur.y += (headTarget.y - headCur.y) * 0.12;
      head.style.transform = `translate(${headCur.x}px, ${headCur.y}px) rotate(${headCur.r}deg)`;
    } else {
      head.style.transform = '';
    }

    if (!sleeping && !dragging && performance.now() - lastMoveAt > SLEEP_AFTER) sleep();
    requestAnimationFrame(tick);
  }

  // -------------------------------------------------------------- idle life
  function scheduleBlink() {
    setTimeout(() => {
      if (!sleeping) {
        addTemp('blink', 140);
        if (Math.random() < 0.2) setTimeout(() => addTemp('blink', 120), 220); // double blink
      }
      scheduleBlink();
    }, rand(2200, 5500));
  }

  function scheduleTwitch() {
    setTimeout(() => {
      if (!sleeping || Math.random() < 0.3) addTemp(Math.random() < 0.5 ? 'twitchL' : 'twitchR', 400);
      scheduleTwitch();
    }, rand(4000, 9000));
  }

  function sleep() {
    sleeping = true;
    root.classList.remove('happy', 'petted');
    root.classList.add('sleeping');
    pupilTarget.forEach((p) => { p.x = 0; p.y = 0; });
    headTarget = { r: 8, x: 2, y: 6 }; // droop
  }

  function wake() {
    sleeping = false;
    root.classList.remove('sleeping');
    addTemp('startle', 450);
    say('!', 600);
  }

  // ----------------------------------------------------- click/drag/tricks
  let dragging = false;
  let dragStart = null;
  let dragMoved = 0;

  function handleDrag(cursor) {
    if (!lastCursor) return;
    const dx = cursor.x - lastCursor.x;
    const dy = cursor.y - lastCursor.y;
    if (!dx && !dy) return;
    dragMoved += Math.abs(dx) + Math.abs(dy);
    if (dragMoved > 4) {
      root.classList.add('dragging');
      window.dogApi.drag(dx, dy);
    }
  }

  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !jumper.contains(e.target)) return;
    dragging = true;
    dragMoved = 0;
    dragStart = lastCursor;
    window.dogApi.setHover(true);
  });

  window.addEventListener('mouseup', (e) => {
    if (e.button !== 0 || !dragging) return;
    const wasDrag = dragMoved > 4;
    dragging = false;
    root.classList.remove('dragging');
    window.dogApi.setHover(overDog);
    if (!wasDrag) doTrick();
    else say('Wheee!', 900);
  });

  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.dogApi.contextMenu();
  });

  function doTrick() {
    if (sleeping) { wake(); return; }
    if (busy) { say(pick(BARKS)); return; }
    busy = true;
    const trick = pick(TRICKS);
    say(pick(BARKS));
    root.classList.add(trick);
    setTimeout(() => {
      root.classList.remove(trick);
      busy = false;
    }, 1100);
  }

  // Start
  window.dogApi.onCursor(onCursor);
  requestAnimationFrame(tick);
  scheduleBlink();
  scheduleTwitch();
})();
