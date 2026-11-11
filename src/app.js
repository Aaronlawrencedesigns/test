// Scene, pose animation, mouse tracking and Chunky's behaviours.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildChunky, buildPoop } from './chunky.js';

const api = window.dogApi;
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------- scene
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.3;

const camera = new THREE.PerspectiveCamera(20, 1, 0.1, 20);
camera.position.set(0, 0.68, 3.5);
camera.lookAt(0, 0.355, 0);

scene.add(new THREE.HemisphereLight('#fff3e6', '#6d5646', 0.7));
const key = new THREE.DirectionalLight('#fff1df', 2.1);
key.position.set(1.4, 2.6, 2.2);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.left = key.shadow.camera.bottom = -0.9;
key.shadow.camera.right = key.shadow.camera.top = 0.9;
key.shadow.radius = 6;
key.shadow.bias = -0.0005;
scene.add(key);
const rim = new THREE.DirectionalLight('#dfe8ff', 1.4);
rim.position.set(-2, 1.6, -2.2);
scene.add(rim);

// Ground: invisible except for shadows
const ground = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.ShadowMaterial({ opacity: 0.2 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
// soft contact shadow blob
const blobTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(0,0,0,0.45)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
})();
const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false }));
blob.rotation.x = -Math.PI / 2;
blob.position.y = 0.001;
scene.add(blob);

const dog = buildChunky();
const { J } = dog;
const root = dog.root;
const FACING = -0.5; // turned a little toward the screen's left (he lives in the bottom-right corner)
root.rotation.y = FACING;
scene.add(root);

// ------------------------------------------------------------------- poses
// Joint rotations [x, y, z] (radians). Joints not listed go back to rest.
// Scalars: lid (0 open .. 1 closed), pupil, brow (puppy brows), look (how
// much the head follows the cursor), earBack.
const POSES = {
  sit: {
    hips: [-0.8, 0, 0], spine: [-0.12, 0, 0], neck: [0.45, 0, 0],
    hipL: [-0.55, 0, -0.18], hipR: [-0.55, 0, 0.18], kneeL: [2.4, 0, 0], kneeR: [2.4, 0, 0],
    hockL: [-1.2, 0, 0], hockR: [-1.2, 0, 0], hpawL: [0.35, 0, 0], hpawR: [0.35, 0, 0],
    shL: [0.72, 0, 0.06], shR: [0.72, 0, -0.06], wrL: [0.05, 0, 0], wrR: [0.05, 0, 0],
    tail: [0.9, 0, 0],
    look: 1,
  },
  stand: {
    hips: [-0.06, 0, 0], spine: [0.05, 0, 0], neck: [-0.15, 0, 0],
    hipL: [-0.2, 0, 0], hipR: [-0.2, 0, 0], kneeL: [0.55, 0, 0], kneeR: [0.55, 0, 0],
    hockL: [-0.42, 0, 0], hockR: [-0.42, 0, 0], hpawL: [0.07, 0, 0], hpawR: [0.07, 0, 0],
    shL: [0.02, 0, 0.06], shR: [0.02, 0, -0.06], elL: [-0.05, 0, -0.08], elR: [-0.05, 0, 0.08], wrL: [0.03, 0, 0], wrR: [0.03, 0, 0],
    tail: [0.2, 0, 0],
    look: 1,
  },
  lie: {
    hips: [0.02, 0, 0], spine: [0, 0, 0], neck: [0.15, 0, 0],
    hipL: [-1.35, 0, -0.35], hipR: [-1.35, 0, 0.35], kneeL: [2.6, 0, 0], kneeR: [2.6, 0, 0],
    hockL: [-1.3, 0, 0], hockR: [-1.3, 0, 0], hpawL: [0.1, 0, 0], hpawR: [0.1, 0, 0],
    shL: [-0.55, 0, 0.12], shR: [-0.55, 0, -0.12], elL: [-1.0, 0, -0.1], elR: [-1.0, 0, 0.1], wrL: [1.55, 0, 0], wrR: [1.55, 0, 0],
    tail: [0.4, 0, 0],
    look: 1,
  },
  sleep: {
    hips: [0.02, -0.12, 0.05], spine: [0, -0.1, 0], neck: [1.05, 0.25, 0], head: [-0.55, 0.1, 0.3],
    hipL: [-1.35, 0, -0.45], hipR: [-1.35, 0, 0.45], kneeL: [2.6, 0, 0], kneeR: [2.6, 0, 0],
    hockL: [-1.3, 0, 0], hockR: [-1.3, 0, 0],
    shL: [-0.55, 0, 0.12], shR: [-0.55, 0, -0.12], elL: [-1.0, 0, -0.1], elR: [-1.0, 0, 0.1], wrL: [1.55, 0, 0], wrR: [1.55, 0, 0],
    tail: [0.4, 0, 0],
    look: 0, lid: 1,
  },
  poop: {
    hips: [-0.5, 0, 0], spine: [0.32, 0, 0], neck: [-0.1, 0, 0],
    hipL: [-0.55, 0, -0.2], hipR: [-0.55, 0, 0.2], kneeL: [1.85, 0, 0], kneeR: [1.85, 0, 0],
    hockL: [-1.0, 0, 0], hockR: [-1.0, 0, 0], hpawL: [0.15, 0, 0], hpawR: [0.15, 0, 0],
    shL: [0.25, 0, 0.06], shR: [0.25, 0, -0.06], elL: [-0.02, 0, -0.08], elR: [-0.02, 0, 0.08], wrL: [-0.1, 0, 0], wrR: [-0.1, 0, 0],
    tail: [-0.6, 0, 0],
    look: 0.7, lid: 0.25,
  },
};
POSES.puppy = { ...POSES.sit, neck: [0.85, 0, 0], look: 1, headRoll: 0.2, headPitch: 0.25, pupil: 0.36, brow: 1, earBack: 1, lid: -0.15 };

