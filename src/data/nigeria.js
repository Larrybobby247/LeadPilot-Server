// Nigeria: states grouped by zone, with major cities only (no towns). Pure ES module, identical copy lives in the frontend.
export const ZONES = ['North Central', 'North East', 'North West', 'South East', 'South South', 'South West'];
const S = (zone, name, cities) => ({ zone, name, cities });
export const STATES = [
  S('North Central', 'Benue', ['Makurdi', 'Gboko', 'Otukpo', 'Katsina-Ala']), S('North Central', 'Kogi', ['Lokoja', 'Okene', 'Anyigba', 'Kabba', 'Idah']),
  S('North Central', 'Kwara', ['Ilorin', 'Offa', 'Omu-Aran', 'Jebba']), S('North Central', 'Nasarawa', ['Lafia', 'Keffi', 'Karu', 'Akwanga']),
  S('North Central', 'Niger', ['Minna', 'Bida', 'Suleja', 'Kontagora']), S('North Central', 'Plateau', ['Jos', 'Bukuru', 'Pankshin', 'Shendam']),
  S('North Central', 'FCT', ['Abuja', 'Gwagwalada', 'Kubwa', 'Kuje', 'Bwari']),
  S('North East', 'Adamawa', ['Yola', 'Jimeta', 'Mubi', 'Numan']), S('North East', 'Bauchi', ['Bauchi', 'Azare', 'Misau', 'Ningi']),
  S('North East', 'Borno', ['Maiduguri', 'Biu', 'Bama', 'Dikwa']), S('North East', 'Gombe', ['Gombe', 'Kumo', 'Billiri', 'Kaltungo']),
  S('North East', 'Taraba', ['Jalingo', 'Wukari', 'Takum', 'Bali']), S('North East', 'Yobe', ['Damaturu', 'Potiskum', 'Gashua', 'Nguru']),
  S('North West', 'Jigawa', ['Dutse', 'Hadejia', 'Kazaure', 'Gumel']), S('North West', 'Kaduna', ['Kaduna', 'Zaria', 'Kafanchan', 'Saminaka']),
  S('North West', 'Kano', ['Kano', 'Wudil', 'Bichi', 'Gaya']), S('North West', 'Katsina', ['Katsina', 'Daura', 'Funtua', 'Malumfashi']),
  S('North West', 'Kebbi', ['Birnin Kebbi', 'Argungu', 'Yauri', 'Zuru']), S('North West', 'Sokoto', ['Sokoto', 'Tambuwal', 'Illela', 'Wurno']),
  S('North West', 'Zamfara', ['Gusau', 'Kaura Namoda', 'Talata Mafara', 'Anka']),
  S('South East', 'Abia', ['Aba', 'Umuahia', 'Ohafia', 'Arochukwu']), S('South East', 'Anambra', ['Awka', 'Onitsha', 'Nnewi', 'Ekwulobia']),
  S('South East', 'Ebonyi', ['Abakaliki', 'Afikpo', 'Onueke', 'Ezzamgbo']), S('South East', 'Enugu', ['Enugu', 'Nsukka', 'Agbani', 'Udi']),
  S('South East', 'Imo', ['Owerri', 'Orlu', 'Okigwe', 'Mbaise']),
  S('South South', 'Akwa Ibom', ['Uyo', 'Eket', 'Ikot Ekpene', 'Oron']), S('South South', 'Bayelsa', ['Yenagoa', 'Ogbia', 'Brass', 'Nembe']),
  S('South South', 'Cross River', ['Calabar', 'Ikom', 'Ogoja', 'Ugep', 'Obudu']), S('South South', 'Delta', ['Asaba', 'Warri', 'Effurun', 'Sapele', 'Ughelli', 'Agbor']),
  S('South South', 'Edo', ['Benin City', 'Auchi', 'Ekpoma', 'Uromi']), S('South South', 'Rivers', ['Port Harcourt', 'Bonny', 'Omoku', 'Ahoada', 'Bori']),
  S('South West', 'Ekiti', ['Ado-Ekiti', 'Ikere-Ekiti', 'Ikole-Ekiti', 'Ijero-Ekiti']),
  S('South West', 'Lagos', ['Ikeja', 'Lagos Island', 'Lekki', 'Victoria Island', 'Ikorodu', 'Epe', 'Badagry', 'Ajah', 'Surulere']),
  S('South West', 'Ogun', ['Abeokuta', 'Sagamu', 'Ijebu-Ode', 'Ota', 'Ifo', 'Ilaro']), S('South West', 'Ondo', ['Akure', 'Ondo', 'Owo', 'Ikare-Akoko', 'Ore', 'Okitipupa']),
  S('South West', 'Osun', ['Osogbo', 'Ile-Ife', 'Ilesa', 'Ede', 'Iwo', 'Ikirun']), S('South West', 'Oyo', ['Ibadan', 'Ogbomoso', 'Oyo', 'Iseyin', 'Saki', 'Eruwa']),
];
export const STATE_NAMES = STATES.map((s) => s.name);
export const citiesOf = (state) => STATES.find((s) => s.name === canonicalState(state))?.cities || [];

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/\bstate\b/g, ' ').replace(/[^a-z]/g, '');
const words = (s) => ` ${String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim()} `;
const STATE_ALIAS = { federalcapitalterritory: 'FCT', abuja: 'FCT' };
const STATE_BY_KEY = new Map(STATES.map((s) => [norm(s.name), s.name])); Object.entries(STATE_ALIAS).forEach(([k, v]) => STATE_BY_KEY.set(k, v));
const CITY_BY_KEY = new Map(); STATES.forEach((s) => s.cities.forEach((c) => { if (!CITY_BY_KEY.has(norm(c))) CITY_BY_KEY.set(norm(c), { state: s.name, city: c }); }));
const EXTRA = [['ife', 'Osun', 'Ile-Ife'], ['benin', 'Edo', 'Benin City'], ['federal capital territory', 'FCT', null]];
const PHRASES = [...STATES.map((s) => ({ p: words(s.name), state: s.name, kind: 'state' })), ...EXTRA.map(([p, state, city]) => ({ p: words(p), state, city, kind: city ? 'city' : 'state' })),
  ...STATES.flatMap((s) => s.cities.map((c) => ({ p: words(c), state: s.name, city: c, kind: 'city' })))];
