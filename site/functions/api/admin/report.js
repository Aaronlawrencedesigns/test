// /api/admin/report?id=<order>&t=<approve token>: the QA report for the owner.
import { validId, getOrder } from '../../../lib/orders.js';

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const id = u.searchParams.get('id'), t = u.searchParams.get('t') || '';
  if (!validId(id) || !env.ORDERS) return new Response('not found', { status: 404 });
  const order = await getOrder(env, id);
  if (!order || !order.approve_token || order.approve_token !== t) return new Response('not found', { status: 404 });
  const obj = await env.ORDERS.get(`orders/${id}/report.html`);
  if (!obj) return new Response('no report yet', { status: 404 });
  // link to the playable preview at the top of the report
  const play = `/api/admin/preview/${id}/${encodeURIComponent(t)}/index.html`;
  const html = (await obj.text()).replace(/<body[^>]*>/i, (b) => `${b}<p style="font:600 16px system-ui;margin:12px 16px">▶ <a href="${play}">Try the pet like on your Mac (menu, sizes, feed, every trick)</a></p>`);
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}
