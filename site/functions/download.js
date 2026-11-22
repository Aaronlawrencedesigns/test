// /download: the Desktop Sidekicks app for the visitor's computer: Windows PCs get the Windows app
// (R2 Desktop-Sidekicks-Windows.exe, also at /download/windows), everyone else the signed Mac app
// (R2 Desktop-Sidekicks.dmg). ?os=mac or ?os=windows picks one explicitly (links in emails use it).
import { page } from '../lib/orders.js';
import { onRequestGet as windows } from './download/windows.js';

export async function onRequestGet(ctx) {
  const { request, env } = ctx;
  const os = new URL(request.url).searchParams.get('os');
  const ua = request.headers.get('user-agent') || '';
  if (os === 'windows' || (os !== 'mac' && /Windows/i.test(ua))) return windows(ctx);
  const obj = env.ORDERS ? await env.ORDERS.get('Desktop-Sidekicks.dmg') : null;
  if (!obj) return page('Download', '<h1>Almost ready</h1><p class="muted">The Desktop Sidekicks app will be here very soon. Keep your email: your pet code will work as soon as it is.</p>', 404);
  return new Response(obj.body, { headers: { 'content-type': 'application/x-apple-diskimage', 'content-length': String(obj.size),
    'content-disposition': 'attachment; filename="Desktop Sidekicks.dmg"', 'cache-control': 'private, max-age=300', vary: 'user-agent' } });
}