export const canonicalState = (name) => (name ? STATE_BY_KEY.get(norm(name)) || null : null);
// Last mention wins: Nigerian addresses end with the state ("...Ibadan, Oyo, Nigeria"), and "Lagos Road, Ibadan" must resolve to Oyo.
function scan(text) {
  const t = words(text); if (t.trim() === '') return null; let best = null;
  for (const ph of PHRASES) { const i = t.lastIndexOf(ph.p); if (i < 0) continue; const end = i + ph.p.length; if (!best || end > best.end || (end === best.end && ph.kind === 'state')) best = { end, ...ph }; }
  if (!best) return null; let city = best.kind === 'city' ? best.city : null;
  if (!city) { let ce = -1; for (const ph of PHRASES) if (ph.kind === 'city' && ph.state === best.state) { const i = t.lastIndexOf(ph.p); if (i >= 0 && i > ce) { ce = i; city = ph.city; } } }
  return { state: best.state, city };
}
// Order: explicit state, explicit city, address text, search text, then the state the user was working in.
export function resolveLocation({ state, city, address, text, contextState } = {}) {
  let st = canonicalState(state); let ct = null;
  if (!st && city) { const k = norm(city); const hit = CITY_BY_KEY.get(k); if (hit) { st = hit.state; ct = hit.city; } else if (STATE_BY_KEY.has(k)) st = STATE_BY_KEY.get(k); }
  if (!st) for (const t of [address, text]) { const m = t && scan(t); if (m) { st = m.state; ct = m.city; break; } }
  if (!st && contextState) st = canonicalState(contextState);
  return { state: st || null, city: ct || null };
}
export const resolveState = (o) => resolveLocation(o).state;
// Owners are never restricted. A member with no states yet is unrestricted until the owner assigns some. Unknown business state is allowed here (used for existing leads).
export const stateAllowed = (user, state) => user.role === 'owner' || !(user.states || []).length || !state || user.states.includes(canonicalState(state) || state);
// Strict version for new leads: the state must be known and assigned.
export function territoryCheck(user, state) {
  if (user.role === 'owner') return { ok: true }; const mine = user.states || []; if (!mine.length) return { ok: true };
  if (!state) return { ok: false, reason: 'Could not tell which state this business is in. Add the state or city and try again.' };
  return mine.includes(state) ? { ok: true } : { ok: false, reason: `Outside your assigned states (${mine.join(', ')}). This business looks like it is in ${state}.` };
}
