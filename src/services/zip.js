// Minimal, strict ZIP reader/writer on node:zlib (no dependencies). Reader rejects anything unsafe instead of trying to repair it.
import zlib from 'node:zlib';
export class ZipError extends Error { constructor(message) { super(message); this.name = 'ZipError'; } }
const MB = 1048576;
const TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
const SKIP = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$)/;
export const BLOCKED_EXT = /\.(exe|dll|bat|cmd|com|msi|scr|sh|ps1|jar|php|phtml|asp|aspx|jsp|cgi|pl|py|rb)$/i;

function safeName(raw) {
  let n = String(raw).replace(/\\/g, '/'); if (n.includes('\0') || n.startsWith('/') || /^[a-zA-Z]:/.test(n)) throw new ZipError(`Unsafe file path in ZIP: ${raw}`);
  n = n.replace(/^(\.\/)+/, ''); if (n.split('/').some((s) => s === '..')) throw new ZipError(`Unsafe file path in ZIP: ${raw}`); return n;
}
export function readZip(buf, { maxEntries = 2000, maxFile = 25 * MB, maxTotal = 100 * MB } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50 && buf.readUInt32LE(0) !== 0x06054b50) throw new ZipError('This is not a valid ZIP file.');
  let e = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new ZipError('This is not a valid ZIP file.');
  const total = buf.readUInt16LE(e + 10), cdSize = buf.readUInt32LE(e + 12), cdOff = buf.readUInt32LE(e + 16);
  if (total === 0xffff || cdOff === 0xffffffff) throw new ZipError('ZIP64 archives are not supported.'); if (total > maxEntries) throw new ZipError(`The ZIP has more than ${maxEntries} files.`); if (cdOff + cdSize > buf.length) throw new ZipError('The ZIP is damaged.');
  const entries = [], seen = new Set(); let p = cdOff, sum = 0;
  for (let k = 0; k < total; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError('The ZIP is damaged.');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), time = buf.readUInt16LE(p + 12), date = buf.readUInt16LE(p + 14), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), ext = buf.readUInt32LE(p + 38), lho = buf.readUInt32LE(p + 42);
    const rawName = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nlen); p += 46 + nlen + elen + clen;
    if (SKIP.test(rawName.replace(/\\/g, '/'))) continue; const name = safeName(rawName);
    if (flags & 1) throw new ZipError('Encrypted ZIPs are not supported.'); if (method !== 0 && method !== 8) throw new ZipError('The ZIP uses an unsupported compression method.');
    if (((ext >>> 16) & 0xf000) === 0xa000) throw new ZipError('Symbolic links are not allowed in a ZIP.');
    if (usize > maxFile) throw new ZipError(`"${name}" is larger than the ${Math.round(maxFile / MB)} MB limit per file.`); sum += usize; if (sum > maxTotal) throw new ZipError(`The ZIP expands to more than ${Math.round(maxTotal / MB)} MB.`);
    const key = name.toLowerCase(); if (seen.has(key)) throw new ZipError(`The ZIP contains "${name}" twice.`); seen.add(key);
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw new ZipError('The ZIP is damaged.'); const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28); if (dataStart + csize > buf.length) throw new ZipError('The ZIP is damaged.');
    entries.push({ name, isDir: name.endsWith('/'), method, crc, csize, usize, time, date, dataStart });
  }
  const byName = new Map(entries.map((x) => [x.name, x]));
  const raw = (en) => buf.subarray(en.dataStart, en.dataStart + en.csize);
  // Inflate with a hard output cap equal to the declared size, then verify size and CRC (a lying header is rejected, not trusted).
  const read = (en) => { if (en.isDir) return Buffer.alloc(0); let d; try { d = en.method === 0 ? raw(en) : zlib.inflateRawSync(raw(en), { maxOutputLength: Math.max(en.usize, 1) }); } catch { throw new ZipError(`"${en.name}" is corrupt or larger than it claims.`); }
    if (d.length !== en.usize || crc32(d) !== en.crc) throw new ZipError(`"${en.name}" is corrupt.`); return d; };
  return { entries, get: (name) => byName.get(name), has: (name) => byName.has(name), read, raw };
}
const dosNow = () => { const d = new Date(); return { date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(), time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1) }; };
// entries: { name, data } to compress, or { name, pre } to copy an existing entry's compressed bytes untouched.
export function writeZip(entries) {
  const parts = [], central = []; let offset = 0; const now = dosNow();
  for (const en of entries) {
    const name = Buffer.from(en.name, 'utf8'); let method, crc, csize, usize, raw, time = now.time, date = now.date;
    if (en.pre) ({ method, crc, csize, usize, raw, time = now.time, date = now.date } = en.pre);
    else if (en.name.endsWith('/')) { method = 0; crc = 0; csize = 0; usize = 0; raw = Buffer.alloc(0); }
    else { const data = Buffer.from(en.data); usize = data.length; crc = crc32(data); const def = zlib.deflateRawSync(data, { level: 6 }); if (def.length < usize) { method = 8; raw = def; } else { method = 0; raw = data; } csize = raw.length; }
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8); lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt32LE(crc >>> 0, 14); lh.writeUInt32LE(csize, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10); ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14); ch.writeUInt32LE(crc >>> 0, 16); ch.writeUInt32LE(csize, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(en.name.endsWith('/') ? 0x41ed0010 : 0x81a40000, 38); ch.writeUInt32LE(offset, 42);
    parts.push(lh, name, raw); central.push(Buffer.concat([ch, name])); offset += 30 + name.length + raw.length;
  }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
