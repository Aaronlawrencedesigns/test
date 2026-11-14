# Chunky: project notes for Claude

Chunky is the owner's real French Bulldog (lilac fawn merle, pale blue-grey eyes,
bat ears). This repo is a desktop pet: realistic AI footage of Chunky that sits in
the bottom-right corner and turns his head to follow the mouse.

## Two front-ends, one engine
- **Mac app (Electron):** `src/main.js` (transparent always-on-top click-through
  window, tray + right-click menus incl. Size, global cursor feed),
  `src/preload.js` (bridge `window.dogApi`), `src/index.html`, `src/style.css`.
  Run: `npm install && npm start`. The owner runs it from `~/chunky` on their Mac
  (`git pull` to update). Mac only.
- **Web version / Claude Artifact:** `web/index.html` (page + controls) embeds
  `web/chunky.html` (frame with a `dogApi` shim fed by `postMessage`).
  Published at https://claude.ai/artifact/CxY7zRmwo3guYXh3Uf5Qoc. To update,
  publish `web/index.html` again with the same `url` and the same `files` map
  (chunky.html, portrait.webp, app.js ← src/app.js, style.css ← src/style.css,
  and every file under assets/gaze, assets/stills, assets/clips, assets/look).
  The artifact still holds unused old files under assets/head and assets/sweep;
  remove them (map each path to null) if a publish ever hits the 511-file limit.
- **Shared engine:** `src/app.js` (both use it). `window.CHUNKY_ASSETS` sets the asset path.

## How the animation works
- Resting states `sit | lie | sleep`. Sitting head-tracking shows exactly ONE
  real video frame at a time (never blended → never blurry/ghosted):
  `assets/look/{row}_{i}.webp`, rows = 5 head heights (0 up, 1 slightly up,
  2 level, 3 slightly down, 4 down), i = 0..32 far left → far right, cropped to
  the box in `LOOK` in `src/app.js` (copy from `assets/look/meta.json` if rebuilt).
  Pipeline: Seedance head-sweep clips (far-left → far-right keyframes
  `assets/keyframes/gaze_{0|4}_{0|1|2|hu|hd}.png`, made by
  `tools/gaze_keyframes.py`) → `tools/build_sweeps.py ROW:REF[:U0-U1] clip.mp4 …`
  (turn progress = accumulated head movement; half-sweeps fill halves where a
  full sweep turned too fast. Used: `0:0 sweep_0, 0:0:0-2 half_up_left,
  1:0 sweep_hu, 1:0:0-2 half_hu_left, 2:1 sweep_1, 2:1:2-4 half_lvl_right,
  3:1 sweep_hd, 3:1:2-4 half_hd_right, 4:2 sweep_2`; every row has 33
  distinct frames) →
  `tools/build_look_frames.py`. Head follows the cursor with a critically damped
  spring (stiffness 24); cursor polled at ~120 Hz. Optical-flow in-betweens and
  head/body compositing were tried and dropped: both blur or ghost.
  Fallback until frames load: the 5x3 grid `assets/gaze/{col}_{row}.webp`.
- All assets share one 640x640 frame (`CROP_1024`/`OUT_SIZE` in `tools/key.py`,
  square so he can stand on his hind legs); the Mac window is 400x400 at Normal
  (taller while the food tray is open).
- Actions are transparent VP9 WebM clips (`assets/clips/*.webm`, 640x640) that
  start/end on keyframes; `CLIPS` and `ROUTES` in `src/app.js` define the graph.
  Every cut is crossfaded (280 ms).
- Sleep chosen from a menu/button (`S.stayAsleep`) lasts until another action is
  chosen; mouse moves and clicks don't wake him. Idle-triggered naps still wake on mouse move.
- Nap: after `NAP_AFTER_MS` (30 s) without mouse movement he goes to sleep
  (`S.napping`) and wakes as soon as the mouse moves. Only the owner's activity
  resets the timer (`act(..., fromUser)`); his own idle tricks don't, and tricks
  only happen while the owner is active.
- Lying down on his own: he gets back up after 5–10 s (`S.lieUntil`). "Lie down"
  chosen from the menu (`S.userLie`) lasts until another action. The lie still breathes.
- Bark only plays when chosen from the menu/button: it's left out of his idle
  routine and of the random tricks on click (the owner found it distracting).
