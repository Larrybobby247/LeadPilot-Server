import { DEPARTMENTS } from '../config.js';
export const PRODUCT_FIELDS = { productName: 80, description: 1000, pricing: 1000, competitorNotes: 1500, demoLink: 300, signupLink: 300 };
// Lenient: "ordarly.com/demo" is fine, https:// is added. Returns '' for blank, null for something that is not a web address.
export function normalizeLink(v) {
  const t = String(v ?? '').trim(); if (!t) return ''; const u = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : 'https://' + t;
  try { const x = new URL(u); if (!['http:', 'https:'].includes(x.protocol) || !x.hostname.includes('.')) return null; return x.href.replace(/\/$/, ''); } catch { return null; }
}
// Partial saves: only the fields that were sent are touched. Blank = clear that one field. Nothing else is required.
export function productUpdates(input = {}) {
  const set = {}, unset = {}, errors = [];
  for (const [d, fields] of Object.entries(input || {})) {
    if (!DEPARTMENTS.includes(d) || !fields || typeof fields !== 'object') continue;
    for (const [f, max] of Object.entries(PRODUCT_FIELDS)) {
      if (!(f in fields)) continue; let v = fields[f] == null ? '' : String(fields[f]).trim(); const path = `products.${d}.${f}`;
      if (f.endsWith('Link')) { const n = normalizeLink(v); if (n === null) { errors.push({ path: `${d}.${f}`, message: 'Enter a valid web address, for example ordarly.com/demo' }); continue; } v = n; }
      if (v.length > max) { errors.push({ path: `${d}.${f}`, message: `Too long (maximum ${max} characters)` }); continue; }
      if (v === '') unset[path] = ''; else set[path] = v;
    }
  }
  return { set, unset, errors };
}
