// Where template and generated ZIPs live. Default: MongoDB GridFS (persistent on Atlas, no extra service). Optional: a disk folder (needs a persistent disk on Render).
// Callers only ever hold opaque ids; storage paths are never exposed.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

const diskPath = (id) => { if (!/^[a-f0-9]{32}$/.test(String(id))) throw new Error('bad id'); return path.join(config.storageDir, id); };
const disk = {
  async put(buf) { const id = crypto.randomBytes(16).toString('hex'); await fs.mkdir(config.storageDir, { recursive: true }); await fs.writeFile(diskPath(id), buf, { mode: 0o600 }); return id; },
  async get(id) { return fs.readFile(diskPath(id)); },
  async remove(id) { if (id) await fs.rm(diskPath(id), { force: true }); },
};
let bucket; async function grid() { if (bucket) return bucket; const { default: mongoose } = await import('mongoose'); bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'websiteFiles' }); return bucket; }
const gridfs = {
  async put(buf, name = 'file.zip') { const b = await grid(); return new Promise((res, rej) => { const s = b.openUploadStream(name); s.on('error', rej); s.on('finish', () => res(String(s.id))); s.end(buf); }); },
  async get(id) { const b = await grid(); const { default: mongoose } = await import('mongoose'); const chunks = []; for await (const c of b.openDownloadStream(new mongoose.Types.ObjectId(String(id)))) chunks.push(c); return Buffer.concat(chunks); },
  async remove(id) { if (!id) return; const b = await grid(); const { default: mongoose } = await import('mongoose'); try { await b.delete(new mongoose.Types.ObjectId(String(id))); } catch { /* already gone */ } },
};
const driver = () => (config.storageDriver === 'disk' ? disk : gridfs);
export const storage = { put: (b, n) => driver().put(b, n), get: (id) => driver().get(id), remove: (id) => driver().remove(id) };
// Small in-memory cache of parsed ZIPs so a preview page with many assets does not re-read storage for each file.
const cache = new Map(); let cached = 0; const CAP = 80 * 1048576;
export async function cachedBuffer(id) { if (cache.has(id)) { const v = cache.get(id); cache.delete(id); cache.set(id, v); return v; } const buf = await storage.get(id); if (buf.length < CAP / 2) { cache.set(id, buf); cached += buf.length; while (cached > CAP) { const [k, v] = cache.entries().next().value; cache.delete(k); cached -= v.length; } } return buf; }
