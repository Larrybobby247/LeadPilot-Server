import test from 'node:test';
import assert from 'node:assert/strict';
import { extractQuery, buildTextQuery, searchPlaces, placeToRecord, isOpen, regionCode } from '../src/services/places.js';
import { parseResultsText } from '../src/services/pasteParser.js';
import { normalizeLink, productUpdates } from '../src/services/settings.js';

test('pasted Google links become search words', () => {
  assert.equal(extractQuery('https://www.google.com/search?q=restaurants+in+Ibadan&oq=rest&sourceid=chrome'), 'restaurants in Ibadan');
  assert.equal(extractQuery('https://www.google.com/search?q=site%3Ainstagram.com+shortlet+apartments+Lagos'), 'shortlet apartments Lagos'); // site: operators removed
  assert.equal(extractQuery('https://www.google.com/maps/search/solar+companies+in+Ibadan/@7.37,3.9,12z'), 'solar companies in Ibadan');
  assert.equal(extractQuery('https://www.google.com/maps/place/Pepper+House/@6.4,3.4'), 'Pepper House');
  assert.equal(extractQuery('hotels in Lagos'), 'hotels in Lagos'); assert.equal(extractQuery('https://example.com/search?q=x'), null); assert.equal(extractQuery(''), null);
});
test('query building: pasted link wins, fields fill the rest', () => {
  assert.equal(buildTextQuery({ pastedUrl: 'https://www.google.com/search?q=bakeries+in+Abuja', category: 'Cafes', city: 'Lagos' }), 'bakeries in Abuja');
  assert.equal(buildTextQuery({ category: 'Restaurants', city: 'Ibadan', state: 'Oyo', keywords: 'rice' }), 'Restaurants in Ibadan, Oyo rice');
  assert.equal(buildTextQuery({ category: 'Hotels', country: 'Nigeria' }), 'Hotels in Nigeria');
  assert.throws(() => buildTextQuery({ pastedUrl: 'https://example.com' }), /Could not find a search/); assert.throws(() => buildTextQuery({}), /Enter a category/); assert.equal(regionCode('Nigeria'), 'NG');
});
test('Places search pages through results and maps them without inventing data', async () => {
  const calls = []; const page = (n, token) => ({ ok: true, json: async () => ({ places: Array.from({ length: n }, (_, i) => ({ id: 'p' + calls.length + i, displayName: { text: 'Biz ' + calls.length + i }, internationalPhoneNumber: i % 2 ? '+234 803 123 4567' : undefined, websiteUri: i === 0 ? 'https://x.com' : undefined, googleMapsUri: 'https://maps.google.com/?cid=1', businessStatus: i === 3 ? 'CLOSED_PERMANENTLY' : 'OPERATIONAL' })), nextPageToken: token }) });
  const fake = async (url, init) => { calls.push(JSON.parse(init.body)); assert.equal(init.headers['X-Goog-Api-Key'], 'KEY'); return calls.length === 1 ? page(20, 'tok') : page(20, undefined); };
  const { places, requests } = await searchPlaces({ apiKey: 'KEY', textQuery: 'q', maxResults: 30, region: 'NG', fetchFn: fake }); assert.equal(places.length, 30); assert.equal(requests, 2); assert.equal(calls[1].pageToken, 'tok'); assert.equal(calls[1].pageSize, 10); assert.equal(calls[0].regionCode, 'NG');
  const r0 = placeToRecord(places[0], { category: 'Restaurants', city: 'Ibadan' }); assert.equal(r0.phone, undefined); assert.equal(r0.verification, 'requires_review'); assert.equal(r0.city, 'Ibadan');
  const r1 = placeToRecord(places[1], {}); assert.equal(r1.phone, '+234 803 123 4567'); assert.equal(r1.verification, 'unverified'); assert.equal(isOpen(places[3]), false);
  await assert.rejects(() => searchPlaces({ apiKey: 'K', textQuery: 'q', fetchFn: async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'API key not valid' } }) }) }), (e) => e.status === 403 && /not valid/.test(e.message));
});
test('pasted Google results text becomes reviewable leads', () => {
  const text = `Mama Put Kitchen - Ibadan
https://www.mamaput.com.ng › menu
Best amala in Ibadan. Call 0803 456 7788 for orders.
Chop Life Ibadan (@choplife.ibadan) • Instagram
instagram.com/choplife.ibadan
Food, drinks and vibes.
People also ask
Iya Basira Amala Spot
iyabasira.example.com.ng
Open daily. Call 0812 900 1122 or 0809 111 2222`;
  const r = parseResultsText(text, { city: 'Ibadan', category: 'Restaurants' }); assert.equal(r.length, 3);
  assert.equal(r[0].name, 'Mama Put Kitchen - Ibadan'); assert.equal(r[0].phone, '0803 456 7788'); assert.equal(r[0].website, 'https://www.mamaput.com.ng'); assert.equal(r[1].social, 'https://instagram.com/choplife.ibadan'); assert.equal(r[2].phone, undefined);
});
test('pasted text: social profile, multiple phones and nothing invented', () => {
  const r = parseResultsText(`Chop Life Ibadan - Instagram\ninstagram.com/choplife\nFood and vibes\nIya Basira Amala\niyabasira.com.ng\nCall 0812 900 1122 or 0809 111 2222`);
  assert.equal(r.length, 2); assert.equal(r[0].social, 'https://instagram.com/choplife'); assert.equal(r[0].website, undefined); assert.equal(r[0].phone, undefined); assert.equal(r[0].name, 'Chop Life Ibadan');
  assert.equal(r[1].phone, undefined); assert.match(r[1].notes.join(' '), /Several phone numbers/); assert.ok(r.every((x) => x.verification === 'requires_review')); assert.deepEqual(parseResultsText('nothing useful here'), []);
});
test('product info: partial, lenient, no field required', () => {
  assert.equal(normalizeLink('ordarly.com/demo'), 'https://ordarly.com/demo'); assert.equal(normalizeLink(' https://a.com/ '), 'https://a.com'); assert.equal(normalizeLink(''), ''); assert.equal(normalizeLink('not a link'), null); assert.equal(normalizeLink('javascript:alert(1)'), null);
  let u = productUpdates({ ordarly: { description: '  Online ordering  ' } }); assert.deepEqual(u.set, { 'products.ordarly.description': 'Online ordering' }); assert.deepEqual(u.unset, {}); assert.equal(u.errors.length, 0);
  u = productUpdates({ website: { pricing: '', demoLink: 'larryweb.com/demo' }, nope: { description: 'x' }, ordarly: { hacker: 'x' } }); assert.deepEqual(u.set, { 'products.website.demoLink': 'https://larryweb.com/demo' }); assert.deepEqual(u.unset, { 'products.website.pricing': '' });
  u = productUpdates({ keykonnec: { signupLink: 'nope nope', description: 'ok' } }); assert.equal(u.errors[0].path, 'keykonnec.signupLink'); assert.equal(u.set['products.keykonnec.description'], 'ok'); assert.equal(productUpdates({ ordarly: { description: 'x'.repeat(1001) } }).errors.length, 1);
});
