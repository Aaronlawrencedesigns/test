// /add/<CODE>: the "Add Chewie" button in the delivery email. Opens the Desktop Sidekicks
// app (desktopsidekicks://add/<CODE>) and shows the code to paste if the app isn't installed yet.
import { orderForCode, normCode, page, esc } from '../../lib/orders.js';

export async function onRequestGet({ env, params }) {
  const code = normCode(params.code);
  const order = env.ORDERS ? await orderForCode(env, code) : null;
  if (!order || order.status !== 'delivered') {
    return page('Pet code', `<h1>Code not found</h1><p class="muted">Check the code in your email (it looks like K7QM-4XTP-9HRC). If your pet is still being made, you'll get an email when it's ready.</p>`, 404);
  }
  const pet = esc(order.pet_name || 'Your pet');
  const deep = `desktopsidekicks://add/${code}`;
  return page(`Add ${pet}`, `
    <h1>Add ${pet} to your desktop</h1>
    <ol>
      <li><a href="/download">Download Desktop Sidekicks</a> for your Mac or Windows PC and open it (skip if you have it).</li>
      <li>Click <b>Add ${pet}</b> below, or paste this code into the app:</li>
    </ol>
    <div class="code">${code}</div>
    <div class="row"><a class="btn" href="${deep}">Add ${pet}</a><a class="btn ghost" href="/download">Download the app</a></div>
    <p class="muted">Works on macOS 12 or later and Windows 10 or 11. The code works on any of your computers.</p>`);
}
