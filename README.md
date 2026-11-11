# Chunky 🐶

Chunky the French Bulldog lives in the bottom-right corner of your Mac. He's
rendered live in 3D, and **his head and eyes follow your mouse** wherever it is
on screen.

## What he does

| | |
|---|---|
| 👀 **Watches your cursor** | head turns, eyes track, anywhere on screen |
| 🐾 **Sits, stands up, lies down** | and switches between them on his own every so often |
| 😴 **Sleeps** | after 30 s without mouse movement he lies down, closes his eyes, Zzz… Move the mouse and he wakes up |
| 🍑 **Wags** | stub-tail wag + full Frenchie butt-wiggle |
| 🥺 **Puppy-dog eyes** | big pupils, worried brows, ears back; he does it on his own if you hover near him |
| 😛 **Pants** | tongue out when your cursor comes close |
| 🥰 **Petting** | hover over his head: happy squint, ears relax |
| 🗣️ **Barks** | click him |
| 💩 **Poops** | squats, trembles, drops it, kicks his back legs proudly. Rarely on his own, or from the menu |
| ✋ **Drag him** | anywhere on screen |

**Right-click Chunky** or use the 🐾 **menu-bar icon** to pick an action, send
him back to the corner, hide him, or quit. Clicks pass straight through the
empty space around him, so he never blocks your work.

## Run it (macOS)

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm start
```

## Build a .dmg

```bash
npm run dist
```

The app appears in `dist/`. It isn't code-signed, so the first time you open it,
right-click the app → **Open**.

## How it's made (100% free / open source)

- **[Electron](https://www.electronjs.org)**: transparent, always-on-top, click-through window
- **[three.js](https://threejs.org)** (MIT): real-time 3D rendering with soft shadows and reflections
- **Chunky's model is built in code** (`src/chunky.js`): a rig of joints with
  smooth shapes, shaped like a French Bulldog. His colours were sampled from his
  photos: fawn coat, lilac merle patches, light chest, pink-grey mottled muzzle,
  pale blue-grey eyes. A custom shader paints the merle pattern and a short-fur
  shell effect.
- Animations are procedural (`src/app.js`): poses blend smoothly, with
  breathing, blinking, ear twitches, wagging and look-at-cursor layered on top.

## Tweaking him

- **Colours:** `PALETTE` at the top of `src/chunky.js`
- **Poses:** `POSES` in `src/app.js` (joint angles in radians)
- **How often he does things / sleep timer:** `autonomy()` in `src/app.js`
- **Size:** `WIN_W` / `WIN_H` in `src/main.js`, and the camera distance in `src/app.js`

## Upgrading to a photoreal model later

The renderer can take any rigged `.glb` model. If you later get a photoreal
rigged French Bulldog (from a 3D artist, a marketplace, or an AI image-to-3D
tool), it can replace the procedural model while keeping the same behaviours.
