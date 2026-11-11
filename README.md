# Desk Dog 🐶

A little desktop buddy: a dog sits in the bottom-right corner of your screen and
**his eyes (and head) follow your mouse** wherever it goes.

## What he does

- 👀 **Watches your cursor** anywhere on screen, with his head leaning toward it
- 😊 **Gets excited** when the cursor comes close: tail wags faster, tongue out
- 🥰 **Hover over his head** to pet him: he closes his eyes happily
- 🎾 **Click him** for a random trick (jump, spin, head tilt, wiggle) plus a bark
- ✋ **Drag him** anywhere on screen
- 😴 **Naps** after 25 seconds without mouse movement (Zzz…), and jumps awake when you move
- Blinks and twitches his ears on his own
- Right-click (or the tray icon) for **Back to corner** / **Quit**

Clicks pass straight through the empty space around him, so he never blocks
what's underneath.

## Run it

You need [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm start
```

## Build an installer

```bash
npm run dist
```

This makes a `.dmg` (macOS), `.exe` (Windows) or `.AppImage` (Linux) in `dist/`.

## Make him look like *your* dog

All the colors are at the top of `src/style.css`:

```css
--fur: #c98b4f;        /* main coat */
--fur-dark: #8a5a2f;   /* ears + haunches */
--fur-light: #f3dfc1;  /* muzzle, chest, paws, blaze */
--collar: #d6453d;
```

The drawing itself is the SVG in `src/index.html`. Barks, tricks and the nap
timer are at the top of `src/renderer.js`.

## Files

- `src/main.js`: the window (transparent, always-on-top, bottom-right), tray icon, and the global cursor feed
- `src/renderer.js`: eye tracking, blinking, napping, tricks, dragging
- `src/index.html` + `src/style.css`: the dog and his animations
