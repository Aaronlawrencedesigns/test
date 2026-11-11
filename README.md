# Chunky 🐶

Chunky the French Bulldog lives in the bottom-right corner of your Mac. He's
built from **realistic AI-generated footage of Chunky**, made from his real
photos, and **he turns his head to watch your mouse** wherever it is on screen.

## What he does

| | |
|---|---|
| 👀 **Watches your cursor** | turns his head toward it: left, right, up, down |
| 🍑 **Happy wiggle** | stands up, butt-wiggles with his tongue out, sits back down |
| 🗣️ **Barks** | click him |
| 🥺 **Puppy-dog eyes** | head tilt, pleading look |
| 🛋️ **Lies down / gets up** | on his own every so often, or from the menu |
| 😴 **Sleeps** | after 30 s without mouse movement: yawns, falls asleep, breathes, Zzz… Move the mouse and he wakes up with a big stretch |
| 💩 **Poops** | rarely, on his own, or from the menu |
| ✋ **Drag him** | anywhere on screen |

**Right-click Chunky** or use the 🐾 **menu-bar icon** to pick an action, send
him back to the corner, hide him, or quit. Clicks pass straight through
everything around him, so he never blocks your work.

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

## How it's made

1. **Keyframes:** Google's *Nano Banana Pro* image model (via
   [GPTProto](https://gptproto.com)) generated photoreal images of Chunky from
   his 4 photos, on a green screen: sitting, lying, sleeping.
   → `assets/keyframes/`
2. **Head directions:** 15 edits of the sitting keyframe looking in a 5×3 grid
   of directions. Each turned head is composited onto one shared body, so
   only the head moves. → `assets/gaze/`
3. **Clips:** ByteDance *Seedance 2.0 Mini* animated each action from a
   first and last keyframe, so every clip starts and ends on a resting pose
   and they chain together. → `assets/clips/`
4. **Cut-out:** `tools/clip2webm.py` chroma-keys the green screen into
   transparent VP9 WebM, and gently corrects any framing drift at the start
   and end of each clip so nothing pops between clips.
5. **App:** Electron with a transparent, always-on-top, click-through window.
   `src/app.js` swaps head directions as your cursor moves and plays the clips
   through a small state machine (sit ⇄ lie → sleep → sit).

Total generation cost was roughly **$4** in API credits.

## Making new animations

Everything used to generate him is in `tools/generate/`. Set your own key in
your shell (never commit it), then:

```bash
cd tools/generate
export GPTPROTO_API_KEY=your-key
./clips.sh wag            # regenerate one clip (see clips.sh for prompts)
python3 ../clip2webm.py clips/wag.mp4 ../../assets/clips/wag.webm --fit-start sit --fit-end sit
```

To add a new action: add a line to `clips.sh`, convert it, then add it to
`CLIPS` in `src/app.js` and to the menu in `src/main.js`.

## Files

- `src/main.js`: window, menu-bar icon, right-click menu, global cursor feed
- `src/app.js`: head tracking, clip playback, behaviour (idle, nap, wake)
- `assets/`: footage, stills and keyframes
- `tools/`: chroma keyer, clip converter, generation scripts
