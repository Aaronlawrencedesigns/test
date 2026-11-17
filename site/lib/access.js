// Cloudflare Access check for owner-only pages (/admin/*). Access sits in front of the path and
// signs every request it lets through (Cf-Access-Jwt-Assertion). We verify that signature here too,
// so the page stays closed even if Access were switched off or misconfigured.
// Pages variables: ACCESS_TEAM_DOMAIN (e.g. "yourteam.cloudflareaccess.com"), ACCESS_AUD (the
// application's Audience tag). Until both are set, admin pages refuse everyone.
const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const dec = (s) => JSON.parse(new TextDecoder().decode(b64url(s)));
let certs = null, certsAt = 0;

export async function accessUser(request, env) {
  const team = (env.ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const aud = env.ACCESS_AUD;
  const jwt = request.headers.get('cf-access-jwt-assertion');
  if (!team || !aud || !jwt) return null;
  const [h, p, sig] = jwt.split('.');
  if (!h || !p || !sig) return null;
  let header, payload;
  try { header = dec(h); payload = dec(p); } catch { return null; }
  const now = Date.now() / 1000;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== `https://${team}` || !auds.includes(aud) || !(payload.exp > now) || (payload.nbf && payload.nbf > now + 60)) return null;
  if (!certs || Date.now() - certsAt > 3600e3) {
    const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
    if (!r.ok) return null;
    certs = (await r.json()).keys || [];
    certsAt = Date.now();
  }
  const jwk = certs.find((k) => k.kid === header.kid);
  if (!jwk || header.alg !== 'RS256') return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
  return ok ? (payload.email || 'owner') : null;
}
