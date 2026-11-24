import { normalizePhone } from './phone.js';
import { sha256 } from '../utils/crypto.js';
// Lead fields a template placeholder can be mapped to. Everything comes from the existing lead/business record; nothing is invented.
export const FIELDS = {
  business_name: { label: 'Business name', kind: 'text' }, business_category: { label: 'Business category', kind: 'text' }, business_description: { label: 'Business description', kind: 'text' },
  phone: { label: 'Phone number (formatted)', kind: 'phone' }, phone_digits: { label: 'Phone number (digits only, for links)', kind: 'digits' },
  whatsapp: { label: 'WhatsApp number (formatted)', kind: 'phone' }, whatsapp_digits: { label: 'WhatsApp number (digits only, for wa.me links)', kind: 'digits' },
  email: { label: 'Email', kind: 'email' }, address: { label: 'Address', kind: 'text' }, city: { label: 'City', kind: 'text' }, state: { label: 'State', kind: 'text' }, country: { label: 'Country', kind: 'text' },
  website_url: { label: 'Existing website URL', kind: 'url' }, instagram_url: { label: 'Instagram URL', kind: 'url' }, facebook_url: { label: 'Facebook URL', kind: 'url' }, linkedin_url: { label: 'LinkedIn URL', kind: 'url' }, contact_person: { label: 'Contact person', kind: 'text' },
};
export const FIELD_KEYS = Object.keys(FIELDS);
const ALIASES = { name: 'business_name', company_name: 'business_name', company: 'business_name', business: 'business_name', category: 'business_category', description: 'business_description', about: 'business_description', tagline: 'business_description',
  phone_number: 'phone', telephone: 'phone', tel: 'phone', mobile: 'phone', whatsapp_number: 'whatsapp', whatsapp_phone: 'whatsapp', email_address: 'email', location: 'address', website: 'website_url', url: 'website_url', instagram: 'instagram_url', facebook: 'facebook_url', linkedin: 'linkedin_url', contact: 'contact_person', owner_name: 'contact_person' };
export const suggestField = (name) => { const k = String(name).toLowerCase(); return FIELDS[k] ? k : ALIASES[k] || null; };

// "Restaurants", "restaurant" and "Restaurant " are the same category.
export const categoryKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/ies$/, 'y').replace(/s$/, '');
export function safeUrl(v) {
  const t = String(v ?? '').trim(); if (!t || /[\s<>"']/.test(t)) return null; try { const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : 'https://' + t); if (!['http:', 'https:'].includes(u.protocol) || !u.hostname.includes('.') || u.username || u.password) return null; return u.href; } catch { return null; }
}
const fmtPhone = (d) => (d.startsWith('234') ? `+234 ${d.slice(3, 6)} ${d.slice(6, 9)} ${d.slice(9)}` : '+' + d);
const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/; const text = (v) => { const t = String(v ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim(); return t ? t.slice(0, 2000) : null; };
// Only what is genuinely on file. WhatsApp is the lead's own WhatsApp number, never guessed from the phone number.
export function leadValues(lead, b) {
  const phone = (b.phones || [])[0] || null; const wa = normalizePhone(lead.whatsappNumber);
  const email = (b.emails || [])[0]; const soc = (u) => safeUrl(u);
  return { business_name: text(b.name), business_category: text(b.category), business_description: text(b.description), phone: phone ? fmtPhone(phone) : null, phone_digits: phone, whatsapp: wa ? fmtPhone(wa) : null, whatsapp_digits: wa,
    email: email && EMAIL.test(email) ? email : null, address: text(b.address), city: text(b.city), state: text(b.state), country: text(b.country), website_url: safeUrl(b.website), instagram_url: soc(b.instagram), facebook_url: soc(b.facebook), linkedin_url: soc(b.linkedin), contact_person: text(lead.contactPerson) };
}
// placeholder -> { text, kind } or null (null = leave the placeholder as it is)
export function makeResolver(values, mappings = {}) {
  return (name) => { const m = mappings[name] || {}; const f = m.field && m.field !== 'none' ? m.field : null; const v = f ? values[f] : null; if (v) return { text: v, kind: FIELDS[f].kind }; const d = text(m.default); return d ? { text: d, kind: 'text' } : null; };
}
const sortKeys = (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v);
export const dataHash = (values, mappings, version) => sha256(JSON.stringify([values, mappings || {}, version], sortKeys)); // key order never changes the hash
