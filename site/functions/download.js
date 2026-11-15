// /download: the signed Desktop Sidekicks Mac app (uploaded to the top of the R2 bucket as Desktop-Sidekicks.dmg).
import { page } from '../lib/orders.js';

export async function onRequestGet({ env }) {
  const obj = env.ORDERS ? await env.ORDERS.get('Desktop-Sidekicks.dmg') : null;
  if (!obj) return page('Download', '<h1>Almost ready</h1><p class="muted">The Desktop Sidekicks app will be here very soon. Keep your email: your pet code will work as soon as it is.</p>', 404);
  return new Response(obj.body, { headers: { 'content-type': 'application/x-apple-diskimage', 'content-length': String(obj.size),
    'content-disposition': 'attachment; filename="Desktop Sidekicks.dmg"', 'cache-control': 'public, max-age=300' } });
}