const SCALARS = { lid: 0, pupil: 0.24, brow: 0, look: 1, earBack: 0, headRoll: 0, headPitch: 0 };

// Current animated values (joint eulers + scalars)
const cur = {};
for (const k of Object.keys(J)) cur[k] = [...dog.rest[k]];
Object.assign(cur, structuredClone(SCALARS));
let target = null;
let poseName = 'sit';
let poseSpeed = 3;

function setPose(name, speed = 3) {
  poseName = name;
  poseSpeed = speed;
  const p = POSES[name];
  target = {};
  for (const k of Object.keys(J)) target[k] = p[k] ? [...p[k]] : [...dog.rest[k]];
  for (const [k, v] of Object.entries(SCALARS)) target[k] = p[k] ?? v;
}
setPose('sit');
for (const k of Object.keys(target)) cur[k] = structuredClone(target[k]); // start seated

// ----------------------------------------------------------- live state
const state = {
  t: 0,
  cursorLocal: new THREE.Vector2(170, -200),
  lastMoveAt: performance.now(),
  overDog: false,
  overHead: false,
  hoverHeadSince: 0,
  near: false,
  nearSince: 0,
  pant: 0,           // 0..1
  wag: 0,            // 0..1 intensity
  wiggle: 0,         // butt wiggle intensity
  blink: 0,          // 0..1 overlay
  barkOpen: 0,
  hopY: 0, hopV: 0,
  tremble: 0,
  kick: 0,
  earTwitchL: 0, earTwitchR: 0,
  busy: false,       // in a scripted action
  sleeping: false,
  lookYaw: 0, lookPitch: 0,
  dragging: false,
};

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------- bubble
const bubble = $('bubble');
let bubbleTimer;
function say(text, ms = 1300) {
  bubble.textContent = text;
  bubble.classList.add('show');
  clearTimeout(bubbleTimer);
  if (ms) bubbleTimer = setTimeout(() => bubble.classList.remove('show'), ms);
}
const zzz = $('zzz');

