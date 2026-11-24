import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { readZip, writeZip, ZipError, crc32 } from '../src/services/zip.js';
import { analyseTemplate, renderSite, renderHtml, entryPoint, escapeHtml } from '../src/services/websiteRender.js';
import { leadValues, makeResolver, suggestField, categoryKey, safeUrl, dataHash, FIELD_KEYS } from '../src/services/websiteFields.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(3000)]);
const FONT = crypto.randomBytes(5000);
const restaurant = () => writeZip([
  { name: 'tasty/' }, { name: 'tasty/css/' },
  { name: 'tasty/index.html', data: `<!doctype html><html><head><title>{{business_name}} | {{city}}</title><link rel="stylesheet" href="css/style.css"><script src="js/app.js"></script>
<script type="application/ld+json">{"@type":"Restaurant","name":"{{business_name}}","telephone":"{{phone}}"}</script><script>var shop="{{business_name}}";</script></head><body>
<nav><a href="menu.html">Menu</a> <a href="contact.html">Contact</a></nav><img src="images/logo.png" alt="{{business_name}} logo"><h1>Welcome to {{ business_name }}</h1><p>{{business_description}}</p>
<a class="wa" href="https://wa.me/{{whatsapp_digits}}">Chat</a> <a href="tel:{{phone_digits}}">Call {{phone}}</a> <a href="mailto:{{email}}">Email</a> <a href="{{website_url}}">Old site</a>
<a href="https://maps.google.com/?q={{address}}">Map</a> <a href="{{contact_person}}">x</a><!-- {{business_name}} --><button onclick="alert('{{business_name}}')">go</button><p style="color:red" data-x={{city}}>{{city}}, {{state}}</p><p>{{unknown_thing}}</p></body></html>` },
  { name: 'tasty/menu.html', data: '<html><body><a href="index.html">Home</a><h1>Menu at {{business_name}}</h1></body></html>' },
  { name: 'tasty/contact.html', data: '<html><body>{{business_name}} - {{address}} - {{phone}}</body></html>' },
  { name: 'tasty/css/style.css', data: 'body{font-family:"Brand";background:url(../images/logo.png)} /* {{business_name}} */' },
  { name: 'tasty/js/app.js', data: 'console.log("{{business_name}}");' }, { name: 'tasty/images/logo.png', data: PNG }, { name: 'tasty/fonts/brand.woff2', data: FONT },
]);
const lead = { whatsappNumber: '0803 123 4567', contactPerson: null };
const biz = { name: 'Mama Put <Kitchen> & "Grill"', category: 'Restaurants', description: 'Home-style food.', phones: ['2348031234567'], emails: ['hello@mamaput.ng'], address: '12 Bodija Rd & Co', city: 'Ibadan', state: 'Oyo', website: 'mamaput.ng', instagram: 'javascript:alert(1)' };
const mappings = { business_name: { field: 'business_name' }, business_description: { field: 'business_description' }, phone: { field: 'phone' }, phone_digits: { field: 'phone_digits' }, whatsapp_digits: { field: 'whatsapp_digits' }, email: { field: 'email' }, website_url: { field: 'website_url' }, address: { field: 'address' }, city: { field: 'city' }, state: { field: 'state' }, contact_person: { field: 'contact_person' }, unknown_thing: { field: 'none' } };

test('ZIP round trip and pass-through are byte exact', () => {
  const z = readZip(restaurant()); assert.ok(z.read(z.get('tasty/images/logo.png')).equals(PNG)); assert.ok(z.read(z.get('tasty/fonts/brand.woff2')).equals(FONT)); assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});
