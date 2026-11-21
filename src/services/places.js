// Direct lead generation via the official Google Places API (Text Search). The owner supplies the key and a monthly request limit.
export class PlacesError extends Error { constructor(status, message) { super(message); this.status = status; } }
const URL_ = 'https://places.googleapis.com/v1/places:searchText';
const MASK = 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.googleMapsUri,places.primaryTypeDisplayName,places.businessStatus,nextPageToken';
const REGION = { nigeria: 'NG', ghana: 'GH', kenya: 'KE', 'south africa': 'ZA', 'united kingdom': 'GB', 'united states': 'US', canada: 'CA' };
export const regionCode = (country = '') => REGION[String(country).trim().toLowerCase()];
const clean = (q) => String(q).replace(/\b(site|inurl|intitle|intext|filetype|related|cache):\S+/gi, ' ').replace(/["+]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

// Accepts a pasted Google Search or Maps link, or plain text. Returns the search words, or null if nothing usable was found.
export function extractQuery(input = '') {
  const t = String(input).trim(); if (!t) return null;
  if (!/^(https?:\/\/|www\.)/i.test(t) && !/^google\./i.test(t)) return clean(t) || null;
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : 'https://' + t); if (!/(^|\.)google\.[a-z.]+$/.test(u.hostname)) return null;
    const q = u.searchParams.get('q') || u.searchParams.get('query'); if (q) return clean(q) || null;
    const m = u.pathname.match(/\/maps\/(?:search|place)\/([^/@]+)/); if (m) return clean(decodeURIComponent(m[1].replace(/\+/g, ' '))) || null;
  } catch { /* fall through */ }
  return null;
}
export function buildTextQuery({ pastedUrl, category, city, state, country, keywords }) {
  if (pastedUrl && pastedUrl.trim()) { const q = extractQuery(pastedUrl); if (!q) throw new PlacesError(400, 'Could not find a search in that link. Paste a Google Search or Google Maps link, or clear the box.'); return q; }
  const where = [city, state].filter(Boolean).join(', ') || country || ''; const q = clean(`${category || ''} ${where ? 'in ' + where : ''} ${keywords || ''}`); if (!q) throw new PlacesError(400, 'Enter a category and location, or paste a search link.'); return q;
}
export async function searchPlaces({ apiKey, textQuery, maxResults = 20, region, fetchFn = fetch }) {
  const out = []; let pageToken, requests = 0;
  while (out.length < maxResults && requests < 3) {
    const res = await fetchFn(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': MASK }, body: JSON.stringify({ textQuery, pageSize: Math.min(20, maxResults - out.length), ...(region && { regionCode: region }), ...(pageToken && { pageToken }) }) });
    requests++; if (!res.ok) { const e = await res.json().catch(() => ({})); throw new PlacesError(res.status, e?.error?.message || `Google returned ${res.status}`); }
    const data = await res.json(); out.push(...(data.places || [])); pageToken = data.nextPageToken; if (!pageToken) break;
  }
  return { places: out.slice(0, maxResults), requests };
}
export const placeToRecord = (p, { category, city, state } = {}) => {
  const phone = p.internationalPhoneNumber || p.nationalPhoneNumber || undefined; const notes = ['From Google Places. Confirm the details before contacting.']; if (!phone) notes.unshift('No phone number listed.');
  return { name: p.displayName?.text || '', category: category || p.primaryTypeDisplayName?.text, phone, website: p.websiteUri, address: p.formattedAddress, city, state, sourceUrl: p.googleMapsUri, verification: phone ? 'unverified' : 'requires_review', notes };
};
export const isOpen = (p) => p.businessStatus !== 'CLOSED_PERMANENTLY';
