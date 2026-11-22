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
  // ...and the photos the customer uploaded, to compare against
  const base = `/api/admin/preview/${id}/${encodeURIComponent(t)}/photos/`;
  const photos = Object.keys(order.photos || {}).map((v) => `<a href="${base}${v}" target="_blank" style="text-align:center;color:inherit;text-decoration:none">`
    + `<img src="${base}${v}" alt="${v}" style="height:160px;max-width:220px;object-fit:cover;border-radius:8px;display:block"><small>${v}</small></a>`).join('');
  // what the customer chose on the order form
  const TAIL = { yes: 'Has a tail', stub: 'Stub tail', none: 'No tail' };
  const sexLabel = order.sex === 'female' ? 'Girl' : order.sex === 'male' ? 'Boy' : 'Boy / girl not given';
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const chosen = [order.species === 'cat' ? 'Cat' : 'Dog', sexLabel, TAIL[order.tail] || 'Tail not given'];
  const details = `<p style="font:14px system-ui;margin:0 16px 10px"><b>Order form:</b> ${chosen.map(esc).join(' · ')}</p>`;
  const top = `<p style="font:600 16px system-ui;margin:12px 16px">▶ <a href="${play}">Try the pet like on your Mac (menu, sizes, feed, every trick)</a></p>`
    + (photos ? `<div style="font:14px system-ui;margin:0 16px 12px"><b>Uploaded photos</b><div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px">${photos}</div></div>` : '');
  const html = (await obj.text()).replace(/<body[^>]*>/i, (b) => `${b}${top}${details}`);
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}
