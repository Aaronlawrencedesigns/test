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
    body: JSON.stringify({ From: FROM, To: to, Subject: subject, TextBody: text, HtmlBody: html, Tag: tag, MessageStream: 'outbound' }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ErrorCode) throw new Error(`postmark: ${data.Message || r.status}`);
  return data;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
