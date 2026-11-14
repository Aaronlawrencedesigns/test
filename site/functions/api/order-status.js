// GET /api/order-status?id=<order id>  -> { status, pet_name }  (for the thank-you window)
import { json, validId, getOrder } from '../../lib/orders.js';

export async function onRequestGet({ request, env }) {
  const id = new URL(request.url).searchParams.get('id');
  if (!validId(id) || !env.ORDERS) return json({ error: 'not found' }, 404);
  const order = await getOrder(env, id);
  if (!order) return json({ error: 'not found' }, 404);
  return json({ status: order.status, pet_name: order.pet_name || '' });
}
