// Desktop Sidekicks orders: shared by the Pages Functions in ../functions/api/.
// Storage (R2 binding ORDERS, private bucket "desktopsidekicks-orders"):
//   orders/<id>/order.json          order record (status: awaiting_payment -> paid -> ...)
//   orders/<id>/photos/<view>.<ext> the customer's 4 photos
//   queue/paid/<id>                 marker the pet-making worker picks up
// Secrets (Pages > Settings > Variables and secrets): STRIPE_SECRET_KEY,
// STRIPE_WEBHOOK_SECRET, POSTMARK_TOKEN.

export const PRICE_CENTS = 2000;
export const CURRENCY = 'usd';
export const VIEWS = ['front', 'side', 'back', 'sit'];
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
export const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' };
export const FROM = 'Desktop Sidekicks <hello@desktopsidekicks.com>';

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export const validId = (id) => typeof id === 'string' && /^[a-z0-9]{20,40}$/.test(id);
export const newId = () => crypto.randomUUID().replace(/-/g, '');
export const validEmail = (e) => typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

export async function getOrder(env, id) {
  const obj = await env.ORDERS.get(`orders/${id}/order.json`);
  return obj ? obj.json() : null;
}
export const putOrder = (env, order) =>
  env.ORDERS.put(`orders/${order.id}/order.json`, JSON.stringify(order, null, 2), { httpMetadata: { contentType: 'application/json' } });

// ---------------------------------------------------------------- Stripe
export async function stripe(env, path, params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.append(k, String(v));
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`stripe ${path}: ${data.error?.message || r.status}`);
  return data;
}

