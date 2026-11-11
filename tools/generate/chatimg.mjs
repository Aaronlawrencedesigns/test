import fs from 'node:fs';
import { dataUri } from './gp.mjs';
const [model, out, promptFile, ...refNames] = process.argv.slice(2);
const prompt = fs.readFileSync(promptFile, 'utf8');
const content = [{ type: 'text', text: prompt }, ...refNames.map((n) => ({ type: 'image_url', image_url: { url: n.startsWith('http') ? n : dataUri(n) } }))];
const r = await fetch('https://gptproto.com/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.GPTPROTO_API_KEY || 'proxy-injected'}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model, messages: [{ role: 'user', content }], modalities: ['image', 'text'] }),
});
const txt = await r.text();
fs.writeFileSync(out + '.json', txt);
let j; try { j = JSON.parse(txt); } catch { console.log('non-json', r.status, txt.slice(0, 400)); process.exit(1); }
if (j.error) { console.log('error', JSON.stringify(j.error).slice(0, 500)); process.exit(1); }
const msg = j.choices?.[0]?.message || {};
const cands = [];
for (const im of msg.images || []) cands.push(im.image_url?.url || im.url);
const s = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
for (const m of s.matchAll(/(data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+)|(https?:\/\/[^\s)"']+\.(?:png|jpe?g|webp))/g)) cands.push(m[0]);
console.log('status', r.status, 'usage', JSON.stringify(j.usage || {}), 'found', cands.length, s.replace(/data:image[^)]+/g, '<b64>').slice(0, 300));
let i = 0;
for (const c of cands) {
  const f = `${out}${cands.length > 1 ? '_' + i++ : ''}.png`;
  if (c.startsWith('data:')) fs.writeFileSync(f, Buffer.from(c.split(',')[1], 'base64'));
  else { const d = await fetch(c); fs.writeFileSync(f, Buffer.from(await d.arrayBuffer())); console.log('url', c); }
  console.log('saved', f);
}
