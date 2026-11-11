// Chunky, the French Bulldog, built procedurally with three.js.
//
// The model is a hierarchy of "joints" (empty Object3Ds that we rotate to
// animate) with soft ellipsoid parts hung off them. Colours and the merle
// pattern were sampled from Chunky's photos. Every fur part uses the same
// shader: a 3D-noise merle pattern + lighter belly/chest bib + a few "shells"
// offset along the normal to give the short coat a velvety, fuzzy edge.
import * as THREE from 'three';

export const PALETTE = {
  base: '#c49a78',       // fawn coat
  light: '#e6c9b0',      // chest bib / belly
  patch: '#8c7268',      // lilac merle patches
  dark: '#6c574b',       // darker merle flecks
  muzzle: '#9e8482',     // pink-grey mottled muzzle
  muzzlePatch: '#7a6462',
  muzzleLight: '#c8a29c',
  earInner: '#c8968f',
  nose: '#6b5150',
  iris: '#8797a0',       // pale blue-grey eyes
  irisInner: '#c9d3d4',
  irisRing: '#a48b6a',
  mouth: '#4a2a2c',
  tongue: '#e8899a',
  poop: '#5a3a20',
};

const FUR_SHELLS = new URLSearchParams(location.search).get('shells') === '0' ? 0 : 2; // more = fuzzier & slower
const FUR_THICKNESS = 0.0035;  // world units (Chunky is ~0.9 tall sitting)

const SPHERE = new THREE.SphereGeometry(1, 48, 32);

// ------------------------------------------------------------------ shaders
const NOISE_GLSL = /* glsl */ `
float hash3(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float noise3(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(hash3(i+vec3(0,0,0)), hash3(i+vec3(1,0,0)), f.x),
                 mix(hash3(i+vec3(0,1,0)), hash3(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(hash3(i+vec3(0,0,1)), hash3(i+vec3(1,0,1)), f.x),
                 mix(hash3(i+vec3(0,1,1)), hash3(i+vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++){ s += a*noise3(p); p *= 2.03; a *= 0.5; } return s; }
`;

const FUR_FRAG_DECL = /* glsl */ `
uniform vec3 uBase; uniform vec3 uPatch; uniform vec3 uDark; uniform vec3 uLight;
uniform float uPatchAmt; uniform float uPatchScale; uniform float uPatchT;
uniform float uUnder; uniform float uFront; uniform float uSeed; uniform float uShellH;
varying vec3 vP; varying vec3 vJN;
${NOISE_GLSL}
`;

const FUR_FRAG_BODY = /* glsl */ `
{
  vec3 p = vP + vec3(uSeed);
  vec3 n = normalize(vJN);
  vec3 q = p * uPatchScale;
  float m = fbm(q + 1.3 * vec3(fbm(q * 0.7 + 3.1), fbm(q * 0.7 + 8.7), fbm(q * 0.7 + 1.9)) - 0.6);
  float patchM = smoothstep(uPatchT, uPatchT + 0.07, m);
  float darkM = smoothstep(0.55, 0.66, fbm(q * 2.3 + 7.0)) * patchM;
  vec3 c = mix(uBase, uPatch, patchM * uPatchAmt);
  c = mix(c, uDark, darkM * uPatchAmt * 0.7);
  // lighter belly + chest bib
  float lightM = uUnder * smoothstep(0.1, 0.75, -n.y) + uFront * smoothstep(0.35, 0.95, n.z) * smoothstep(0.5, -0.3, n.y);
  c = mix(c, uLight, clamp(lightM, 0.0, 1.0) * (1.0 - 0.6 * patchM));
  // fine hair grain
  c *= 0.95 + 0.1 * noise3(p * 140.0) + 0.04 * (noise3(p * vec3(30.0, 300.0, 30.0)) - 0.5);
  if (uShellH > 0.0) {
    float h = hash3(floor(p * 170.0));
    if (h < uShellH * 1.1) discard;
    c *= mix(0.95, 1.08, uShellH);
  } else {
    c *= 0.93; // under-coat a touch darker, reads as depth
  }
  diffuseColor.rgb = c;
}
`;

/**
 * Fur material. `M` is the part's local matrix relative to its joint, so all
 * parts hanging off the same joint share one continuous merle pattern.
 */
