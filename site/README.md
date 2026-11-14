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
python3 site/build.py && python3 -m http.server -d site/dist 8000   # page only; /api needs Cloudflare
```

## Checkout (Cloudflare Pages Functions)
- `functions/api/order.js` (POST): saves the 4 photos to the private R2 bucket `desktopsidekicks-orders`
  (binding `ORDERS`), then returns a $20 Stripe Checkout URL.
- `functions/api/stripe-webhook.js` (POST): verifies Stripe's signature, marks the order paid, writes
  `queue/paid/<id>` for the pet-making worker, and emails a confirmation through Postmark.
- `functions/api/order-status.js` (GET): status for the thank-you window.
- `lib/orders.js`: shared helpers. R2 layout: `orders/<id>/order.json`, `orders/<id>/photos/*`.

Cloudflare Pages project `desktopsidekicks`: root `site`, build `python3 build.py`, output `dist`.
Secrets (Pages > Settings > Variables and secrets): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
(set from the Stripe webhook endpoint), `POSTMARK_TOKEN`. Price: $20 (`PRICE_CENTS`).
