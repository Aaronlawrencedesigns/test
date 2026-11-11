// Minimal GPTProto client. The proxy injects the real API key.
import fs from 'node:fs';
const BASE = 'https://gptproto.com/api/v3';
// Set GPTPROTO_API_KEY in your shell (never commit it).
const H = { Authorization: `Bearer ${process.env.GPTPROTO_API_KEY || 'proxy-injected'}`, 'Content-Type': 'application/json' };
export const dataUri = (p) => `data:image/${p.endsWith('.png') ? 'png' : 'jpeg'};base64,` + fs.readFileSync(p).toString('base64');
export async function run(path, body, { pollMs = 3000, timeoutMs = 15 * 60e3 } = {}) {
  const r = await fetch(`${BASE}/${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const j = await r.json().catch(async () => ({ raw: await r.text() }));
  if (!j.data?.id) throw new Error('submit failed: ' + JSON.stringify(j).slice(0, 600));
  const url = j.data.urls?.get || `${BASE}/predictions/${j.data.id}/result`;
  const t0 = Date.now();
  let last = '';
  console.error('[gp] submitted', j.data.id);
  for (;;) {
    if (j.data?.status !== last) { last = j.data?.status; console.error('[gp]', j.data.id, last, ((Date.now() - t0) / 1000) | 0, 's'); }
    if (['completed', 'succeeded'].includes(j.data?.status) && j.data.outputs?.length) return j.data;
    if (j.data?.status === 'failed') throw new Error('failed: ' + j.data.error);
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout ' + j.data.id);
    await new Promise((r) => setTimeout(r, pollMs));
    const g = await fetch(url, { headers: H });
    const k = await g.json().catch(() => null);
    if (k?.data) j.data = k.data;
  }
}
export async function save(output, file) {
  if (output.startsWith('http')) {
    const r = await fetch(output);
    if (!r.ok) throw new Error('download ' + r.status + ' ' + output);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  } else {
    fs.writeFileSync(file, Buffer.from(output.replace(/^data:[^,]+,/, ''), 'base64'));
  }
  return file;
}