function furMaterial(o, M, shell = 0, shellH = 0) {
  const mat = new THREE.MeshPhysicalMaterial({
    roughness: o.roughness ?? 0.8,
    metalness: 0,
    sheen: 0.5,
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color('#fff0e0'),
    side: o.side ?? THREE.FrontSide,
  });
  const u = {
    uBase: { value: new THREE.Color(o.base ?? PALETTE.base) },
    uPatch: { value: new THREE.Color(o.patch ?? PALETTE.patch) },
    uDark: { value: new THREE.Color(o.dark ?? PALETTE.dark) },
    uLight: { value: new THREE.Color(o.light ?? PALETTE.light) },
    uPatchAmt: { value: o.patchAmt ?? 1 },
    uPatchScale: { value: o.patchScale ?? 6.5 },
    uPatchT: { value: o.patchT ?? 0.52 },
    uUnder: { value: o.under ?? 0 },
    uFront: { value: o.front ?? 0 },
    uSeed: { value: o.seed ?? 0 },
    uM: { value: M.clone() },
    uShell: { value: shell },
    uShellH: { value: shellH },
  };
  mat.userData.u = u;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform mat4 uM; uniform float uShell; varying vec3 vP; varying vec3 vJN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvP = (uM * vec4(position, 1.0)).xyz; vJN = mat3(uM) * normal;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nmvPosition.xyz += normalize(normalMatrix * objectNormal) * uShell;\ngl_Position = projectionMatrix * mvPosition;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FUR_FRAG_DECL)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FUR_FRAG_BODY);
  };
  mat.customProgramCacheKey = () => 'chunky-fur';
  return mat;
}

