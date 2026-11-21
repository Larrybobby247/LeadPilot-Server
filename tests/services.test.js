import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, waUrl } from '../src/services/phone.js';
import { compare, keysFor, normalizeName, mergeFields, domainOf, socialKey } from '../src/services/dedupe.js';
import { completeness } from '../src/services/scoring.js';
import { render } from '../src/services/templates.js';
import { dueDate, canFollowUp } from '../src/services/followups.js';
import { classify, isBlockedIp, assertSafeUrl } from '../src/services/websiteCheck.js';
import { encrypt, decrypt } from '../src/utils/crypto.js';

test('phone normalisation', () => {
  assert.equal(normalizePhone('0803 123 4567'), '2348031234567');
  assert.equal(normalizePhone('+234 803 123 4567'), '2348031234567');
  assert.equal(normalizePhone('8031234567'), '2348031234567');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('0603 123 4567'), null);
  assert.equal(waUrl('0803 123 4567', 'Hi there & you'), 'https://wa.me/2348031234567?text=Hi%20there%20%26%20you');
  assert.equal(waUrl('abc', 'x'), null);
});
test('dedupe never matches on name alone', () => {
  const a = keysFor({ name: 'Mama Put Ltd', city: 'Ibadan' });
  assert.deepEqual(compare(a, keysFor({ name: 'Mama Put', city: 'Lagos' })), []);
  assert.deepEqual(compare(a, keysFor({ name: 'Mama Put', city: 'Ibadan' })), ['name+city']);
  assert.ok(compare({ phone: '0803 123 4567' }, { phone: '+2348031234567' }).includes('phone'));
  assert.ok(compare({ website: 'https://www.food.com/menu' }, { website: 'food.com' }).includes('website'));
  assert.ok(compare({ social: 'https://instagram.com/Choplife/' }, { instagram: 'instagram.com/choplife?hl=en' }).includes('social'));
});
test('social profiles are not treated as website domains', () => {
  assert.deepEqual(keysFor({ website: 'https://facebook.com/abc' }).domains, []);
  assert.equal(socialKey('https://linkedin.com/company/sungrid'), 'linkedin.com/company/sungrid');
  assert.equal(domainOf('notaurl'), '');
  assert.equal(normalizeName('The Food Court Nig. Ltd'), 'food court');
});
test('merge keeps verified values', () => {
  const r = mergeFields({ phone: 'A', email: '' }, { phone: 'B', email: 'x@y.com' }, { existingVerified: true, incomingVerified: false });
  assert.equal(r.merged.phone, 'A'); assert.equal(r.merged.email, 'x@y.com'); assert.equal(r.conflicts.length, 1);
  assert.equal(mergeFields({ phone: 'A' }, { phone: 'B' }, { incomingVerified: true }).merged.phone, 'B');
});
test('completeness scoring', () => {
  assert.equal(completeness({ name: 'x' }).score, 15);
  const full = completeness({ name: 'x', category: 'c', city: 'i', phones: ['1'], whatsappVerified: true, socials: ['s'], website: 'w', emails: ['e'] });
  assert.equal(full.score, 100); assert.equal(full.band, 'high');
  assert.equal(completeness({ name: 'x', phones: ['1'] }).band, 'medium');
});
test('template rendering', () => {
  const r = render('Hi {{contact_name}}, we help {{business_name}} in {{city}}. {{nope}}', { business_name: 'Pepper House', city: 'Lagos' });
  assert.equal(r.text, 'Hi, we help Pepper House in Lagos.'); assert.deepEqual(r.missing, ['contact_name']);
});
test('follow-up schedule', () => {
  const d0 = new Date('2026-01-01T00:00:00Z');
  assert.equal(dueDate(d0, 0).toISOString().slice(0, 10), '2026-01-03');
  assert.equal(dueDate(d0, 1).toISOString().slice(0, 10), '2026-01-05');
  assert.equal(dueDate(d0, 2).toISOString().slice(0, 10), '2026-01-08');
  assert.equal(dueDate(d0, 3), null);
  for (const s of ['Converted', 'Not Interested', 'Do Not Contact', 'Invalid Contact']) assert.equal(canFollowUp(s), false);
  assert.equal(canFollowUp('Contacted'), true);
});
test('website classification is cautious', () => {
  assert.equal(classify({ url: '' }).status, 'NO_WEBSITE');
  assert.equal(classify({ url: 'a.com', error: 'AbortError' }).status, 'UNCERTAIN');
  assert.equal(classify({ url: 'a.com', status: 403 }).status, 'UNCERTAIN');
  assert.equal(classify({ url: 'a.com', status: 503 }).status, 'UNCERTAIN');
  assert.equal(classify({ url: 'a.com', status: 404 }).status, 'BROKEN_WEBSITE');
  assert.equal(classify({ url: 'a.com', dnsError: 'ENOTFOUND' }).status, 'BROKEN_WEBSITE');
  assert.equal(classify({ url: 'a.com', dnsError: 'EAI_AGAIN' }).status, 'UNCERTAIN');
  assert.equal(classify({ url: 'a.com', status: 200, body: '<h1>This domain is for sale</h1>' }).status, 'PARKED_DOMAIN');
  assert.equal(classify({ url: 'a.com', status: 200, body: 'hello' }).status, 'WORKING_WEBSITE');
});
test('SSRF guard', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0']) assert.equal(isBlockedIp(ip), true, ip);
  assert.equal(isBlockedIp('8.8.8.8'), false);
  for (const u of ['http://localhost/', 'http://127.0.0.1/', 'http://169.254.169.254/latest', 'file:///etc/passwd', 'http://example.com:8080/', 'http://user:pw@example.com/', 'http://[::1]/'])
    await assert.rejects(() => assertSafeUrl(u), undefined, u);
});
test('encryption round trip', () => {
  const c = encrypt('secret-key'); assert.notEqual(c, 'secret-key'); assert.equal(decrypt(c), 'secret-key');
});
