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
  return new Response(obj.body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}
