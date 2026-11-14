// POST /api/order  (multipart: front, side, back, sit photos + name, species, email)
// Stores the photos privately in R2, then returns a Stripe Checkout URL.
import { PRICE_CENTS, CURRENCY, VIEWS, MAX_PHOTO_BYTES, PHOTO_TYPES, json, newId, validEmail, putOrder, stripe } from '../../lib/orders.js';

export async function onRequestPost({ request, env }) {
  if (!env.STRIPE_SECRET_KEY || !env.ORDERS) return json({ error: "Checkout isn't set up yet. Please try again soon." }, 503);
  let form;
  try { form = await request.formData(); } catch { return json({ error: 'Send the form as multipart/form-data.' }, 400); }

  const email = String(form.get('email') || '').trim();
  const name = String(form.get('name') || '').trim().slice(0, 40) || 'your pet';
  const species = ['Dog', 'Cat', 'Other'].includes(form.get('species')) ? form.get('species') : 'Dog';
  if (!validEmail(email)) return json({ error: 'Add a valid email so we can send your pet when it\'s ready.' }, 400);

  const photos = [];
  for (const view of VIEWS) {
    const f = form.get(view);
    if (!f || typeof f === 'string' || !f.size) return json({ error: `Add a photo for: ${view === 'sit' ? 'sitting' : view}.` }, 400);
    const ext = PHOTO_TYPES[f.type];
    if (!ext) return json({ error: `The ${view} photo must be a JPEG, PNG, WebP or HEIC image.` }, 400);
    if (f.size > MAX_PHOTO_BYTES) return json({ error: `The ${view} photo is over 15 MB. Try a smaller one.` }, 400);
    photos.push({ view, file: f, ext });
  }

  const id = newId();
  for (const p of photos) {
    await env.ORDERS.put(`orders/${id}/photos/${p.view}.${p.ext}`, p.file.stream(), { httpMetadata: { contentType: p.file.type } });
  }
  const origin = new URL(request.url).origin;
  const order = {
    id, status: 'awaiting_payment', created_at: new Date().toISOString(),
    email, pet_name: name === 'your pet' ? '' : name, species: species.toLowerCase(),
    photos: Object.fromEntries(photos.map((p) => [p.view, `orders/${id}/photos/${p.view}.${p.ext}`])),
    price_cents: PRICE_CENTS,
  };

  const session = await stripe(env, 'checkout/sessions', {
    mode: 'payment',
    'line_items[0][quantity]': 1,
    'line_items[0][price_data][currency]': CURRENCY,
    'line_items[0][price_data][unit_amount]': PRICE_CENTS,
    'line_items[0][price_data][product_data][name]': order.pet_name ? `Desktop Sidekick: ${order.pet_name}` : 'Desktop Sidekick',
    'line_items[0][price_data][product_data][description]': 'Your pet as a desk pet for your Mac: head tracking, 11 tricks and feed mode.',
    customer_email: email,
    client_reference_id: id,
    'metadata[order_id]': id,
    'payment_intent_data[metadata][order_id]': id,
    success_url: `${origin}/?order=${id}`,
    cancel_url: `${origin}/#create`,
  });
  order.checkout_session = session.id;
  await putOrder(env, order);
  return json({ url: session.url, order: id });
}