test('template analysis finds placeholders in every HTML file', () => {
  const a = analyseTemplate(restaurant()); assert.equal(a.htmlFiles.length, 3); assert.equal(a.entry, 'tasty/index.html'); const n = Object.fromEntries(a.placeholders.map((p) => [p.name, p]));
  assert.ok(n.business_name.count >= 8 && n.business_name.files.length === 3); assert.ok(n.unknown_thing && n.whatsapp_digits && n.contact_person); assert.equal(n.business_name.files.includes('tasty/css/style.css'), false);
});
test('rendering: fills text, attributes and JSON-LD safely, leaves the rest alone', () => {
  const r = renderSite(restaurant(), makeResolver(leadValues(lead, biz), mappings)); const z = readZip(r.zip); const idx = z.read(z.get('tasty/index.html')).toString();
  assert.match(idx, /<title>Mama Put &lt;Kitchen&gt; &amp; &quot;Grill&quot; \| Ibadan<\/title>/); assert.match(idx, /<h1>Welcome to Mama Put &lt;Kitchen&gt;/); assert.match(idx, /alt="Mama Put &lt;Kitchen&gt; &amp; &quot;Grill&quot; logo"/);
  assert.match(idx, /href="https:\/\/wa\.me\/2348031234567"/); assert.match(idx, /href="tel:2348031234567"/); assert.match(idx, /Call \+234 803 123 4567/); assert.match(idx, /href="mailto:hello@mamaput\.ng"/); assert.match(idx, /<a href="https:\/\/mamaput\.ng\/">Old site/);
  assert.match(idx, /maps\.google\.com\/\?q=12%20Bodija%20Rd%20%26%20Co"/); assert.ok(idx.includes(String.raw`"name":"Mama Put \u003cKitchen> & \"Grill\""`), 'JSON-LD value is JSON-escaped and cannot close the script tag'); assert.ok(idx.includes('var shop="{{business_name}}"'), 'plain scripts are never filled');
  assert.match(idx, /<!-- \{\{business_name\}\} -->/); assert.match(idx, /onclick="alert\('\{\{business_name\}\}'\)"/); assert.match(idx, /style="color:red"/); assert.match(idx, /data-x="Ibadan"/); assert.match(idx, /<p>\{\{unknown_thing\}\}<\/p>/);
  assert.match(idx, /<a href="\{\{contact_person\}\}">x<\/a>/); assert.ok(!idx.includes('<Kitchen>') && !idx.includes('<script>alert'));
  assert.deepEqual(r.unfilled.sort(), ['contact_person', 'unknown_thing']); assert.ok(r.warnings.some((w) => /Placeholders inside <script>/.test(w)), 'placeholders in <script> are reported, not filled');
});
test('everything else is preserved: assets byte-for-byte, css/js untouched, paths and navigation intact', () => {
  const orig = readZip(restaurant()); const r = readZip(renderSite(restaurant(), makeResolver(leadValues(lead, biz), mappings)).zip);
  assert.deepEqual(r.entries.map((e) => e.name), orig.entries.map((e) => e.name)); for (const n of ['tasty/images/logo.png', 'tasty/fonts/brand.woff2', 'tasty/css/style.css', 'tasty/js/app.js']) assert.ok(r.read(r.get(n)).equals(orig.read(orig.get(n))), n);
  const menu = r.read(r.get('tasty/menu.html')).toString(); assert.match(menu, /href="index\.html"/); assert.match(menu, /Menu at Mama Put &lt;Kitchen&gt;/); assert.ok(r.get('tasty/css/') && r.get('tasty/index.html'));
  assert.equal(readZip(restaurant()).read(readZip(restaurant()).get('tasty/index.html')).toString().includes('{{business_name}}'), true, 'the original is not modified');
});
test('XSS and unsafe URLs never reach the page', () => {
  const evil = { name: '"><script>alert(1)</script>', website: 'javascript:alert(1)', emails: ['a@b.co'], phones: [] }; const v = leadValues({}, evil);
  assert.equal(v.website_url, null); const res = makeResolver({ ...v, website_url: 'javascript:alert(1)' }, { n: { field: 'business_name' }, w: { field: 'website_url' } });
  const out = renderHtml('<a title="{{n}}" href="{{w}}">{{n}}</a><img src={{n}}>', res, { unfilled: new Set(), warnings: [] }); assert.ok(!out.includes('<script>')); assert.ok(!/javascript:/i.test(out) || out.includes('{{w}}'));
  const direct = renderHtml('<a href="{{w}}">x</a>', (name) => ({ text: 'javascript:alert(1)', kind: 'url' }), { unfilled: new Set(), warnings: [] }); assert.match(direct, /href="\{\{w\}\}"/);
  const dataUrl = renderHtml('<a href="{{w}}">x</a>', () => ({ text: 'data:text/html,<script>', kind: 'text' }), { unfilled: new Set(), warnings: [] }); assert.ok(!dataUrl.includes('data:text/html'));
  assert.equal(safeUrl('https://ok.com/a?b=1'), 'https://ok.com/a?b=1'); assert.equal(safeUrl('ftp://x.com'), null); assert.equal(safeUrl('https://u:p@x.com'), null); assert.equal(safeUrl('x'), null); assert.equal(escapeHtml(`<&>"'`), '&lt;&amp;&gt;&quot;&#39;');
});
test('missing data is never invented; defaults are used only when configured', () => {
  const v = leadValues({}, { name: 'X', phones: [] }); assert.equal(v.phone, null); assert.equal(v.whatsapp, null); assert.equal(v.email, null); assert.equal(v.address, null);
  assert.equal(leadValues({ whatsappNumber: '' }, { name: 'X', phones: ['2348031234567'] }).whatsapp_digits, null, 'WhatsApp is never guessed from the phone number');
  const rep = { unfilled: new Set(), warnings: [] }; const out = renderHtml('<p>{{a}} {{b}}</p>', makeResolver(v, { a: { field: 'phone', default: 'Call us' }, b: { field: 'phone' } }), rep); assert.equal(out, '<p>Call us {{b}}</p>'); assert.deepEqual([...rep.unfilled], ['b']);
});
test('suggested mappings and category matching', () => {
  assert.equal(suggestField('business_name'), 'business_name'); assert.equal(suggestField('whatsapp_number'), 'whatsapp'); assert.equal(suggestField('Phone_Number'), 'phone'); assert.equal(suggestField('weird'), null); assert.ok(FIELD_KEYS.includes('business_description'));
  assert.equal(categoryKey('Restaurants'), categoryKey('restaurant ')); assert.equal(categoryKey('Construction companies'), categoryKey('Construction Company')); assert.notEqual(categoryKey('Hotels'), categoryKey('Schools'));
});
test('data hash changes when information or mappings change', () => {
  const a = dataHash(leadValues(lead, biz), mappings, 1); assert.equal(a, dataHash(leadValues(lead, biz), mappings, 1)); assert.notEqual(a, dataHash(leadValues(lead, { ...biz, city: 'Lagos' }), mappings, 1)); assert.notEqual(a, dataHash(leadValues(lead, biz), mappings, 2));
});
const bad = (entries, opts) => assert.throws(() => readZip(writeZip(entries), opts), ZipError);
test('ZIP security: traversal, absolute paths, bombs, lying sizes, corruption, junk', () => {
  bad([{ name: '../evil.html', data: 'x' }]); bad([{ name: 'a/../../evil.html', data: 'x' }]); bad([{ name: '/etc/passwd', data: 'x' }]); bad([{ name: 'C:\\win\\x.html', data: 'x' }]); bad([{ name: '..\\evil.html', data: 'x' }]);
  bad([{ name: 'a.html', data: 'x' }, { name: 'A.html', data: 'y' }]); bad([{ name: 'a', data: 'x' }, { name: 'b', data: 'x' }, { name: 'c', data: 'x' }], { maxEntries: 2 });
  bad([{ name: 'big.txt', data: Buffer.alloc(5000, 1) }], { maxFile: 1000 }); bad([{ name: 'a.txt', data: Buffer.alloc(900, 1) }, { name: 'b.txt', data: Buffer.alloc(900, 1) }], { maxTotal: 1500 });
  const real = Buffer.alloc(100000, 7); const def = zlib.deflateRawSync(real); const lying = writeZip([{ name: 'bomb.txt', pre: { method: 8, crc: crc32(real), csize: def.length, usize: 10, raw: def } }]); const z = readZip(lying); assert.throws(() => z.read(z.get('bomb.txt')), ZipError);
  const wrongCrc = writeZip([{ name: 'a.txt', pre: { method: 0, crc: 123, csize: 1, usize: 1, raw: Buffer.from('x') } }]); const w = readZip(wrongCrc); assert.throws(() => w.read(w.get('a.txt')), ZipError);
  assert.throws(() => readZip(Buffer.from('not a zip at all, definitely not a zip')), ZipError); assert.throws(() => readZip(Buffer.alloc(10)), ZipError);
  const sym = writeZip([{ name: 'link', data: 'x' }]); const idx = sym.indexOf(Buffer.from([0x50, 0x4b, 1, 2])); sym.writeUInt32LE(0xa1ff0000, idx + 38); assert.throws(() => readZip(sym), /Symbolic/);
  const enc = writeZip([{ name: 'a.txt', data: 'x' }]); const ci = enc.indexOf(Buffer.from([0x50, 0x4b, 1, 2])); enc.writeUInt16LE(1, ci + 8); assert.throws(() => readZip(enc), /Encrypted/);
});
test('template validation: needs HTML, no server scripts or programs, junk files ignored', () => {
  assert.throws(() => analyseTemplate(writeZip([{ name: 'a.css', data: 'x' }])), /no HTML/); assert.throws(() => analyseTemplate(writeZip([{ name: 'index.html', data: '<p></p>' }, { name: 'send.php', data: '<?php' }])), /not allowed/); assert.throws(() => analyseTemplate(writeZip([{ name: 'index.html', data: '<p></p>' }, { name: 'setup.exe', data: 'MZ' }])), /not allowed/);
  const ok = analyseTemplate(writeZip([{ name: '__MACOSX/._index.html', data: 'junk' }, { name: '.DS_Store', data: 'junk' }, { name: 'index.html', data: '<p>{{business_name}}</p>' }])); assert.equal(ok.fileCount, 1);
  assert.equal(entryPoint(readZip(writeZip([{ name: 'site/about.html', data: 'a' }, { name: 'site/index.html', data: 'b' }]))), 'site/index.html');
});
test('disk storage: round trip, opaque ids, no path tricks', async () => {
  const dir = await fs.mkdtemp(os.tmpdir() + '/lp-'); process.env.STORAGE_DRIVER = 'disk'; const { config } = await import('../src/config.js'); config.storageDriver = 'disk'; config.storageDir = dir; const { storage } = await import('../src/services/websiteStorage.js');
  const id = await storage.put(Buffer.from('zipdata')); assert.match(id, /^[a-f0-9]{32}$/); assert.equal((await storage.get(id)).toString(), 'zipdata'); await assert.rejects(() => storage.get('../../etc/passwd')); await storage.remove(id); await assert.rejects(() => storage.get(id)); await fs.rm(dir, { recursive: true });
});

import { resolveEntry } from '../src/services/websiteRender.js';
test('preview path resolution: top folder, defaults, nested files, traversal', () => {
  const z = readZip(restaurant()); assert.equal(resolveEntry(z, '').name, 'tasty/index.html'); assert.equal(resolveEntry(z, 'menu.html').name, 'tasty/menu.html'); assert.equal(resolveEntry(z, 'css/style.css').name, 'tasty/css/style.css'); assert.equal(resolveEntry(z, 'images/logo.png').name, 'tasty/images/logo.png');
  assert.equal(resolveEntry(z, 'nope.html'), null); assert.equal(resolveEntry(z, '../secret'), null); assert.equal(resolveEntry(z, 'css/../../x'), null); assert.equal(resolveEntry(z, '..\\x'), null); assert.equal(resolveEntry(z, 'css/'), null);
  const flat = readZip(writeZip([{ name: 'index.html', data: 'a' }, { name: 'sub/index.html', data: 'b' }, { name: 'sub/p.html', data: 'c' }])); assert.equal(resolveEntry(flat, 'sub/').name, 'sub/index.html'); assert.equal(resolveEntry(flat, 'sub').name, 'sub/index.html'); assert.equal(resolveEntry(flat, '').name, 'index.html');
});

import { existsSync } from 'node:fs';
test('a ZIP built by the browser helper is read correctly by the server', async (t) => {
  const p = new URL('../../frontend/src/utils/zipClient.js', import.meta.url); if (!existsSync(p)) return t.skip('frontend not next to backend');
  const { buildZip } = await import(p.href); const enc = new TextEncoder(); const bin = new Uint8Array([137, 80, 78, 71, 0, 255, 254]);
  const z = readZip(Buffer.from(buildZip([{ path: 'site/index.html', bytes: enc.encode('<p>{{business_name}}</p>') }, { path: 'site/a.png', bytes: bin }])));
  assert.deepEqual(z.entries.map((e) => e.name), ['site/index.html', 'site/a.png']); assert.ok(Buffer.from(z.read(z.get('site/a.png'))).equals(Buffer.from(bin)));
});
