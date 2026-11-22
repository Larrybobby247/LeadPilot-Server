import test from 'node:test';
import assert from 'node:assert/strict';
import { waLinks, waUrl } from '../src/services/phone.js';
test('WhatsApp and WhatsApp Business links', () => {
  const l = waLinks('0803 123 4567', 'Hi & welcome 👋');
  assert.equal(l.standard, waUrl('08031234567', 'Hi & welcome 👋')); assert.match(l.standard, /^https:\/\/wa\.me\/2348031234567\?text=Hi%20%26%20welcome/);
  assert.match(l.web, /^https:\/\/web\.whatsapp\.com\/send\?phone=2348031234567&text=/);
  assert.match(l.androidBusiness, /^intent:\/\/send\?phone=2348031234567&text=.*package=com\.whatsapp\.w4b;S\.browser_fallback_url=https%3A%2F%2Fwa\.me%2F2348031234567/); assert.match(l.androidBusiness, /;end$/);
  assert.equal(waLinks('abc', 'x'), null);
});