- Feeding: menu "Feed Chunky" / web "Feed" button sends action `feed`, which
  toggles a vertical food tray floating above his head (`TRAY_LIFT` = gap, a quarter
  of his width, 100px at Normal; `#tray`, foods in
  `FOODS` in `src/app.js`). His square is the BOTTOM of the window (`SZ()`,
  `stageTop()`); while the tray is open the window grows upward via
  `dogApi.setExtraTop(px)` (Electron: `extend` IPC; web: `extend` message to the page). Dragging a food
  onto him (dog pixels or near `MOUTH`) runs `act('eat:<food>')`: three bites with
  crumbs, then the `eat` clip (chew + lick lips), then `wag`. A miss floats the food
  back. The tray and a held food count as "over" for click-through.
- To add an action: generate clip → convert → add to `CLIPS` in `src/app.js`,
  the menu in `src/main.js`, and a button in `web/index.html`.

## Generating new footage (costs real money: ask the owner first)
- Provider: **GPTProto** (gptproto.com). Key is saved as a network secret on the
  cloud environment **"test"** (the proxy injects it; scripts use
  `GPTPROTO_API_KEY` or the placeholder `proxy-injected`). Never print or commit keys.
- Images: Nano Banana Pro via the OpenAI-style chat endpoint
  (`tools/generate/chatimg.mjs`, model `gemini-3-pro-image-preview`), which accepts
  base64 images. The v3 image API only takes URLs.
- Video: Seedance 2.0 Mini first/last-frame (`tools/generate/clip.mjs`,
  prompts in `tools/generate/clips.sh`), ~$0.20 per 5 s clip. Keyframes are read
  from this public repo's raw GitHub URLs, so push new keyframes first.
  `camera_fixed` is not allowed together with `last_image`.
  Jobs finish with status `succeeded` (not `completed`).
  Results download from `ark-acg-ap-southeast-1.tos-ap-southeast-1.volces.com`
  (allowed on the "test" environment).
- Node's fetch needs `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt`
  in the cloud container.
- Convert: `python3 tools/clip2webm.py in.mp4 assets/clips/x.webm --fit-start sit --fit-end sit`
  (chroma key + eases framing drift onto the keyframes). Use `--spread` for clips
  whose framing drifts a lot (lie_down, get_up, wake_up): the correction is spent
  while he moves, so he never visibly shrinks/grows at the end. Stills/gaze:
  `tools/build_stills.py`. Shared crop/size: `CROP_1024`, `OUT_SIZE` in `tools/key.py`.
- Green-screen keyframes: `assets/keyframes/` (sit, lie, sleep, sleep_side, master_studio).

## Signing / notarization
Owner has an Apple Developer account. `npm run dist:signed` = electron-builder with
hardened runtime + `build/entitlements.mac.plist`, signed by the Developer ID cert in
the owner's Keychain, notarized via the Keychain profile `chunky-notary`
(`APPLE_KEYCHAIN_PROFILE`; created with `xcrun notarytool store-credentials`).
Without credentials, notarization is skipped silently. Steps are in README.md.
Signing can only run on the owner's Mac (not in the cloud container).

## Product: Desktop Sidekicks (desktopsidekicks.com)
The owner is turning this into a product: customers upload 4 pet photos, pay, and
get their own desk pet. Milestone 1 is `petgen/` (see petgen/README.md): photos →
pet pack + preview + QA report, automated with quality gates and retries, cached.
**Keep Chunky separate:** the owner wants Chunky's app kept as-is for himself.
Product work lives in `petgen/` and must NOT change Chunky's `src/`, `web/`,
`assets/` or `tools/`. The product has its own copy of the player in
`petgen/engine/` (reads per-pet measurements from `window.PET`: look, head,
mouth, earTop). Test for free with `--replay`. Never use `--host git` for real
customers (public repo).

## Owner's Mac setup quirks (already solved)
- `~/.npm` had root-owned files → fixed with `sudo chown -R $(id -u):$(id -g) ~/.npm`.
- Newer npm skips dependency install scripts and Electron's downloader is silent
  on Node 26 → `scripts/install-electron.js` (postinstall) falls back to
  downloading the official Electron zip and unpacking with `ditto`.

## Ideas not done yet
More tricks (stretch, roll over, head tilt), sound.
The `stand` clip is him standing on his hind legs (the model's reading of "stand up").
