# Desktop Sidekicks: marketing site

A desktop-style landing page (desktopsidekicks.com). The menu bar, desktop icons and draggable
windows are About, How it works, Pricing, FAQ, Create your pet and Welcome. Chunky sits in the
bottom-right corner, follows the mouse, and has Sit / Sleep / Poop / Stand buttons.

- `index.html`: the page. All CSS and JS is inline.
- `pet.html`: the frame that runs the product player (`petgen/engine/app.js`) through a
  postMessage `dogApi` bridge.
- `build.py`: assembles `site/dist/` from the page, the player and copies of Chunky's footage.
  Chunky's own files are only read.

```bash
python3 site/build.py && python3 -m http.server -d site/dist 8000
```

Not wired yet: checkout (Stripe), uploads (R2) and email (Postmark). The Create form validates
in the browser and says checkout isn't connected. Launch price: $20.
