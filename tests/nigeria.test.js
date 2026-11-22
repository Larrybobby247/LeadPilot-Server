import test from 'node:test';
import assert from 'node:assert/strict';
import { STATES, STATE_NAMES, ZONES, citiesOf, canonicalState, resolveLocation, resolveState, territoryCheck, stateAllowed } from '../src/data/nigeria.js';

test('the list covers 36 states + FCT in six zones, major cities only', () => {
  assert.equal(STATES.length, 37); assert.equal(new Set(STATE_NAMES).size, 37); assert.equal(ZONES.length, 6);
  assert.deepEqual(citiesOf('Lagos'), ['Ikeja', 'Lagos Island', 'Lekki', 'Victoria Island', 'Ikorodu', 'Epe', 'Badagry', 'Ajah', 'Surulere']);
  assert.deepEqual(citiesOf('oyo state'), ['Ibadan', 'Ogbomoso', 'Oyo', 'Iseyin', 'Saki', 'Eruwa']); assert.deepEqual(citiesOf('FCT'), ['Abuja', 'Gwagwalada', 'Kubwa', 'Kuje', 'Bwari']); assert.deepEqual(citiesOf('nowhere'), []);
  const all = STATES.flatMap((s) => s.cities.map((c) => c.toLowerCase())); assert.equal(all.length, new Set(all).size, 'a city appears under two states');
});
test('every listed city resolves to its own state', () => { for (const s of STATES) for (const c of s.cities) assert.equal(resolveState({ city: c }), s.name, c); });
test('state names and aliases', () => {
  assert.equal(canonicalState('Oyo State'), 'Oyo'); assert.equal(canonicalState('akwa-ibom'), 'Akwa Ibom'); assert.equal(canonicalState('Cross River State'), 'Cross River'); assert.equal(canonicalState('Federal Capital Territory'), 'FCT'); assert.equal(canonicalState('Abuja'), 'FCT'); assert.equal(canonicalState('Atlantis'), null);
});
test('addresses and search text: the last mention wins', () => {
  assert.equal(resolveState({ address: '12 Bodija Road, Ibadan, Oyo, Nigeria' }), 'Oyo'); assert.equal(resolveState({ address: 'Lagos Road, Ibadan' }), 'Oyo'); assert.equal(resolveState({ address: 'Ondo Road, Benin City, Edo State' }), 'Edo');
  assert.equal(resolveState({ address: 'Plot 5, Wuse 2, Abuja' }), 'FCT'); assert.equal(resolveState({ text: 'restaurants in Port Harcourt' }), 'Rivers'); assert.equal(resolveState({ text: 'solar companies in Ile-Ife' }), 'Osun'); assert.equal(resolveState({ text: 'hotels in Ife' }), 'Osun');
  assert.equal(resolveState({ address: 'Somewhere unknown' }), null); assert.equal(resolveState({}), null);
  assert.deepEqual(resolveLocation({ address: '3 Allen Ave, Ikeja, Lagos' }), { state: 'Lagos', city: 'Ikeja' }); assert.deepEqual(resolveLocation({ text: 'bakeries in Kano' }), { state: 'Kano', city: 'Kano' });
});
test('priority: own fields, then address, then search, then the working state', () => {
  assert.equal(resolveState({ state: 'Lagos', address: 'Ibadan, Oyo' }), 'Lagos'); assert.equal(resolveState({ city: 'Ibadan', address: 'x, Lagos' }), 'Oyo');
  assert.equal(resolveState({ address: 'Ibadan, Oyo', text: 'restaurants in Lagos' }), 'Oyo'); assert.equal(resolveState({ text: 'restaurants in Lagos', contextState: 'Oyo' }), 'Lagos'); assert.equal(resolveState({ contextState: 'Oyo' }), 'Oyo');
});
test('territory enforcement', () => {
  const member = { role: 'member', states: ['Oyo', 'Osun'] }; const owner = { role: 'owner', states: ['Oyo'] }; const legacy = { role: 'member', states: [] };
  assert.equal(territoryCheck(member, 'Oyo').ok, true); const out = territoryCheck(member, 'Lagos'); assert.equal(out.ok, false); assert.match(out.reason, /Outside your assigned states \(Oyo, Osun\)/);
  assert.equal(territoryCheck(member, null).ok, false); assert.match(territoryCheck(member, null).reason, /Could not tell/);
  assert.equal(territoryCheck(owner, 'Lagos').ok, true); assert.equal(territoryCheck(legacy, 'Lagos').ok, true); assert.equal(territoryCheck(legacy, null).ok, true);
  assert.equal(stateAllowed(member, 'Lagos'), false); assert.equal(stateAllowed(member, 'Osun'), true); assert.equal(stateAllowed(member, null), true); assert.equal(stateAllowed(owner, 'Lagos'), true);
});
