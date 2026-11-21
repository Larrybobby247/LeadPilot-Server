export const DEFAULT_WEIGHTS = { name: 15, category: 10, location: 10, phone: 25, whatsappVerified: 15, social: 10, website: 5, email: 10 };
// Measures how complete a record is. It says nothing about purchase intent.
export function completeness(l, w = DEFAULT_WEIGHTS) {
  const has = { name: !!l.name, category: !!l.category, location: !!(l.city || l.state || l.address), phone: !!(l.phones?.length || l.phone), whatsappVerified: !!l.whatsappVerified,
    social: !!(l.socials?.length || l.instagram || l.facebook || l.linkedin), website: !!l.website, email: !!(l.emails?.length || l.email) };
  const total = Object.values(w).reduce((a, b) => a + b, 0) || 100;
  const score = Math.round(Object.entries(w).reduce((s, [k, pts]) => s + (has[k] ? pts : 0), 0) * 100 / total);
  return { score, band: score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low' };
}
export const isContactReady = (l) => !!(l.phones && l.phones.length);
