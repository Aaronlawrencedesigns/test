// /download/windows: the Desktop Sidekicks app for Windows (uploaded to the top of the R2 bucket as
// Desktop-Sidekicks-Windows.exe). /download sends Windows visitors here. For now it's the portable build (one .exe,
// no installer, unsigned: Windows SmartScreen asks "More info -> Run anyway").
import { page } from '../../lib/orders.js';

export async function onRequestGet({ env }) {
  const obj = env.ORDERS ? await env.ORDERS.get('Desktop-Sidekicks-Windows.exe') : null;
  if (!obj) return page('Download', '<h1>Almost ready</h1><p class="muted">Desktop Sidekicks for Windows is coming soon.</p>', 404);
  return new Response(obj.body, { headers: { 'content-type': 'application/vnd.microsoft.portable-executable', 'content-length': String(obj.size),
    'content-disposition': 'attachment; filename="Desktop Sidekicks.exe"', 'cache-control': 'public, max-age=300', 'x-robots-tag': 'noindex' } });
}
