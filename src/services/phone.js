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
