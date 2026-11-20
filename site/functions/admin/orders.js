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

// Cost per ACTION (owner, Nov 20: "which tricks cost most / need retries most, so we can decide what to drop").
// Worker-saved qa.json has `spend` (real est. $ per item) for pets made from Nov 20; older pets are estimated
// from their tries at list prices (a re-make that reused cached clips is over-counted there).
const SECS = { wag: 5, puppy: 5, stand: 7, eat: 4, bark: 4, poop: 8, lie_down: 5, get_up: 4, fall_asleep: 6, sleep_loop: 6, wake_up: 5 };
const HQ_FEMALE = new Set(['stand', 'poop', 'lie_down', 'get_up']);   // Seedance 2.5 for girls (petgen/plan.py)
const PRICE = { img: 0.0804, sec: 0.08, hqSec: 0.2, sweep: 0.4 };
const NAMES = { wag: 'Happy wiggle', puppy: 'Puppy eyes', stand: 'Stand up', eat: 'Eat (Feed)', bark: 'Bark', poop: 'Poop (removed)',
  lie_down: 'Lie down', get_up: 'Get up', fall_asleep: 'Fall asleep', sleep_loop: 'Sleeping', wake_up: 'Wake up',
  head: 'Head tracking (5 heights)', poses: 'Portrait + sit / lie / sleep poses' };
function actionOf(item) {
  if (SECS[item]) return item;
  if (/^(sweep_|gaze_)/.test(item)) return 'head';
  if (/^(master|green_|sleep pose|female|lie pose|sleep_edit)/.test(item)) return 'poses';
  return null;   // photo checks, set check: no generation
}
function tryCost(item, sex) {
  if (SECS[item]) return SECS[item] * (sex === 'female' && HQ_FEMALE.has(item) ? PRICE.hqSec : PRICE.sec);
  if (/^sweep_/.test(item)) return PRICE.sweep;
  if (/^(gaze_|master|green_|female|sleep_edit)/.test(item)) return PRICE.img;
  return 0;
}
function actionStats(docs) {
  const per = {};
  for (const d of docs) {
    const pet = {};
    const items = {};
    for (const q of d.qa || []) {
      const item = String(q.item || '').split('@')[0];
      const act = actionOf(item);
      if (!act) continue;
      const skipped = (q.problems || []).some((x) => /^not retried/.test(String(x)));   // budget reached: no new try
      const a = (pet[act] ||= { cost: 0, tries: 0, retried: false, failed: 0 });
      if (!skipped) {
        a.tries++;
        if (!d.spend) a.cost += tryCost(item, d.sex);
        if ((q.attempt || 1) > 1) a.retried = true;
        if ((q.problems || []).length) a.failed++;
      }
      (items[act] ||= new Set()).add(item);
    }
    if (d.spend) for (const [item, usd] of Object.entries(d.spend)) {
      const act = actionOf(item);
      if (act) (pet[act] ||= { cost: 0, tries: 0, retried: false, failed: 0 }).cost += Number(usd) || 0;
    }
    for (const [act, a] of Object.entries(pet)) {
      const st = (per[act] ||= { pets: 0, cost: 0, extraTries: 0, retriedPets: 0, failed: 0, tries: 0, measured: 0 });
      st.pets++; st.cost += a.cost; st.tries += a.tries; st.failed += a.failed;
      st.extraTries += Math.max(0, a.tries - (items[act] ? items[act].size : 0));
      if (a.retried) st.retriedPets++;
      if (d.spend) st.measured++;
    }
  }
  return Object.entries(per).map(([act, st]) => ({ act, name: NAMES[act] || act, ...st, avg: st.pets ? st.cost / st.pets : 0,
    retryShare: st.pets ? st.retriedPets / st.pets : 0, failRate: st.tries ? st.failed / st.tries : 0 }))
    .sort((a, b) => b.avg - a.avg);
}

// ?view=qa: which clips fail most across every pet made so far (orders/<id>/qa.json from the worker),
// so prompts and QA limits can be tuned where retries cost the most.
async function qaStats(env) {
  const all = await allOrders(env);
  const per = {};
  let pets = 0;
  const docsAll = [];
  for (let i = 0; i < all.length; i += 25) {
    const docs = await Promise.all(all.slice(i, i + 25).map(async (o) => {
      const obj = await env.ORDERS.get(`orders/${o.id}/qa.json`).catch(() => null);
      return obj ? obj.json().catch(() => null) : null;
    }));
    for (const d of docs.filter(Boolean)) {
      pets++;
      docsAll.push(d);
      const seen = new Set();
      for (const q of d.qa || []) {
        const base = String(q.item || '').split('@')[0].replace(/_\d\d$/, '');
        const s = (per[base] ||= { pets: 0, tries: 0, failed: 0, problems: {} });
        if (!seen.has(base)) { s.pets++; seen.add(base); }
        s.tries++;
        if ((q.problems || []).length) {
          s.failed++;
          for (const p of q.problems) {
            const k = String(p).replace(/[\d.]+%?x?/g, '#').slice(0, 70);
            s.problems[k] = (s.problems[k] || 0) + 1;
          }
        }
      }
    }
  }
  return { pets, actions: actionStats(docsAll), rows: Object.entries(per).map(([item, s]) => ({ item, ...s, rate: s.tries ? s.failed / s.tries : 0 }))
    .sort((a, b) => b.failed - a.failed) };
}

