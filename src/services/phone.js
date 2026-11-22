// Normalises phone numbers to digits-only international format (no "+"). Default country code 234 (Nigeria).
export function normalizePhone(raw, cc = '234') {
  if (!raw) return null;
  let d = String(raw).replace(/[^\d+]/g, '');
  const plus = d.startsWith('+'); d = d.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (!plus && d.startsWith('0')) d = cc + d.slice(1);
  else if (!plus && d.length === 10 && cc === '234') d = cc + d;
  if (d.length < 10 || d.length > 15) return null;
  if (d.startsWith('234') && !/^234[789]\d{9}$/.test(d)) return null;
  return d;
}
export const isValidPhone = (raw, cc) => !!normalizePhone(raw, cc);
export const waUrl = (phone, message = '') => { const n = normalizePhone(phone); return n ? `https://wa.me/${n}?text=${encodeURIComponent(message)}` : null; };
// Links for opening a chat. 'androidBusiness' targets the WhatsApp Business app explicitly (falls back to the normal link if it is not installed);
// 'web' opens WhatsApp Web, which works for Business accounts too. iPhone has no reliable per-app link, so it uses 'standard'.
export function waLinks(phone, message = '') {
  const n = normalizePhone(phone); if (!n) return null; const text = encodeURIComponent(message); const standard = `https://wa.me/${n}?text=${text}`;
  return { standard, web: `https://web.whatsapp.com/send?phone=${n}&text=${text}`, androidBusiness: `intent://send?phone=${n}&text=${text}#Intent;scheme=whatsapp;package=com.whatsapp.w4b;S.browser_fallback_url=${encodeURIComponent(standard)};end` };
}
