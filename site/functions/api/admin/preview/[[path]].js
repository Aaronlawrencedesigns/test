// /api/admin/preview/<order id>/<approve token>/index.html (and the files it loads):
// a playable preview of a made pet for the owner, working like the Mac app (menu, sizes,
// feed, drag). Files are uploaded by the worker to orders/<id>/preview/.
import { validId, getOrder } from '../../../../lib/orders.js';

const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json', webp: 'image/webp', webm: 'video/webm', png: 'image/png' };

export async function onRequestGet({ request, env, params }) {
  const parts = [].concat(params.path || []);
  const [id, t, ...rest] = parts;
  const file = rest.join('/') || 'index.html';
  if (!validId(id) || !env.ORDERS || !t || !/^[A-Za-z0-9._\/-]+$/.test(file) || file.includes('..'))
    return new Response('not found', { status: 404 });
  const order = await getOrder(env, id);
  if (!order || !order.approve_token || order.approve_token !== t) return new Response('not found', { status: 404 });
  const obj = await env.ORDERS.get(`orders/${id}/preview/${file}`);
  if (!obj) return new Response(file === 'index.html' ? 'no preview yet (made before previews existed: remake to get one)' : 'not found', { status: 404 });
  const ext = file.split('.').pop();
  return new Response(obj.body, { headers: { 'content-type': TYPES[ext] || 'application/octet-stream',
    'cache-control': file === 'index.html' ? 'no-store' : 'private, max-age=600', 'x-robots-tag': 'noindex' } });
}
