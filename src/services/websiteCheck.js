import dns from 'node:dns/promises';
import net from 'node:net';
export function isBlockedIp(ip) {
  if (net.isIPv4(ip)) { const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224; }
  if (net.isIPv6(ip)) { const l = ip.toLowerCase(); if (l === '::1' || l === '::') return true; if (l.startsWith('::ffff:')) return isBlockedIp(l.slice(7)); return /^f[cd]/.test(l) || /^fe[89ab]/.test(l); }
  return true;
}
const blocked = (m) => Object.assign(new Error(m), { code: 'BLOCKED' });
export async function assertSafeUrl(raw) {
  let u; try { u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); } catch { throw Object.assign(new Error('invalid url'), { code: 'BADURL' }); }
  if (!['http:', 'https:'].includes(u.protocol)) throw blocked('bad protocol');
  if (u.port && !['80', '443'].includes(u.port)) throw blocked('bad port');
  if (u.username || u.password) throw blocked('credentials in url');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) { if (isBlockedIp(host)) throw blocked('blocked ip'); return u; }
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw blocked('blocked host');
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isBlockedIp(a.address))) throw blocked('blocked address');
  return u;
}
const PARKED = /(this domain (is|may be) for sale|domain is for sale|buy this domain|parked (free|domain)|domain parking|sedoparking|godaddy\.com\/forsale|hugedomains|afternic|under construction.{0,40}coming soon)/i;
// Pure. Timeouts, blocks and 5xx never mean "broken" on their own.
export function classify({ url, dnsError, status, body = '', error, redirects = 0 }) {
  if (!url) return { status: 'NO_WEBSITE', reason: 'No website URL supplied.' };
  if (error === 'BLOCKED') return { status: 'UNCERTAIN', reason: 'Address could not be checked safely. Review manually.' };
  if (dnsError === 'ENOTFOUND') return { status: 'BROKEN_WEBSITE', reason: 'Domain does not resolve.' };
  if (dnsError) return { status: 'UNCERTAIN', reason: 'Temporary DNS problem.' };
  if (error) return { status: 'UNCERTAIN', reason: 'Request failed or timed out; this is not proof the site is down.' };
  if (status >= 200 && status < 300) { if (PARKED.test(body.slice(0, 20000))) return { status: 'PARKED_DOMAIN', reason: 'Page looks like a parked or for-sale domain.' }; return { status: 'WORKING_WEBSITE', reason: `Responded with ${status}${redirects ? ` after ${redirects} redirect(s)` : ''}.` }; }
  if (status === 404 || status === 410) return { status: 'BROKEN_WEBSITE', reason: `Home page returned ${status}.` };
  if (status === 401 || status === 403 || status === 429 || status >= 500) return { status: 'UNCERTAIN', reason: `Server returned ${status}; the site may be blocking automated checks.` };
  return { status: 'UNCERTAIN', reason: `Unexpected response ${status}.` };
}
export async function checkWebsite(raw, { timeoutMs = 8000, maxRedirects = 3 } = {}) {
  const done = (o) => ({ ...classify(o), checkedAt: new Date() });
  if (!raw) return done({ url: '' });
  let current = raw, redirects = 0;
  try {
    for (;;) {
      let u; try { u = await assertSafeUrl(current); } catch (e) { return done(e.code === 'BLOCKED' || e.code === 'BADURL' ? { url: raw, error: 'BLOCKED' } : { url: raw, dnsError: e.code }); }
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
      let res; try { res = await fetch(u, { redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': 'LeadPilotBot/1.0 (website status check)' } }); } finally { clearTimeout(t); }
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) { if (++redirects > maxRedirects) return done({ url: raw, error: 'TOO_MANY_REDIRECTS' }); current = new URL(res.headers.get('location'), u).href; continue; }
      const body = (await res.text().catch(() => '')).slice(0, 20000);
      return done({ url: raw, status: res.status, body, redirects });
    }
  } catch (e) { return done({ url: raw, error: e.name || 'ERR' }); }
}