// GET from Stripe (e.g. a payment's fee); returns null instead of throwing, for best-effort lookups
export async function stripeGet(env, path) {
  try {
    const r = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// Stripe's fee for an order's payment, in cents (null if Stripe doesn't have it yet / the key can't read it)
export async function stripeFee(env, paymentIntent) {
  if (!paymentIntent) return null;
  const pi = await stripeGet(env, `payment_intents/${encodeURIComponent(paymentIntent)}?expand[]=latest_charge.balance_transaction`);
  const fee = pi?.latest_charge?.balance_transaction?.fee;
  return Number.isFinite(fee) ? fee : null;
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
/** Verifies a Stripe-Signature header (t=...,v1=...) against the raw body. */
export async function verifyStripeSignature(raw, header, secret, toleranceSec = 300, now = Date.now() / 1000) {
  if (!header || !secret) return false;
  const parts = {};
  const sigs = [];
  for (const p of header.split(',')) {
    const [k, v] = p.split('=');
    if (k === 't') parts.t = v;
    if (k === 'v1') sigs.push(v);
  }
  if (!parts.t || !sigs.length || Math.abs(now - Number(parts.t)) > toleranceSec) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${parts.t}.${raw}`)));
  return sigs.some((s) => safeEqual(s, mac));
}

// ---------------------------------------------------------------- email
export async function sendEmail(env, { to, subject, text, html, tag }) {
  if (!env.POSTMARK_TOKEN) return { skipped: 'no POSTMARK_TOKEN' };
  const r = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': env.POSTMARK_TOKEN },
    body: JSON.stringify({ From: FROM, ReplyTo: env.REPLY_TO || undefined, To: to, Subject: subject, TextBody: text, HtmlBody: html, Tag: tag, MessageStream: 'outbound' }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ErrorCode) throw new Error(`postmark: ${data.Message || r.status}`);
  return data;
}

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function confirmationEmail(order) {
  const pet = order.pet_name || 'your pet';
  const text = `Thanks for your order!

We've got your photos of ${pet} and payment of $${(order.amount_total / 100).toFixed(2)}.

What happens next: we make ${pet}'s portrait, poses, head-turn footage and every trick, then check each one for size, colour and framing. When ${pet} passes, we email you a download link for your Desktop Sidekick (a Mac app). That's usually within a day.

Order: ${order.id}

Desktop Sidekicks
https://desktopsidekicks.com`;
  const html = `<div style="font:16px/1.55 -apple-system,system-ui,sans-serif;color:#221d27;max-width:520px">
<h1 style="font-size:24px;margin:0 0 12px">We're making ${esc(pet)}</h1>
<p>Thanks for your order! We've got your photos of ${esc(pet)} and your payment of $${(order.amount_total / 100).toFixed(2)}.</p>
<p>Next, we make ${esc(pet)}'s portrait, poses, head-turn footage and every trick, then check each one for size, colour and framing. When ${esc(pet)} passes, we'll email you a download link for your Desktop Sidekick (a Mac app). That's usually within a day.</p>
<p style="color:#6a6170;font-size:13px">Order ${esc(order.id)}<br>Desktop Sidekicks &middot; <a href="https://desktopsidekicks.com" style="color:#2f45c4">desktopsidekicks.com</a></p>
</div>`;
  return { subject: `We're making ${pet}`, text, html, tag: 'order-confirmation' };
}

// ---------------------------------------------------------------- delivery
// Each made pet gets a short code (e.g. K7QM-4XTP-9HRC) the Desktop Sidekicks app uses to
// download it: codes/<CODE> -> order id. Codes only work once the owner has approved the pet.
export const SITE = 'https://desktopsidekicks.com';
export const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(.{4})(?=.)/g, '$1-');
export const validCode = (c) => /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(c);

export async function orderForCode(env, code) {
  const c = normCode(code);
  if (!validCode(c)) return null;
  const obj = await env.ORDERS.get(`codes/${c}`);
  if (!obj) return null;
  return getOrder(env, (await obj.text()).trim());
}

export function page(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Desktop Sidekicks</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{--bg:#e6e1ea;--win:#fcfbfa;--ink:#221d27;--muted:#6a6170;--line:#d3cad9;--accent:#2f45c4;--accent-ink:#fff;--tag:#ffd25e}
@media (prefers-color-scheme:dark){:root{--bg:#1b1820;--win:#24202a;--ink:#efeaf3;--muted:#a79daf;--line:#3b3443;--accent:#8a9bff;--accent-ink:#12142a}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.55 Inter,system-ui,-apple-system,sans-serif;padding:24px max(16px,env(safe-area-inset-left))}
.win{width:min(520px,100%);background:var(--win);border:1px solid var(--line);border-radius:12px;box-shadow:0 14px 40px -12px rgba(0,0,0,.3);overflow:hidden}
.bar{padding:10px 14px;border-bottom:1px solid var(--line);font:500 12.5px/1 ui-monospace,Menlo,monospace;color:var(--muted)}
.body{padding:22px 24px 24px;display:grid;gap:14px}
h1{margin:0;font-size:28px;line-height:1.1;letter-spacing:-.02em}
p{margin:0}.muted{color:var(--muted)}
.btn{display:inline-flex;justify-content:center;align-items:center;gap:8px;border:0;border-radius:8px;padding:12px 18px;font:600 15px/1 inherit;background:var(--accent);color:var(--accent-ink);text-decoration:none;cursor:pointer}
.btn.ghost{background:transparent;color:var(--ink);box-shadow:inset 0 0 0 1px var(--line)}
.row{display:flex;flex-wrap:wrap;gap:10px}
.code{font:600 24px/1 ui-monospace,Menlo,monospace;letter-spacing:.06em;padding:14px 16px;border:1px dashed var(--line);border-radius:10px;text-align:center;user-select:all}
ol{margin:0;padding-left:20px;display:grid;gap:6px}
</style></head><body><main class="win"><div class="bar">${esc(title)}</div><div class="body">${body}</div></main></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}

// Which pets a customer already has: customers/<sha256(email)> -> JSON list of delivered order ids
// (written on approve). Used to add "it joins your other pets" to a second pet's delivery email.
async function customerKey(email) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(email || '').trim().toLowerCase()));
  return `customers/${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
export async function customerPets(env, email) {
  const obj = await env.ORDERS.get(await customerKey(email));
  if (!obj) return [];
  try { const ids = JSON.parse(await obj.text()); return Array.isArray(ids) ? ids : []; } catch { return []; }
}
export async function rememberPet(env, order) {
  const ids = await customerPets(env, order.email);
  if (!ids.includes(order.id)) await env.ORDERS.put(await customerKey(order.email), JSON.stringify([...ids, order.id]));
}

const ordinal = (k) => `${k}${(k % 100 >= 11 && k % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[k % 10] || 'th')}`;

// petNumber: this pet is the customer's 2nd, 3rd, ... (0 / 1 = their first: no pack note). The app's menu item
// reads the same ('Add 2nd Pet…', app/main.js addLabel).
export function deliveryEmail(order, code, { petNumber = 0 } = {}) {
  const morePets = petNumber >= 2;
  const addItem = `Add ${ordinal(petNumber)} Pet…`;
  const pet = order.pet_name || 'Your pet';
  const add = `${SITE}/add/${code}`;
  const text = `${pet} is ready!

1. Download Desktop Sidekicks for Mac: ${SITE}/download
2. Open it, then click this link to add ${pet}: ${add}
   (or paste this code into the app: ${code})

${pet} will appear in the bottom-right corner of your screen, follow your mouse, nap when you step away and eat the treats you drag over. Right-click ${pet} for tricks, sizes and more.
${morePets ? `
Adding to your pack? First download the latest app from the link above (it updates the one you have). Then click Menu on the pet you already have, choose "${addItem}" and enter the code above: ${pet} joins your other pets on the desktop.
` : ''}
Keep this email: the code works on any of your Macs.

Questions? Just reply to this email.
Desktop Sidekicks · ${SITE}`;
  const html = `<div style="font:16px/1.55 -apple-system,system-ui,sans-serif;color:#221d27;max-width:520px">
<h1 style="font-size:26px;margin:0 0 12px">${esc(pet)} is ready!</h1>
<p>Two steps and ${esc(pet)} moves onto your desktop:</p>
<p><b>1.</b> <a href="${SITE}/download" style="color:#2f45c4">Download Desktop Sidekicks for Mac</a> and open it.</p>
<p><b>2.</b> Add ${esc(pet)}:</p>
<p><a href="${add}" style="display:inline-block;background:#2f45c4;color:#fff;text-decoration:none;font-weight:600;padding:12px 18px;border-radius:8px">Add ${esc(pet)} to Desktop Sidekicks</a></p>
<p style="color:#6a6170">Or paste this code into the app: <b style="font-family:ui-monospace,Menlo,monospace;color:#221d27;letter-spacing:.05em">${esc(code)}</b></p>
<p>${esc(pet)} will sit in the bottom-right corner, follow your mouse, nap when you step away and eat the treats you drag over. Right-click for tricks, sizes and more.</p>
${morePets ? `<p style="background:#f3f0f6;border-radius:8px;padding:12px 14px"><b>Adding to your pack?</b> First <a href="${SITE}/download" style="color:#2f45c4">download the latest app</a> (it updates the one you have). Then click <b>Menu</b> on the pet you already have, choose <b>${addItem}</b> and enter the code above: ${esc(pet)} joins your other pets on the desktop.</p>` : ''}
<p style="color:#6a6170;font-size:13px">Keep this email: the code works on any of your Macs. Questions? Just reply.<br>Desktop Sidekicks &middot; <a href="${SITE}" style="color:#2f45c4">desktopsidekicks.com</a></p>
</div>`;
  return { subject: `${pet} is ready for your desktop`, text, html, tag: 'pet-delivery' };
}
