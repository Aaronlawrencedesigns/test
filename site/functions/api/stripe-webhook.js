// POST /api/stripe-webhook  (Stripe sends checkout.session.completed here)
// Marks the order paid, queues it for the pet-making worker and emails a confirmation.
import { json, validId, getOrder, putOrder, verifyStripeSignature, sendEmail, confirmationEmail } from '../../lib/orders.js';

export async function onRequestPost({ request, env, waitUntil }) {
  const raw = await request.text();
  if (!(await verifyStripeSignature(raw, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET))) {
    return json({ error: 'bad signature' }, 400);
  }
  const event = JSON.parse(raw);
  if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') {
    return json({ ignored: event.type });
  }
  const s = event.data.object;
  const id = s.metadata?.order_id || s.client_reference_id;
  if (!validId(id)) return json({ error: 'no order id' }, 400);
  if (s.payment_status !== 'paid') return json({ waiting: s.payment_status });

  const order = await getOrder(env, id);
  if (!order) return json({ error: 'unknown order' }, 404);
  if (order.status !== 'awaiting_payment') return json({ already: order.status });   // Stripe retries: stay idempotent

  Object.assign(order, {
    status: 'paid', paid_at: new Date().toISOString(), amount_total: s.amount_total, currency: s.currency,
    payment_intent: s.payment_intent, livemode: event.livemode,
    email: s.customer_details?.email || order.email,
  });
  await putOrder(env, order);
  await env.ORDERS.put(`queue/paid/${id}`, order.paid_at);

  const send = sendEmail(env, { to: order.email, ...confirmationEmail(order) })
    .then(async (r) => { if (r?.MessageID) { order.confirmation_email = r.MessageID; await putOrder(env, order); } })
    .catch((e) => console.error('confirmation email failed', id, e.message));
  waitUntil ? waitUntil(send) : await send;
  return json({ ok: true });
}
