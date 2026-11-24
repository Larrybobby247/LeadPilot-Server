// Fills {{placeholders}} in a template's HTML safely, then rebuilds the ZIP with every other file copied byte-for-byte.
import { readZip, writeZip, ZipError, BLOCKED_EXT } from './zip.js';
const PH = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const URL_ATTR = new Set(['href', 'src', 'action', 'formaction', 'poster', 'cite', 'data', 'background', 'xlink:href']);
const SKIP_ATTR = (n) => /^on/i.test(n) || n === 'style' || n === 'srcset'; // script / CSS contexts are never filled
const OK_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'sms']);
export const isHtml = (name) => /\.html?$/i.test(name);
export function findPlaceholders(html, into = new Map()) { for (const m of html.matchAll(PH)) into.set(m[1], (into.get(m[1]) || 0) + 1); return into; }
export const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const decodeBasic = (s) => s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function urlOk(value) { const v = decodeBasic(value).replace(/[\u0000-\u0020]+/g, ''); const m = /^([a-z][a-z0-9+.-]*):/i.exec(v); return !m || OK_SCHEMES.has(m[1].toLowerCase()); }

function readTag(html, i) { let j = i + 1, q = null; for (; j < html.length; j++) { const c = html[j]; if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') break; } return { tag: html.slice(i, j + 1), end: j + 1 }; }
export function renderHtml(html, resolve, report) {
  const missing = (name) => report.unfilled.add(name);
  const fillText = (s) => s.replace(PH, (m, name) => { const r = resolve(name); if (!r) { missing(name); return m; } return escapeHtml(r.text); });
  const fillAttr = (aname, value, raw) => {
    if (!PH.test(value)) { PH.lastIndex = 0; return null; } PH.lastIndex = 0; const isUrl = URL_ATTR.has(aname); let ok = true;
    const out = value.replace(PH, (m, name, offset) => {
      const r = resolve(name); if (!r) { missing(name); return m; } let v = r.text;
      if (isUrl) {
        if (r.kind === 'url') { if (offset === 0) { v = r.text; } else v = encodeURIComponent(r.text); }
        else if (r.kind === 'phone') v = r.text.replace(/[^\d+]/g, ''); else if (r.kind === 'digits' || r.kind === 'email') v = r.text;
        else if (offset === 0) { report.warnings.push(`"${name}" cannot start a link, so it was left unchanged.`); ok = false; return m; } else v = encodeURIComponent(r.text);
      }
      return escapeHtml(v);
    });
    if (!ok || (isUrl && !urlOk(out))) { if (isUrl && !urlOk(out)) report.warnings.push(`A link was left unchanged because the filled value was not a safe web address.`); return null; }
    return out === value ? null : out;
  };
  const fillTag = (tag) => tag.replace(/([^\s"'<>\/=]+)(\s*=\s*)("([^"]*)"|'([^']*)'|[^\s"'=<>`]+)/g, (all, name, eq, raw, dq, sq) => {
    const aname = name.toLowerCase(); if (SKIP_ATTR(aname)) return all; const value = dq ?? sq ?? raw; const out = fillAttr(aname, value, raw); if (out === null) return all; return `${name}${eq}"${out}"`;
  });
  let out = '', i = 0; const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i); if (lt < 0) { out += fillText(html.slice(i)); break; }
    out += fillText(html.slice(i, lt)); i = lt;
    if (html.startsWith('<!--', i)) { const e = html.indexOf('-->', i + 4); const end = e < 0 ? n : e + 3; out += html.slice(i, end); i = end; continue; }
    if (/^<[a-zA-Z]/.test(html.slice(i, i + 2))) {
      const { tag, end } = readTag(html, i); out += fillTag(tag); i = end; const name = /^<([a-zA-Z0-9-]+)/.exec(tag)[1].toLowerCase();
      if ((name === 'script' || name === 'style') && !tag.endsWith('/>')) {
        const re = new RegExp(`</${name}[\\s/>]`, 'ig'); re.lastIndex = i; const m = re.exec(html); const stop = m ? m.index : n; const body = html.slice(i, stop);
        if (name === 'script' && /type\s*=\s*["']?application\/ld\+json/i.test(tag)) out += body.replace(PH, (mm, p) => { const r = resolve(p); if (!r) { missing(p); return mm; } return JSON.stringify(r.text).slice(1, -1).replace(/</g, '\\u003c'); });
        else { if (PH.test(body)) report.warnings.push(`Placeholders inside <${name}> are not filled.`); PH.lastIndex = 0; out += body; }
        i = stop;
      }
      continue;
    }
    if (/^<[\/!?]/.test(html.slice(i, i + 2))) { const gt = html.indexOf('>', i); const end = gt < 0 ? n : gt + 1; out += html.slice(i, end); i = end; continue; }
    out += '<'; i += 1; // a stray "<" in text
  }
  return out;
}
export const sitePrefix = (zip) => PREFIX(zip);
const PREFIX = (zip) => { const names = zip.entries.map((e) => e.name); if (!names.length) return ''; const first = names[0].split('/')[0] + '/'; return names.every((x) => x.startsWith(first)) ? first : ''; };
// Which file does a preview request mean? Handles a single top-level folder, "/" and folder paths. Returns null for anything unsafe or missing.
export function resolveEntry(zip, rel) {
  const base = sitePrefix(zip); let r = String(rel || ''); if (r.includes('\0') || r.replace(/\\/g, '/').split('/').includes('..')) return null; const bare = !r; if (!r || r.endsWith('/')) r += 'index.html';
  const hit = zip.get(base + r) || zip.get(base + r.replace(/\/?$/, '/index.html')) || (bare ? zip.get(entryPoint(zip)) : null); return hit && !hit.isDir ? hit : null;
}
export function entryPoint(zip) { const base = PREFIX(zip); const html = zip.entries.filter((e) => !e.isDir && isHtml(e.name)); return (html.find((e) => e.name === base + 'index.html') || html.find((e) => /(^|\/)index\.html?$/i.test(e.name)) || html[0])?.name || null; }

// Validates an uploaded template and lists its placeholders. Throws ZipError with a friendly message.
export function analyseTemplate(buf, limits) {
  const zip = readZip(buf, limits); const files = zip.entries.filter((e) => !e.isDir);
  if (!files.length) throw new ZipError('The ZIP is empty.'); const bad = files.find((e) => BLOCKED_EXT.test(e.name)); if (bad) throw new ZipError(`"${bad.name}" is a program or server script, which is not allowed in a website template.`);
  const htmlFiles = files.filter((e) => isHtml(e.name)); if (!htmlFiles.length) throw new ZipError('The template has no HTML files.');
  const found = new Map(), where = {}; for (const f of htmlFiles) { const m = findPlaceholders(zip.read(f).toString('utf8')); for (const [name, c] of m) { found.set(name, (found.get(name) || 0) + c); (where[name] ||= []).push(f.name); } }
  return { fileCount: files.length, htmlFiles: htmlFiles.map((f) => f.name), entry: entryPoint(zip), totalBytes: files.reduce((a, f) => a + f.usize, 0), placeholders: [...found].map(([name, count]) => ({ name, count, files: where[name] })) };
}
// Personalise every HTML file; copy everything else untouched (same compressed bytes, same paths, same folder layout).
export function renderSite(buf, resolve, limits) {
  const zip = readZip(buf, limits); const report = { unfilled: new Set(), warnings: [] }; const out = []; let processed = 0;
  for (const en of zip.entries) {
    if (en.isDir) { out.push({ name: en.name }); continue; }
    if (isHtml(en.name)) { const html = zip.read(en).toString('utf8'); const local = { unfilled: new Set(), warnings: [] }; out.push({ name: en.name, data: Buffer.from(renderHtml(html, resolve, local), 'utf8') }); local.unfilled.forEach((x) => report.unfilled.add(x)); for (const w of local.warnings) if (!report.warnings.includes(w)) report.warnings.push(w); processed++; }
    else out.push({ name: en.name, pre: { method: en.method, crc: en.crc, csize: en.csize, usize: en.usize, raw: zip.raw(en), time: en.time, date: en.date } });
  }
  return { zip: writeZip(out), unfilled: [...report.unfilled], warnings: report.warnings, htmlProcessed: processed };
}
