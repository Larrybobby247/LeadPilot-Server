import { normalizePhone } from './phone.js';
const STOP = new Set(['ltd', 'limited', 'nig', 'nigeria', 'plc', 'inc', 'co', 'company', 'the', 'and', 'enterprises', 'enterprise']);
export const normalizeName = (n = '') => String(n).toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)).join(' ');
export function domainOf(url = '') {
  try { const u = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url); const h = u.hostname.replace(/^www\./, '').toLowerCase(); return h.includes('.') ? h : ''; } catch { return ''; }
}
const SOCIAL_HOSTS = /(instagram|facebook|linkedin|x|twitter|tiktok)\.com$/;
export function socialKey(url = '') {
  try { const u = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url); const h = u.hostname.replace(/^www\./, '').toLowerCase(); if (!SOCIAL_HOSTS.test(h)) return '';
    const seg = u.pathname.split('/').filter(Boolean); if (h.startsWith('linkedin')) return seg.length >= 2 ? `${h}/${seg[0]}/${seg[1].toLowerCase()}` : '';
    return seg[0] ? `${h}/${seg[0].toLowerCase()}` : ''; } catch { return ''; }
}
export function keysFor(r) {
  const phones = [...new Set([r.phone, r.whatsapp, ...(r.phones || [])].map((p) => normalizePhone(p)).filter(Boolean))];
  const emails = [...new Set([r.email, ...(r.emails || [])].filter(Boolean).map((e) => e.trim().toLowerCase()))];
  const wd = domainOf(r.website); const domains = wd && !SOCIAL_HOSTS.test(wd) ? [wd] : [];
  const socials = [...new Set([r.instagram, r.facebook, r.linkedin, r.social, ...(r.socials || [])].map(socialKey).filter(Boolean))];
  return { phones, emails, domains, socials, normName: normalizeName(r.name), city: (r.city || r.location || '').trim().toLowerCase() };
}
// Never matches on name alone.
export function compare(a, b) {
  const x = a.phones ? a : keysFor(a), y = b.phones ? b : keysFor(b); const on = [];
  const hit = (p, q) => p.some((v) => q.includes(v));
  if (hit(x.phones, y.phones)) on.push('phone'); if (hit(x.emails, y.emails)) on.push('email');
  if (hit(x.domains, y.domains)) on.push('website'); if (hit(x.socials, y.socials)) on.push('social');
  if (x.normName && x.normName === y.normName && x.city && x.city === y.city) on.push('name+city');
  return on;
}
// Never overwrite verified data with weaker data.
export function mergeFields(existing, incoming, { existingVerified = false, incomingVerified = false } = {}) {
  const out = { ...existing }; const conflicts = [];
  for (const k of Object.keys(incoming)) { const v = incoming[k]; if (v == null || v === '') continue;
    if (out[k] == null || out[k] === '') out[k] = v;
    else if (out[k] !== v) { conflicts.push({ field: k, existing: out[k], incoming: v }); if (incomingVerified && !existingVerified) out[k] = v; } }
  return { merged: out, conflicts };
}
// Identifier rows used by the BusinessKey unique index (the atomic guard against concurrent imports).
export const businessKeys = (k) => [...k.phones.map((v) => 'phone:' + v), ...k.emails.map((v) => 'email:' + v), ...k.domains.map((v) => 'domain:' + v), ...k.socials.map((v) => 'social:' + v)];
// Exact = a shared phone, email, website or social profile. Name+city alone is only a "potential" duplicate that a human must review.
export const isExact = (on) => on.some((x) => x !== 'name+city');
// Strips tracking params and fragments so equivalent URLs compare equal.
export function canonicalUrl(url = '') { try { const u = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url); u.hash = ''; [...u.searchParams.keys()].filter((k) => /^(utm_|fbclid|gclid|igshid|ref$|mc_)/i.test(k)).forEach((k) => u.searchParams.delete(k)); return u.hostname.replace(/^www\./, '').toLowerCase() + u.pathname.replace(/\/+$/, '') + u.search; } catch { return ''; } }

// Pure decision. 'taken' = another user already holds this exact business (in any workspace): it is filtered out for everyone but the owner.
export function decideKind({ matchedOn, leadInDept, heldByOther, isOwner, policy = 'filter' }) {
  const exact = isExact(matchedOn);
  if (!isOwner && policy === 'filter' && exact && heldByOther) return 'taken';
  if (leadInDept) return exact ? 'duplicate' : 'potential';
  return exact ? 'associate' : 'potential';
}