function eyeMaterial() {
  const mat = new THREE.MeshPhysicalMaterial({
    roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.4,
  });
  const u = {
    uPupil: { value: 0.24 },
    uIris: { value: new THREE.Color(PALETTE.iris) },
    uIrisIn: { value: new THREE.Color(PALETTE.irisInner) },
    uRing: { value: new THREE.Color(PALETTE.irisRing) },
  };
  mat.userData.u = u;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEP = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uPupil; uniform vec3 uIris; uniform vec3 uIrisIn; uniform vec3 uRing; varying vec3 vEP;
        ${NOISE_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 n = normalize(vEP);
          float a = acos(clamp(n.z, -1.0, 1.0));
          float ang = atan(n.y, n.x);
          float irisR = 0.9;
          vec3 sclera = vec3(0.30, 0.22, 0.21); // dogs show almost no white: read as dark rim
          float streak = noise3(vec3(ang * 9.0, a * 14.0, 1.7));
          vec3 iris = mix(uIrisIn, uIris, smoothstep(uPupil, irisR, a));
          iris = mix(iris, uRing, (1.0 - smoothstep(uPupil, uPupil + 0.12, a)) * 0.8);
          iris *= 0.8 + 0.35 * streak;
          iris = mix(iris, vec3(0.15, 0.17, 0.18), smoothstep(irisR - 0.08, irisR, a)); // limbal ring
          vec3 c = mix(iris, sclera, smoothstep(irisR - 0.01, irisR + 0.02, a));
          c = mix(vec3(0.015), c, smoothstep(uPupil - 0.02, uPupil + 0.02, a));
          diffuseColor.rgb = c;
        }`);
  };
  mat.customProgramCacheKey = () => 'chunky-eye';
  return mat;
}

// ------------------------------------------------------------------ builder
export function buildChunky() {
  const root = new THREE.Group();
  root.name = 'chunky';
  const J = {};             // joints by name
  const contacts = [];      // ellipsoid parts that can touch the ground
  const hitMeshes = [];     // meshes used for mouse hit-testing
  const eyeMats = [];

  const joint = (name, parent, p = [0, 0, 0], r = [0, 0, 0]) => {
    const j = new THREE.Group();
    j.name = name;
    j.position.set(...p);
    j.rotation.set(...r);
    parent.add(j);
    J[name] = j;
    return j;
  };

  // A fur part: ellipsoid (or custom geo) with shells for fuzz.
  const fur = (parent, s, p, r = [0, 0, 0], o = {}) => {
    const mesh = new THREE.Mesh(o.geo || SPHERE);
    mesh.scale.set(...s);
    mesh.position.set(...p);
    mesh.rotation.set(...r);
    mesh.updateMatrix();
    mesh.material = furMaterial(o, mesh.matrix);
    mesh.castShadow = true;
    parent.add(mesh);
    hitMeshes.push(mesh);
    if (o.contact) contacts.push(mesh);
    if (o.shells !== false) {
      for (let i = 1; i <= FUR_SHELLS; i++) {
        const h = i / (FUR_SHELLS + 1);
        const shell = new THREE.Mesh(mesh.geometry, furMaterial(o, mesh.matrix, FUR_THICKNESS * h, h));
        shell.raycast = () => {};
        shell.renderOrder = i;
        mesh.add(shell);
      }
    }
    return mesh;
  };

  const solid = (parent, s, p, r, mat, o = {}) => {
    const mesh = new THREE.Mesh(o.geo || SPHERE, mat);
    mesh.scale.set(...s);
    mesh.position.set(...p);
    mesh.rotation.set(...r);
    mesh.castShadow = o.shadow ?? true;
    parent.add(mesh);
    if (o.hit !== false) hitMeshes.push(mesh);
    return mesh;
  };

  const MUZZLE = { base: PALETTE.muzzle, patch: PALETTE.muzzlePatch, light: PALETTE.muzzleLight, patchScale: 15, patchT: 0.48, front: 0.35, seed: 3 };
  const BODY = { under: 0.9, front: 0.0, seed: 1, patchAmt: 0.65, patchT: 0.55 };

  // capsule limb hanging down from its joint (top of capsule at the joint)
  const capCache = {};
  const limb = (parent, r, len, rot, o) => {
    const key = r + ':' + len;
    if (!capCache[key]) capCache[key] = new THREE.CapsuleGeometry(r, len, 10, 24).translate(0, -len / 2, 0);
    return fur(parent, [1, 1, 1], [0, 0, 0], rot, { ...o, geo: capCache[key] });
  };

  // ---------------------------------------------------------- hips & hind
  const hips = joint('hips', root, [0, 0.30, -0.15]);
  fur(hips, [0.152, 0.148, 0.15], [0, 0.035, -0.03], [0, 0, 0], { ...BODY, contact: true });

  for (const side of [1, -1]) {
    const S = side > 0 ? 'L' : 'R';
    const hip = joint('hip' + S, hips, [0.098 * side, 0.0, 0.0]);
    // big muscular haunch
    fur(hip, [0.072, 0.122, 0.104], [0.016 * side, -0.058, 0.022], [-0.12, 0, 0], { ...BODY, under: 0.25, contact: true });
    const knee = joint('knee' + S, hip, [0.012 * side, -0.14, 0.06]);
    limb(knee, 0.04, 0.08, [0.35, 0, 0], { ...BODY, under: 0.5 });
    const hock = joint('hock' + S, knee, [0, -0.115, -0.045]);
    limb(hock, 0.032, 0.06, [0, 0, 0], { ...BODY, under: 0.9, front: 0.5 });
    const paw = joint('hpaw' + S, hock, [0, -0.095, 0]);
    pawParts(paw, 0.92);
  }

  const tail = joint('tail', hips, [0, 0.09, -0.16], [0.5, 0, 0]);
  fur(tail, [0.03, 0.028, 0.04], [0, 0, -0.018], [0, 0, 0], { ...BODY, patchAmt: 1.2 });

  // ------------------------------------------------- barrel chest & front legs
  const spine = joint('spine', hips, [0, 0.02, 0.05]);
  fur(spine, [0.172, 0.168, 0.25], [0, -0.002, 0.14], [0, 0, 0], { ...BODY, front: 1, contact: true });

  for (const side of [1, -1]) {
    const S = side > 0 ? 'L' : 'R';
    // Frenchie front legs: set wide, slightly bowed
    const sh = joint('sh' + S, spine, [0.106 * side, -0.06, 0.255], [0, 0, 0.06 * side]);
    limb(sh, 0.056, 0.085, [0, 0, 0], { ...BODY, under: 0.2, front: 0.5 });
    const el = joint('el' + S, sh, [0, -0.135, -0.005], [0, 0, -0.08 * side]);
    limb(el, 0.041, 0.095, [0, 0, 0], { ...BODY, front: 0.7, under: 0.5 });
    const wr = joint('wr' + S, el, [0, -0.14, 0.0]);
    pawParts(wr, 1);
  }

  function pawParts(parent, size) {
    const P = { ...BODY, light: PALETTE.light, under: 1, front: 1, patchAmt: 0.3, contact: true };
    fur(parent, [0.044 * size, 0.025, 0.056 * size], [0, -0.012, 0.024], [0, 0, 0], P);
    for (let i = 0; i < 4; i++) {
      const x = (i - 1.5) * 0.02 * size;
      fur(parent, [0.014, 0.015, 0.018], [x, -0.012, 0.066 - Math.abs(i - 1.5) * 0.01], [0, 0, 0], { ...P, shells: false });
    }
  }

  // ------------------------------------------------------------ neck & head
  const neck = joint('neck', spine, [0, 0.075, 0.33]);
  fur(neck, [0.145, 0.13, 0.12], [0, 0.02, 0.0], [0, 0, 0], { ...BODY, front: 0.7, seed: 1 });
  const head = joint('head', neck, [0, 0.11, 0.06]);
  const HEAD = { under: 0.15, seed: 5, patchScale: 8, patchT: 0.46 };
  fur(head, [0.198, 0.158, 0.158], [0, 0.03, -0.012], [0, 0, 0], HEAD);           // broad skull
  fur(head, [0.178, 0.08, 0.12], [0, 0.1, -0.03], [0, 0, 0], HEAD);               // flat top between the ears
  fur(head, [0.072, 0.06, 0.05], [0, 0.045, 0.118], [0, 0, 0], { ...HEAD, shells: false }); // stop between eyes
  for (const side of [1, -1]) {
    fur(head, [0.104, 0.1, 0.098], [0.1 * side, -0.035, 0.045], [0, 0, 0], HEAD);  // cheeks
    // heavy flews (jowls)
    fur(head, [0.06, 0.066, 0.05], [0.048 * side, -0.078, 0.13], [0, 0, 0.15 * side], MUZZLE);
    // darker merle "eyeliner" around the eye
    fur(head, [0.058, 0.052, 0.03], [0.086 * side, 0.03, 0.105], [0, 0.28 * side, 0], { ...HEAD, patch: PALETTE.dark, patchAmt: 1.6, patchT: 0.35, shells: false });
  }
  fur(head, [0.08, 0.042, 0.046], [0, -0.03, 0.142], [0, 0, 0], MUZZLE);
  // the classic frenchie wrinkle roll over the nose
  fur(head, [0.052, 0.016, 0.022], [0, 0.024, 0.158], [-0.2, 0, 0], { ...MUZZLE, shells: false });
  // nose
  const noseMat = new THREE.MeshPhysicalMaterial({ color: PALETTE.nose, roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.3 });
  solid(head, [0.05, 0.032, 0.026], [0, -0.004, 0.182], [0.25, 0, 0], noseMat);
  const nostrilMat = new THREE.MeshStandardMaterial({ color: '#1d1414', roughness: 0.6 });
  for (const side of [1, -1]) solid(head, [0.013, 0.008, 0.006], [0.02 * side, -0.01, 0.205], [0, 0, 0.45 * side], nostrilMat, { hit: false });

  // jaw: opens for barks / panting
  const jaw = joint('jaw', head, [0, -0.06, 0.04]);
  fur(jaw, [0.06, 0.032, 0.062], [0, -0.066, 0.088], [0, 0, 0], { ...MUZZLE, contact: true });
  solid(jaw, [0.055, 0.018, 0.055], [0, -0.046, 0.095], [0, 0, 0], new THREE.MeshStandardMaterial({ color: PALETTE.mouth, roughness: 0.6 }), { hit: false });
  const tongue = joint('tongue', jaw, [0, -0.045, 0.1]);
  const tongueMat = new THREE.MeshPhysicalMaterial({ color: PALETTE.tongue, roughness: 0.35, clearcoat: 0.4 });
  solid(tongue, [0.03, 0.008, 0.052], [0, 0, 0.018], [0, 0, 0], tongueMat, { hit: false });

  // eyes + lids + brows
  const lidGeoTop = new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
  const lidGeoBot = new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  for (const side of [1, -1]) {
    const S = side > 0 ? 'L' : 'R';
    const socket = joint('socket' + S, head, [0.086 * side, 0.032, 0.136], [0, 0.28 * side, 0]);
    const eye = joint('eye' + S, socket);
    const em = eyeMaterial();
    eyeMats.push(em);
    solid(eye, [0.036, 0.036, 0.036], [0, 0, 0], [0, 0, 0], em, { shadow: false });
    const LID = { ...HEAD, patch: PALETTE.dark, patchAmt: 1.5, patchT: 0.35, side: THREE.DoubleSide, shells: false };
    const lu = joint('lidU' + S, socket, [0, 0, 0], [-0.8, 0, 0]);
    fur(lu, [0.0395, 0.0395, 0.0395], [0, 0, 0], [0, 0, 0], { ...LID, geo: lidGeoTop });
    const ll = joint('lidL' + S, socket, [0, 0, 0], [0.8, 0, 0]);
    fur(ll, [0.039, 0.039, 0.039], [0, 0, 0], [0, 0, 0], { ...LID, geo: lidGeoBot });
    const brow = joint('brow' + S, head, [0.08 * side, 0.072, 0.118], [0, 0.28 * side, -0.18 * side]);
    fur(brow, [0.036, 0.01, 0.02], [0, 0, 0], [0, 0, 0], { ...HEAD, shells: false });
  }

  // big bat ears, cupped, facing forward
  const earGeo = makeEarGeometry(1);
  const earInGeo = makeEarGeometry(0.84);
  for (const side of [1, -1]) {
    const S = side > 0 ? 'L' : 'R';
    const ear = joint('ear' + S, head, [0.1 * side, 0.15, -0.045], [-0.05, 0.3 * side, -0.32 * side]);
    fur(ear, [1, 1, 1], [0, 0, 0], [0, 0, 0], { geo: earGeo, side: THREE.DoubleSide, patchScale: 13, patchT: 0.42, seed: 9 + side, patchAmt: 1.2, shells: false });
    fur(ear, [1, 1, 1], [0, 0.014, 0.008], [0, 0, 0], { geo: earInGeo, base: PALETTE.earInner, patch: '#8d7274', dark: '#7a6164', patchScale: 18, patchT: 0.45, patchAmt: 1, side: THREE.DoubleSide, shells: false, roughness: 0.6 });
  }

  root.traverse((o) => { if (o.isMesh) o.receiveShadow = false; });

  // Remember rest rotations so poses can leave joints at their defaults.
  const rest = {};
  for (const [k, j] of Object.entries(J)) rest[k] = [j.rotation.x, j.rotation.y, j.rotation.z];

  return { root, J, rest, contacts, hitMeshes, eyeMats };
}

function makeEarGeometry(scale) {
  const s = new THREE.Shape();
  const k = scale;
  s.moveTo(-0.05 * k, 0);
  s.bezierCurveTo(-0.08 * k, 0.06 * k, -0.086 * k, 0.13 * k, -0.05 * k, 0.172 * k);
  s.quadraticCurveTo(0, 0.205 * k, 0.05 * k, 0.172 * k);
  s.bezierCurveTo(0.086 * k, 0.13 * k, 0.08 * k, 0.06 * k, 0.05 * k, 0);
  s.quadraticCurveTo(0, -0.012 * k, -0.05 * k, 0);
  const g = new THREE.ShapeGeometry(s, 24);
  // cup the ear: edges forward, centre back
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const nx = x / (0.082 * k);
    pos.setZ(i, 0.035 * nx * nx - 0.018 + 0.03 * Math.max(0, 0.08 - y));
  }
  g.computeVertexNormals();
  return g;
}

export function buildPoop() {
  const g = new THREE.Group();
  const mat = new THREE.MeshPhysicalMaterial({ color: PALETTE.poop, roughness: 0.45, clearcoat: 0.35 });
  const add = (r, y, sy) => {
    const m = new THREE.Mesh(SPHERE, mat);
    m.scale.set(r, sy, r);
    m.position.y = y;
    m.castShadow = true;
    g.add(m);
  };
  add(0.05, 0.022, 0.026);
  add(0.037, 0.05, 0.022);
  add(0.024, 0.073, 0.019);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.013, 0.03, 16), mat);
  tip.position.y = 0.095;
  tip.rotation.z = 0.3;
  g.add(tip);
  return g;
}