// --------------------------------------------------------------- actions
const ACTIONS = {
  async sit() { wakeQuiet(); setPose('sit', 3); },
  async stand() { wakeQuiet(); setPose('stand', 3); state.wag = 1; },
  async lie() { wakeQuiet(); setPose('lie', 2.2); },
  async sleep() { await goToSleep(); },
  async wag() {
    wakeQuiet();
    if (poseName === 'lie' || poseName === 'sleep') setPose('sit', 3);
    state.wag = 1; state.wiggle = 1;
    say('♥', 1200);
    await sleepMs(2500);
    state.wiggle = 0;
  },
  async bark() {
    wakeQuiet();
    if (poseName === 'sleep') setPose('sit');
    say(pick(['Woof!', 'Arf!', 'Boof!', 'Wuf wuf!']), 1100);
    for (let i = 0; i < 2; i++) {
      state.barkOpen = 1;
      state.hopV = 0.9;
      await sleepMs(150);
      state.barkOpen = 0;
      await sleepMs(170);
    }
  },
  async puppy() {
    wakeQuiet();
    setPose('puppy', 2.5);
    say('🥺', 2200);
    await sleepMs(5000);
    if (poseName === 'puppy') setPose('sit', 2.5);
  },
  async poop() {
    if (state.busy) return;
    state.busy = true;
    wakeQuiet();
    setPose('stand', 3);
    await sleepMs(1100);
    setPose('poop', 2.4);
    await sleepMs(1300);
    state.tremble = 1;
    await sleepMs(1500);
    dropPoop();
    state.tremble = 0;
    await sleepMs(500);
    setPose('stand', 3.5);
    await sleepMs(600);
    state.kick = 1;           // proud little back-kicks
    say('💩 …oops', 1600);
    await sleepMs(1400);
    state.kick = 0;
    state.wag = 1;
    await sleepMs(800);
    setPose('sit', 3);
    state.busy = false;
  },
};
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function wakeQuiet() {
  if (!state.sleeping) return;
  state.sleeping = false;
  zzz.classList.remove('show');
}

async function goToSleep() {
  if (state.sleeping) return;
  if (poseName !== 'lie') { setPose('lie', 2); await sleepMs(1800); }
  if (state.lastMoveAt > performance.now() - 1500 && !state.forceSleep) { return; }
  state.sleeping = true;
  setPose('sleep', 1.0);
  zzz.classList.add('show');
}

function wakeUp() {
  if (!state.sleeping) return;
  state.sleeping = false;
  zzz.classList.remove('show');
  setPose('lie', 2.5);
  state.blink = 1;
  setTimeout(() => { if (poseName === 'lie') setPose('sit', 2.5); }, 1600);
}

// ----------------------------------------------------------------- poop
const poops = [];
function dropPoop() {
  const p = buildPoop();
  const tp = J.tail.getWorldPosition(new THREE.Vector3());
  p.position.set(tp.x, tp.y - 0.05, tp.z);
  p.userData = { vy: 0, born: performance.now(), s: 0.2 };
  p.scale.setScalar(0.2);
  scene.add(p);
  poops.push(p);
}
function updatePoops(dt) {
  const now = performance.now();
  for (let i = poops.length - 1; i >= 0; i--) {
    const p = poops[i];
    const d = p.userData;
    if (p.position.y > 0) {
      d.vy -= 9.8 * dt * 0.5;
      p.position.y = Math.max(0, p.position.y + d.vy * dt);
    }
    const age = now - d.born;
    d.s = age < 6000 ? Math.min(1, d.s + dt * 3) : Math.max(0, d.s - dt * 1.2);
    p.scale.setScalar(d.s);
    if (age > 6000 && d.s <= 0) { scene.remove(p); poops.splice(i, 1); }
  }
}

// ------------------------------------------------------------ autonomy
let nextIdleAt = performance.now() + rand(15000, 30000);
function rand(a, b) { return a + Math.random() * (b - a); }

function autonomy(now) {
  if (state.busy || state.dragging) return;
  const idleFor = now - state.lastMoveAt;
  if (!state.sleeping && idleFor > 30000 && !state.goingToSleep) {
    state.goingToSleep = true;
    goToSleep().finally(() => (state.goingToSleep = false));
    return;
  }
  if (state.sleeping) return;
  // Hovering near him for a while = begging time.
  if (state.near && now - state.nearSince > 3500 && poseName === 'sit' && Math.random() < 0.004) {
    ACTIONS.puppy();
    return;
  }
  if (now < nextIdleAt) return;
  nextIdleAt = now + rand(18000, 45000);
  const r = Math.random();
  if (r < 0.03) ACTIONS.poop();
  else if (r < 0.35) { setPose('stand', 3); state.wag = 1; setTimeout(() => { if (poseName === 'stand' && !state.busy) setPose('sit'); }, rand(5000, 9000)); }
  else if (r < 0.65) { setPose('lie', 2.2); setTimeout(() => { if (poseName === 'lie' && !state.sleeping) setPose('sit'); }, rand(12000, 25000)); }
  else if (r < 0.8) ACTIONS.bark();
  else if (r < 0.9) ACTIONS.puppy();
  else state.earTwitchL = state.earTwitchR = 1;
}

