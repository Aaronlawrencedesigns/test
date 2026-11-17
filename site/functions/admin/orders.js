// /admin/orders: every order with what it earned and cost (owner only, behind Cloudflare Access).
// ?format=csv downloads the same table for Google Sheets / Excel. ?all=1 includes unpaid checkouts,
// ?month=YYYY-MM limits it to one month.
import { getOrder, esc } from '../../lib/orders.js';
import { accessUser } from '../../lib/access.js';

// Stripe's US card fee, used when an order has no exact fee recorded (orders paid before fees were saved)
const estFee = (cents) => (cents > 0 ? Math.round(cents * 0.029 + 30) : 0);

async function allOrders(env) {
  const ids = [];
  let cursor;
  do {
    const r = await env.ORDERS.list({ prefix: 'orders/', delimiter: '/', cursor });
    for (const p of r.delimitedPrefixes || []) ids.push(p.split('/')[1]);
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  const out = [];
  for (let i = 0; i < ids.length; i += 25) {
    out.push(...(await Promise.all(ids.slice(i, i + 25).map((id) => getOrder(env, id).catch(() => null)))));
  }
  return out.filter(Boolean);
}

export function row(o) {
  const paid = o.status !== 'awaiting_payment' ? (o.amount_total ?? 0) : 0;
  const feeExact = Number.isFinite(o.stripe_fee_cents);
  const fee = feeExact ? o.stripe_fee_cents : estFee(paid);
  const ai = Math.round(100 * (o.ai_cost_total_usd ?? o.ai_cost_usd ?? 0));
  return {
    date: (o.paid_at || o.created_at || '').slice(0, 10), id: o.id || '', pet: o.pet_name || '', email: o.email || '',
    species: o.species || '', sex: o.sex || '', status: o.status || '', live: o.livemode ? 'live' : 'test',
    paid, fee, feeExact, ai, profit: paid - fee - ai,
  };
}

const usd = (c) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toFixed(2)}`;
const COLS = [['date', 'Date'], ['pet', 'Pet'], ['email', 'Customer email'], ['species', 'Species'], ['sex', 'Sex'],
  ['status', 'Status'], ['live', 'Mode'], ['paid', 'Paid'], ['fee', 'Stripe fee'], ['ai', 'AI cost (est.)'], ['profit', 'Profit'], ['id', 'Order']];
const MONEY = new Set(['paid', 'fee', 'ai', 'profit']);
// CSV cell: quoted when needed; a leading = + - @ is defused so a spreadsheet never runs it as a formula
const cell = (v) => {
  let s = String(v);
  if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function onRequestGet({ request, env }) {
  const who = await accessUser(request, env);
  if (!who) {
    return new Response('Owner only. This page opens once Cloudflare Access protects /admin and ACCESS_TEAM_DOMAIN + ACCESS_AUD are saved in the Pages settings.',
      { status: 403, headers: { 'cache-control': 'no-store' } });
  }
  const u = new URL(request.url);
  const all = u.searchParams.get('all') === '1';
  const month = /^\d{4}-\d{2}$/.test(u.searchParams.get('month') || '') ? u.searchParams.get('month') : '';
  const everything = (await allOrders(env)).map(row).filter((r) => all || r.status !== 'awaiting_payment');
  const rows = everything.filter((r) => !month || r.date.startsWith(month)).sort((a, b) => b.date.localeCompare(a.date));
  const head = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' };

  if (u.searchParams.get('format') === 'csv') {
    const lines = [COLS.map(([, h]) => h).join(',')]
      .concat(rows.map((r) => COLS.map(([k]) => cell(MONEY.has(k) ? (r[k] / 100).toFixed(2) : r[k])).join(',')));
    return new Response(lines.join('\n') + '\n', { headers: { ...head, 'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="desktop-sidekicks-orders${month ? '-' + month : ''}.csv"` } });
  }

  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  const paying = rows.filter((r) => r.paid > 0);
  const months = [...new Set(everything.map((r) => r.date.slice(0, 7)).filter(Boolean))].sort().reverse();
  const tiles = [['Orders', String(rows.length)], ['Paying customers', String(paying.length)], ['Revenue', usd(sum('paid'))],
    ['Stripe fees', usd(sum('fee'))], ['AI cost', usd(sum('ai'))], ['Profit', usd(sum('profit'))],
    ['Profit per paying pet', paying.length ? usd(Math.round(paying.reduce((a, r) => a + r.profit, 0) / paying.length)) : '–']];
  const link = (p) => { const s = new URLSearchParams(); if (all) s.set('all', '1'); if (month) s.set('month', month);
    for (const [k, v] of Object.entries(p)) v ? s.set(k, v) : s.delete(k); const t = s.toString(); return t ? `?${t}` : '?'; };
  const money = (r, k) => {
    const cls = k === 'profit' ? (r.profit >= 0 ? 'pos' : 'neg') : (k === 'fee' && !r.feeExact && r.fee ? 'est' : '');
    return `<td class="n ${cls}">${usd(r[k])}</td>`;
  };
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Orders · Desktop Sidekicks</title><style>
:root{--bg:#e6e1ea;--card:#fcfbfa;--ink:#221d27;--muted:#6a6170;--line:#d3cad9;--good:#1f7a3a;--bad:#b3261e;--accent:#2f45c4}
@media(prefers-color-scheme:dark){:root{--bg:#1b1820;--card:#24202a;--ink:#efeaf3;--muted:#a79daf;--line:#3b3443;--good:#6fd38c;--bad:#ff8a80;--accent:#8a9bff}}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,system-ui,sans-serif;padding:20px 16px 40px}
h1{margin:0 0 4px;font-size:24px}.muted{color:var(--muted)}a{color:var(--accent)}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:12px 0}
.bar a,.bar select{padding:6px 12px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--ink);text-decoration:none;font:inherit}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin:14px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.tile b{display:block;font-size:20px;font-variant-numeric:tabular-nums}
.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;min-width:960px}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
th{font-weight:600;color:var(--muted)}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.pos{color:var(--good)}.neg{color:var(--bad)}.est{color:var(--muted)}code{font-size:12px}</style></head><body>
<h1>Orders</h1>
<div class="muted">Signed in as ${esc(who)}. Grey Stripe fees are estimates (2.9% + 30¢); AI cost is our estimate of GPTProto spend, re-makes included. Team orders with the 100%-off code show $0 paid.</div>
<div class="bar"><a href="${esc(link({ format: 'csv' }))}">⬇ Download CSV</a>
<select aria-label="Month" onchange="location.search=this.value"><option value="${esc(link({ month: '' }))}">All months</option>${months.map((m) => `<option value="${esc(link({ month: m }))}"${m === month ? ' selected' : ''}>${m}</option>`).join('')}</select>
<a href="${esc(link({ all: all ? '' : '1' }))}">${all ? 'Hide unpaid checkouts' : 'Show unpaid checkouts'}</a></div>
<div class="tiles">${tiles.map(([k, v]) => `<div class="tile"><span class="muted">${k}</span><b>${v}</b></div>`).join('')}</div>
<div class="wrap"><table><thead><tr>${COLS.map(([k, h]) => `<th${MONEY.has(k) ? ' class="n"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>
${rows.map((r) => `<tr>${COLS.map(([k]) => (MONEY.has(k) ? money(r, k) : k === 'id' ? `<td><code>${esc(r.id.slice(0, 8))}</code></td>` : `<td>${esc(r[k])}</td>`)).join('')}</tr>`).join('')
  || `<tr><td colspan="${COLS.length}" class="muted">No orders yet.</td></tr>`}
</tbody></table></div></body></html>`;
  return new Response(html, { headers: { ...head, 'content-type': 'text/html; charset=utf-8' } });
}