export async function onRequestGet({ request, env }) {
  const who = await accessUser(request, env);
  if (!who) {
    return new Response('Owner only. This page opens once Cloudflare Access protects /admin and ACCESS_TEAM_DOMAIN + ACCESS_AUD are saved in the Pages settings.',
      { status: 403, headers: { 'cache-control': 'no-store' } });
  }
  const u = new URL(request.url);
  if (u.searchParams.get('view') === 'qa') {
    const { pets, rows, actions } = await qaStats(env);
    const maxAvg = Math.max(0.01, ...actions.map((a) => a.avg));
    const total = actions.reduce((n, a) => n + a.avg, 0);
    const money = (x) => `$${x.toFixed(2)}`;
    const chart = actions.map((a) => `<tr><td>${esc(a.name)}</td><td class="bar"><span style="width:${(100 * a.avg / maxAvg).toFixed(1)}%"></span></td>`
      + `<td class="n">${money(a.avg)}</td><td class="n">${Math.round(100 * a.avg / Math.max(0.01, total))}%</td>`
      + `<td class="n ${a.retryShare > 0.4 ? 'neg' : ''}">${Math.round(100 * a.retryShare)}%</td>`
      + `<td class="n">${(a.extraTries / Math.max(1, a.pets)).toFixed(1)}</td><td class="n">${a.pets}${a.measured < a.pets ? '<sup>*</sup>' : ''}</td></tr>`).join('');
    const body = rows.map((r) => `<tr><td>${esc(r.item)}</td><td class="n">${r.pets}</td><td class="n">${r.tries}</td>`
      + `<td class="n ${r.rate > 0.4 ? 'neg' : ''}">${Math.round(100 * r.rate)}%</td><td>${Object.entries(r.problems)
        .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p, n]) => `${esc(p)} (${n})`).join('<br>')}</td></tr>`).join('');
    return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>QA stats · Desktop Sidekicks</title><style>
body{margin:0;font:14px/1.45 -apple-system,system-ui,sans-serif;padding:20px 16px 40px;background:#e6e1ea;color:#221d27}
@media(prefers-color-scheme:dark){body{background:#1b1820;color:#efeaf3}}a{color:#6a7bff}
table{border-collapse:collapse;width:100%;max-width:1100px}th,td{padding:7px 10px;border-bottom:1px solid #8884;text-align:left;vertical-align:top}
td.n{text-align:right;font-variant-numeric:tabular-nums}.neg{color:#c0392b}
td.bar span{display:block;height:14px;border-radius:4px;background:#5b6cff;min-width:2px}</style></head><body>
<h1 style="margin:0 0 4px;font-size:24px">QA stats</h1><p><a href="?">← Orders</a> · ${pets} pet${pets === 1 ? '' : 's'} with QA data.
Each failed try is a paid retry: the top rows are where prompt or limit changes save the most.</p>
<h2 style="font-size:18px;margin:18px 0 4px">Cost per action</h2>
<p style="margin:0 0 8px">Average AI cost per pet for each action, retries included, most expensive first; and how often it needs a retry.
Total ≈ ${money(total)} per pet. <span style="opacity:.7">* includes pets made before Nov 20, estimated from their tries at list prices
(re-makes that reused clips count as new there).</span></p>
<div style="overflow-x:auto"><table class="chart"><thead><tr><th>Action</th><th style="width:34%">Avg cost per pet</th><th></th><th>Share</th><th>Pets needing a retry</th><th>Extra tries / pet</th><th>Pets</th></tr></thead>
<tbody>${chart || '<tr><td colspan="7">No data yet.</td></tr>'}</tbody></table></div>
<h2 style="font-size:18px;margin:22px 0 4px">Every clip and image</h2>
<table><thead><tr><th>Clip / image</th><th>Pets</th><th>Tries</th><th>Failed</th><th>Most common problems</th></tr></thead>
<tbody>${body || '<tr><td colspan="5">No QA data yet (it is saved for pets made from now on).</td></tr>'}</tbody></table></body></html>`,
      { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
  }
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
<a href="${esc(link({ all: all ? '' : '1' }))}">${all ? 'Hide unpaid checkouts' : 'Show unpaid checkouts'}</a>
<a href="?view=qa">QA stats</a></div>
<div class="tiles">${tiles.map(([k, v]) => `<div class="tile"><span class="muted">${k}</span><b>${v}</b></div>`).join('')}</div>
<div class="wrap"><table><thead><tr>${COLS.map(([k, h]) => `<th${MONEY.has(k) ? ' class="n"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>
${rows.map((r) => `<tr>${COLS.map(([k]) => (MONEY.has(k) ? money(r, k) : k === 'id' ? `<td><code>${esc(r.id.slice(0, 8))}</code></td>` : `<td>${esc(r[k])}</td>`)).join('')}</tr>`).join('')
  || `<tr><td colspan="${COLS.length}" class="muted">No orders yet.</td></tr>`}
</tbody></table></div></body></html>`;
  return new Response(html, { headers: { ...head, 'content-type': 'text/html; charset=utf-8' } });
}