// ------------------------------------------------------- cursor + input
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let lastCursor = null;

api.onCursor(({ cursor, bounds }) => {
  const now = performance.now();
  const moved = !lastCursor || cursor.x !== lastCursor.x || cursor.y !== lastCursor.y;
  if (state.dragging && lastCursor && moved) {
    const dx = cursor.x - lastCursor.x, dy = cursor.y - lastCursor.y;
    state.dragMoved += Math.abs(dx) + Math.abs(dy);
    if (state.dragMoved > 4) api.drag(dx, dy);
  }
  lastCursor = cursor;
  if (moved) {
    state.lastMoveAt = now;
    if (state.sleeping && !state.dragging) wakeUp();
  }
  const sx = bounds.width / window.innerWidth;
  const sy = bounds.height / window.innerHeight;
  state.cursorLocal.set((cursor.x - bounds.x) / sx, (cursor.y - bounds.y) / sy);

  // Hit-test against Chunky (window is click-through everywhere else)
  const { x, y } = state.cursorLocal;
  let over = false, overHead = false;
  if (x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight) {
    ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(dog.hitMeshes, false)[0];
    if (hit) {
      over = true;
      let o = hit.object;
      while (o && o !== root) { if (o === J.head) { overHead = true; break; } o = o.parent; }
    }
  }
  if (over !== state.overDog) { state.overDog = over; api.setHover(over || state.dragging); }
  if (overHead && !state.overHead) state.hoverHeadSince = now;
  state.overHead = overHead;

  const headPx = projectToPx(J.head.getWorldPosition(new THREE.Vector3()));
  const dist = Math.hypot(x - headPx.x, y - headPx.y);
  const near = dist < 220;
  if (near && !state.near) state.nearSince = now;
  state.near = near;
});

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !state.overDog) return;
  state.dragging = true;
  state.dragMoved = 0;
  api.setHover(true);
});
window.addEventListener('mouseup', (e) => {
  if (e.button !== 0 || !state.dragging) return;
  state.dragging = false;
  api.setHover(state.overDog);
  if (state.dragMoved > 4) { say('Wheee!', 900); return; }
  // click!
  state.lastMoveAt = performance.now();
  if (state.sleeping) { wakeUp(); say('!', 700); return; }
  if (state.busy) return;
  pick([ACTIONS.bark, ACTIONS.bark, ACTIONS.wag, ACTIONS.puppy])();
});
window.addEventListener('contextmenu', (e) => { e.preventDefault(); api.contextMenu(); });
api.onAction((name) => {
  if (name === 'sleep') { state.forceSleep = true; goToSleep().finally(() => (state.forceSleep = false)); return; }
  state.lastMoveAt = performance.now(); // a command counts as activity
  ACTIONS[name]?.();
});

function projectToPx(v) {
  const p = v.clone().project(camera);
  return { x: (p.x + 1) / 2 * window.innerWidth, y: (1 - p.y) / 2 * window.innerHeight };
}

// ------------------------------------------------------------ animation
const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3();
const qA = new THREE.Quaternion(), qB = new THREE.Quaternion(), qC = new THREE.Quaternion();
const eul = new THREE.Euler();

