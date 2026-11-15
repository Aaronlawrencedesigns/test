// /api/admin/approve?id=<order>&t=<approve token>   (link in the owner's review email)
// GET shows the pet and a button (so email link scanners can't approve by visiting);
// POST marks the order delivered and emails the customer their pet code.
import { validId, getOrder, putOrder, sendEmail, deliveryEmail, page, esc } from '../../../lib/orders.js';

async function load(request, env) {
  const u = new URL(request.url);
  const id = u.searchParams.get('id'), t = u.searchParams.get('t') || '';
  if (!validId(id) || !env.ORDERS) return {};
  const order = await getOrder(env, id);
  if (!order || !order.approve_token || order.approve_token !== t) return {};
  return { order, id, t };
}

export async function onRequestGet({ request, env }) {
  const { order, id, t } = await load(request, env);
  if (!order) return page('Not found', '<h1>Link not valid</h1><p class="muted">This approval link is wrong or has been replaced.</p>', 404);
  const pet = esc(order.pet_name || 'This pet');
  const email = esc(order.email);
  const done = order.status === 'delivered';
  const verdict = order.ready ? (order.photo_warnings?.length ? 'Ready, with photo warnings' : 'Ready to ship') : 'Needs a look';
  return page(`Review ${pet}`, `
    <h1>${pet}</h1>
    <p><b>${verdict}</b>${order.needs_look?.length ? ` · needs a look: ${esc(order.needs_look.join(', '))}` : ''}<br>
       <span class="muted">For ${email} · code ${order.code} · est. AI cost $${order.ai_cost_usd ?? '?'}</span></p>
    <div class="row"><a class="btn ghost" href="/api/admin/report?id=${id}&t=${t}" target="_blank" rel="noopener">Open QA report</a></div>
    ${done ? `<p>Sent to the customer on ${new Date(order.delivered_at).toLocaleString('en-US')}.</p>` : ''}
    <form method="post"><button class="btn" type="submit">${done ? 'Send the email again' : `Approve and send to ${email}`}</button></form>
    <p class="muted">To remake this pet instead, run <code>sidekicks-requeue ${id}</code> on the server.</p>`);
}

export async function onRequestPost({ request, env }) {
  const { order, id } = await load(request, env);
  if (!order) return page('Not found', '<h1>Link not valid</h1>', 404);
  if (!['review', 'delivered'].includes(order.status)) return page('Not ready', `<h1>Not ready</h1><p>This order is "${esc(order.status)}".</p>`, 409);
  const r = await sendEmail(env, { to: order.email, ...deliveryEmail(order, order.code) });
  Object.assign(order, { status: 'delivered', delivered_at: order.delivered_at || new Date().toISOString(), delivery_email: r?.MessageID || order.delivery_email });
  await putOrder(env, order);
  await env.ORDERS.delete(`queue/review/${id}`);
  await env.ORDERS.put(`queue/delivered/${id}`, order.delivered_at);
  return page('Sent', `<h1>Sent</h1><p>${esc(order.pet_name || 'The pet')} is on its way to ${esc(order.email)}.</p>
    <p class="muted">Their code: <b>${order.code}</b></p>`);
}
