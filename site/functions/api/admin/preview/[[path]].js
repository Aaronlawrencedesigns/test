// /api/admin/preview/<order id>/<approve token>/index.html (and the files it loads):
// a playable preview of a made pet for the owner, working like the Mac app (menu, sizes,
// feed, drag). Files are uploaded by the worker to orders/<id>/preview/; photos/<view> serves the
// customer's uploaded photos.
import { validId, getOrder } from '../../../../lib/orders.js';

const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json', webp: 'image/webp', webm: 'video/webm', mp4: 'video/mp4', png: 'image/png' };

export async function onRequestGet({ request, env, params }) {
  const parts = [].concat(params.path || []);
  const [id, t, ...rest] = parts;
  const file = rest.join('/') || 'index.html';
  if (!validId(id) || !env.ORDERS || !t || !/^[A-Za-z0-9._\/-]+$/.test(file) || file.includes('..'))
    return new Response('not found', { status: 404 });
  const order = await getOrder(env, id);
  if (!order || !order.approve_token || order.approve_token !== t) return new Response('not found', { status: 404 });
  // the customer's uploaded photos (photos/<view>), for comparing the pet with the real one
  const pm = /^photos\/([a-z]+)$/.exec(file);
  if (pm) {
    const key = (order.photos || {})[pm[1]];
    const ph = key && await env.ORDERS.get(key);
    if (!ph) return new Response('not found', { status: 404 });
    return new Response(ph.body, { headers: { 'content-type': (ph.httpMetadata && ph.httpMetadata.contentType) || 'image/jpeg',
      'cache-control': 'private, max-age=600', 'x-robots-tag': 'noindex' } });
  }
  const key = `orders/${id}/preview/${file}`;
  const ext = file.split('.').pop();
  const headers = { 'content-type': TYPES[ext] || 'application/octet-stream', 'accept-ranges': 'bytes',
    'cache-control': file === 'index.html' ? 'no-store' : 'private, max-age=600', 'x-robots-tag': 'noindex' };
  // Safari (iPhone / iPad) only plays video it can fetch in byte ranges: answer Range requests with 206
  const rm = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
  if (rm && (rm[1] || rm[2])) {
    const head = await env.ORDERS.head(key);
    if (!head) return new Response('not found', { status: 404 });
    const size = head.size;
    let start, end;
    if (rm[1]) { start = +rm[1]; end = rm[2] ? Math.min(+rm[2], size - 1) : size - 1; }
    else { start = Math.max(0, size - +rm[2]); end = size - 1; }
    if (start >= size || start > end) return new Response('', { status: 416, headers: { 'content-range': `bytes */${size}` } });
    const part = await env.ORDERS.get(key, { range: { offset: start, length: end - start + 1 } });
    return new Response(part.body, { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': String(end - start + 1) } });
  }
  const obj = await env.ORDERS.get(key);
  if (!obj) return new Response(file === 'index.html' ? 'no preview yet (made before previews existed: remake to get one)' : 'not found', { status: 404 });
  return new Response(obj.body, { headers: { ...headers, 'content-length': String(obj.size) } });
}