function cursorWorldTarget() {
  // Turn the 2D cursor (possibly far outside the window) into a 3D point on a
  // plane roughly where the screen is, so eyes converge believably.
  const head = J.head.getWorldPosition(new THREE.Vector3());
  const hp = projectToPx(head);
  const dist = camera.position.distanceTo(head);
  const wpp = (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / window.innerHeight;
  const dx = (state.cursorLocal.x - hp.x) * wpp;
  const dy = -(state.cursorLocal.y - hp.y) * wpp;
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  const toCam = camera.position.clone().sub(head).normalize();
  return head.add(right.multiplyScalar(dx)).add(up.multiplyScalar(dy)).add(toCam.multiplyScalar(dist * 0.85));
}

let lastT = performance.now();
let nextBlink = performance.now() + 2500;
let nextTwitch = performance.now() + 5000;

function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  state.t += dt;
  const t = state.t;

  // reactions to the cursor
  const petting = state.overHead && now - state.hoverHeadSince > 300 && !state.sleeping && !state.dragging;
  const excited = (state.near || state.overDog) && !state.sleeping;
  state.pant += ((excited ? 1 : 0) - state.pant) * dt * 1.5;
  if (excited) state.wag = Math.max(state.wag, 0.8);
  state.wag = Math.max(0, state.wag - dt * 0.12);

  // blink / ear twitch timers
  if (now > nextBlink) { state.blink = 1; nextBlink = now + rand(2500, 6000); if (Math.random() < 0.2) setTimeout(() => (state.blink = 1), 260); }
  state.blink = Math.max(0, state.blink - dt * 7);
  if (now > nextTwitch) { Math.random() < 0.5 ? (state.earTwitchL = 1) : (state.earTwitchR = 1); nextTwitch = now + rand(4000, 10000); }
  state.earTwitchL = Math.max(0, state.earTwitchL - dt * 3);
  state.earTwitchR = Math.max(0, state.earTwitchR - dt * 3);

  // ease every value toward its pose target
  const k = 1 - Math.exp(-dt * poseSpeed);
  for (const key of Object.keys(target)) {
    const tv = target[key];
    if (Array.isArray(tv)) for (let i = 0; i < 3; i++) cur[key][i] += (tv[i] - cur[key][i]) * k;
    else cur[key] += (tv - cur[key]) * k;
  }

  // apply joint rotations
  for (const name of Object.keys(J)) J[name].rotation.set(...cur[name]);

  // --- procedural overlays ---
  const breathRate = state.sleeping ? 1.3 : 2.2 + state.pant * 9;
  const breath = Math.sin(t * breathRate);
  J.spine.rotation.x += breath * (0.008 + state.pant * 0.01);
  J.neck.rotation.x -= breath * 0.006;
  J.spine.scale.set(1 + breath * 0.012, 1 + breath * 0.014, 1);
  J.neck.scale.set(1 / (1 + breath * 0.012), 1 / (1 + breath * 0.014), 1);

  // tail wag + butt wiggle (frenchies wag with their whole back end)
  const wagAmt = state.wag * (state.sleeping ? 0 : 1);
  J.tail.rotation.y += Math.sin(t * 22) * 0.7 * wagAmt;
  const wig = Math.max(state.wiggle, poseName === 'stand' ? wagAmt * 0.6 : wagAmt * 0.15);
  J.hips.rotation.y += Math.sin(t * 11) * 0.09 * wig;
  J.spine.rotation.y -= Math.sin(t * 11) * 0.07 * wig;

  // poop tremble + back-kicks
  if (state.tremble) J.hips.rotation.z += Math.sin(t * 60) * 0.012;
  if (state.kick) {
    const s = Math.sin(t * 14);
    J.hipL.rotation.x += Math.max(0, s) * 0.9;
    J.hipR.rotation.x += Math.max(0, -s) * 0.9;
  }

  // ears: back for puppy eyes, twitches, relaxed when petted
  const earBack = cur.earBack + (petting ? 0.6 : 0);
  J.earL.rotation.x -= earBack * 0.35 - state.earTwitchL * Math.sin(state.earTwitchL * Math.PI) * 0.4;
  J.earL.rotation.z -= earBack * 0.35;
  J.earR.rotation.x -= earBack * 0.35 - state.earTwitchR * Math.sin(state.earTwitchR * Math.PI) * 0.4;
  J.earR.rotation.z += earBack * 0.35;

  // brows: inner corners up for puppy eyes
  J.browL.rotation.z += cur.brow * 0.35;
  J.browR.rotation.z -= cur.brow * 0.35;
  J.browL.position.y = J.browR.position.y = 0.072 + cur.brow * 0.012;

  // mouth: panting + barking
  const jaw = Math.max(state.barkOpen * 0.45, state.pant * (0.22 + 0.06 * Math.sin(t * breathRate * 2)));
  J.jaw.rotation.x = jaw;
  const tongueOut = state.pant * (1 - state.barkOpen);
  J.tongue.position.z = 0.11 + tongueOut * 0.035;
  J.tongue.position.y = -0.05 - tongueOut * 0.012;
  J.tongue.rotation.x = tongueOut * 0.6;

  // eyelids
  let lid = cur.lid;
  if (petting) lid = Math.max(lid, 0.55);
  lid = Math.max(lid, state.blink > 0 ? Math.sin(state.blink * Math.PI) : 0);
  const upper = THREE.MathUtils.lerp(-0.8, 1.5, Math.max(-0.2, lid));
  const lower = THREE.MathUtils.lerp(0.8, 0.35, Math.max(0, lid));
  J.lidUL.rotation.x = J.lidUR.rotation.x = upper;
  J.lidLL.rotation.x = J.lidLR.rotation.x = lower;
  for (const m of dog.eyeMats) m.userData.u.uPupil.value = cur.pupil;

  // hop
  state.hopV -= dt * 9;
  state.hopY = Math.max(0, state.hopY + state.hopV * dt);
  if (state.hopY === 0 && state.hopV < 0) state.hopV = 0;

  // ground him: lowest point of any contact ellipsoid sits on y=0
  root.position.y = 0;
  root.updateMatrixWorld(true);
  let minY = Infinity;
  for (const m of dog.contacts) {
    const e = m.matrixWorld.elements;
    minY = Math.min(minY, e[13] - Math.hypot(e[1], e[5], e[9]));
  }
  root.position.y = -minY + state.hopY;
  root.updateMatrixWorld(true);
  blob.scale.set(poseName === 'lie' || poseName === 'sleep' ? 1.0 : 0.75, 1, 1.0);
  blob.material.opacity = 1 - Math.min(0.7, state.hopY * 4);

  // head + eyes follow the cursor
  const T = cursorWorldTarget();
  const qRootInv = root.getWorldQuaternion(qA).invert();
  const hp = J.head.getWorldPosition(tmpV);
  const d = tmpV2.copy(T).sub(hp).applyQuaternion(qRootInv);
  const yawT = THREE.MathUtils.clamp(Math.atan2(d.x, d.z), -1.0, 1.0);
  const pitchT = THREE.MathUtils.clamp(-Math.atan2(d.y, Math.hypot(d.x, d.z)), -0.55, 0.45);
  state.lookYaw += (yawT - state.lookYaw) * Math.min(1, dt * 6);
  state.lookPitch += (pitchT - state.lookPitch) * Math.min(1, dt * 6);
  if (cur.look > 0.01) {
    J.neck.rotation.y += state.lookYaw * 0.3 * cur.look;
    J.neck.updateMatrixWorld(true);
    eul.set(state.lookPitch * 0.75 + cur.headPitch, state.lookYaw * 0.7, cur.headRoll + Math.sin(t * 0.7) * 0.02, 'YXZ');
    const qDes = qB.setFromEuler(eul);
    const qParent = J.neck.getWorldQuaternion(qC).premultiply(qRootInv);
    const qLocal = qParent.invert().multiply(qDes);
    J.head.quaternion.slerp(qLocal, cur.look);
    root.updateMatrixWorld(true);
  }
  for (const S of ['L', 'R']) {
    const eye = J['eye' + S];
    const socket = J['socket' + S];
    const lp = socket.worldToLocal(tmpV.copy(T));
    const look = Math.max(0, 1 - lid) * Math.max(cur.look, 0.3);
    const ey = THREE.MathUtils.clamp(Math.atan2(lp.x, lp.z), -0.55, 0.55) * look;
    const ex = THREE.MathUtils.clamp(-Math.atan2(lp.y, Math.hypot(lp.x, lp.z)), -0.45, 0.4) * look;
    eye.rotation.set(ex, ey, 0);
  }

  updatePoops(dt);
  autonomy(now);

  // bubble + zzz follow his head
  const hpx = projectToPx(J.head.getWorldPosition(tmpV));
  bubble.style.left = `${hpx.x}px`;
  bubble.style.top = `${hpx.y - 70}px`;
  zzz.style.left = `${hpx.x + 30}px`;
  zzz.style.top = `${hpx.y - 40}px`;

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();
requestAnimationFrame(frame);

// for automated screenshots / debugging
window.__chunky = { snap: () => { for (const k of Object.keys(target)) cur[k] = structuredClone(target[k]); }, setPose, state, cur, ACTIONS, J, camera, renderer, scene, root };
