// GET /api/pet/<CODE>        -> the pet pack (zip) for the Desktop Sidekicks app
// GET /api/pet/<CODE>?info=1 -> { name, species } (to show "Adding Chewie…")
import { json, orderForCode, normCode } from '../../../lib/orders.js';

export async function onRequestGet({ request, env, params }) {
  const order = env.ORDERS ? await orderForCode(env, params.code) : null;
  if (!order) return json({ error: "That code doesn't match a pet. Check it against your email." }, 404);
  if (order.status !== 'delivered') return json({ error: "This pet isn't ready yet. You'll get an email when it is." }, 409);
  if (new URL(request.url).searchParams.get('info')) {
    return json({ name: order.pet_name || 'Your pet', species: order.species, code: normCode(params.code) });
  }
  const obj = await env.ORDERS.get(`orders/${order.id}/pet.zip`);
  if (!obj) return json({ error: 'The pet files are missing. Reply to your email and we will fix it.' }, 500);
  return new Response(obj.body, { headers: { 'content-type': 'application/zip', 'content-length': String(obj.size), 'cache-control': 'no-store',
    'content-disposition': `attachment; filename="${(order.pet_name || 'pet').replace(/[^A-Za-z0-9 _-]/g, '')}.zip"` } });
}
