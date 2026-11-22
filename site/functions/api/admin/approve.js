// /api/admin/approve?id=<order>&t=<approve token>   (link in the owner's review email)
// GET shows the pet and a button (so email link scanners can't approve by visiting);
// POST marks the order delivered and emails the customer their pet code.
import { validId, getOrder, putOrder, sendEmail, deliveryEmail, customerPets, rememberPet, page, esc } from '../../../lib/orders.js';

// "Send back for a re-make" boxes: keys match petgen/plan.py REDO_PARTS
const PARTS = [['sit', 'Sitting pose (remakes the whole pet)'], ['head', 'Head tracking'], ['stand', 'Stand up / Play bow'],
  ['lie', 'Lie down'], ['get_up', 'Get up'], ['sleep', 'Fall asleep + sleeping'], ['wake_up', 'Wake up'],
  ['wag', 'Happy wiggle'], ['puppy', 'Puppy eyes'], ['eat', 'Eat (Feed)'], ['bark', 'Bark / Meow']];

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
    <div class="row"><a class="btn ghost" href="/api/admin/preview/${id}/${encodeURIComponent(t)}/index.html" target="_blank" rel="noopener">Try it</a>
      <a class="btn ghost" href="/api/admin/report?id=${id}&t=${t}" target="_blank" rel="noopener">Open QA report</a></div>
    ${done ? `<p>Sent to the customer on ${new Date(order.delivered_at).toLocaleString('en-US')}.</p>` : ''}
    <form method="post"><button class="btn" type="submit">${done ? 'Send the email again' : `Approve and send to ${email}`}</button></form>
    ${order.status === 'review' ? `<form method="post" style="display:grid;gap:10px;border-top:1px solid var(--line);padding-top:14px">
      <input type="hidden" name="action" value="remake">
      <b>Not right? Send it back for a re-make</b>
      <span class="muted">Tick what to make again. Your notes are added to their instructions. Only the ticked parts cost
        anything (a trick about $0.40-1.50, head tracking about $7, the sitting pose remakes everything).</span>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:6px">
        ${PARTS.map(([k, label]) => `<label style="display:flex;gap:8px;align-items:center;padding:6px 0"><input type="checkbox" name="part" value="${k}" style="width:20px;height:20px">${esc(label)}</label>`).join('')}
      </div>
      <textarea name="notes" rows="3" maxlength="500" placeholder="e.g. keep her whole body in frame during the play bow"
        style="font:inherit;padding:10px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit"></textarea>
      <button class="btn ghost" type="submit">Send back for a re-make</button>
    </form>` : ''}
    ${(order.remake_history || []).length ? `<p class="muted">Sent back before: ${(order.remake_history || []).map((r) => esc(`${(r.items || []).join(', ')}${r.notes ? ` ("${r.notes}")` : ''}`)).join(' · ')}</p>` : ''}`);
}

export async function onRequestPost({ request, env }) {
  const { order, id, t } = await load(request, env);
  if (!order) return page('Not found', '<h1>Link not valid</h1>', 404);
  const form = await request.formData().catch(() => null);
  if (form && form.get('action') === 'remake') return sendBack(env, order, id, t, form);
  if (!['review', 'delivered'].includes(order.status)) return page('Not ready', `<h1>Not ready</h1><p>This order is "${esc(order.status)}".</p>`, 409);
  const others = (await customerPets(env, order.email)).filter((other) => other !== id);
  const petNumber = others.length + 1;   // 2 = their 2nd pet (gets the "Adding to your pack?" note)
  const r = await sendEmail(env, { to: order.email, ...deliveryEmail(order, order.code, { petNumber }) });
  Object.assign(order, { status: 'delivered', delivered_at: order.delivered_at || new Date().toISOString(), delivery_email: r?.MessageID || order.delivery_email });
  await putOrder(env, order);
  await rememberPet(env, order);
  await env.ORDERS.delete(`queue/review/${id}`);
  await env.ORDERS.put(`queue/delivered/${id}`, order.delivered_at);
  return page('Sent', `<h1>Sent</h1><p>${esc(order.pet_name || 'The pet')} is on its way to ${esc(order.email)}.</p>
    <p class="muted">Their code: <b>${order.code}</b></p>`);
}

// Owner sends the pet back: the worker makes the ticked parts again (new cache key, notes in their prompt) and emails
// a fresh "Approve and send" link when it's done. Nothing goes to the customer.
async function sendBack(env, order, id, t, form) {
  if (order.status !== 'review') return page('Not now', `<h1>Can't send back</h1><p>This order is "${esc(order.status)}".</p>`, 409);
  const keys = new Set(PARTS.map(([k]) => k));
  const items = [...new Set(form.getAll('part').map(String))].filter((k) => keys.has(k));
  const notes = String(form.get('notes') || '').trim().slice(0, 500);
  if (!items.length) return page('Pick something', `<h1>Nothing ticked</h1><p>Tick at least one part to make again.</p>
    <p><a href="?id=${id}&t=${encodeURIComponent(t)}">← Back</a></p>`, 400);
  const round = (order.remake_history || []).length + 1;
  Object.assign(order, { status: 'paid', remake: { items, notes, round, at: new Date().toISOString() } });
  await putOrder(env, order);
  await env.ORDERS.put(`queue/paid/${id}`, new Date().toISOString());
  await env.ORDERS.delete(`queue/review/${id}`);
  return page('Sent back', `<h1>Sent back</h1><p>${esc(order.pet_name || 'The pet')} is being re-made: ${esc(items.join(', '))}.</p>
    ${notes ? `<p class="muted">Notes: ${esc(notes)}</p>` : ''}<p class="muted">You'll get a new email to approve when it's ready.</p>`);
}
