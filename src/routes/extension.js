import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { DEPARTMENTS } from '../config.js';
import { ExtensionConnection, PairingCode, ImportJob } from '../models/index.js';
import { HttpError, wrap, requireAuth, requireExtension, hasDept } from '../middleware/auth.js';
import { pairingCode, randomToken, sha256 } from '../utils/crypto.js';
import { importRecords } from '../services/importer.js';
import { recordSchema } from './leads.js';
import { log, notify } from '../services/activity.js';

const r = Router(); const lim = rateLimit({ windowMs: 10 * 60 * 1000, limit: 15, message: { message: 'Too many attempts. Try again later.' } });
const depts = (u) => (u.role === 'owner' ? DEPARTMENTS : u.departments);

// Web app (signed-in user): mint a short-lived, single-use pairing code
r.post('/pair', requireAuth, wrap(async (req, res) => {
  await PairingCode.deleteMany({ user: req.user._id, usedAt: null }); const code = pairingCode();
  await PairingCode.create({ user: req.user._id, codeHash: sha256(code), expiresAt: new Date(Date.now() + 10 * 60e3) }); res.json({ code, expiresInSeconds: 600 });
}));
// Extension: exchange the code for a scoped, revocable token. Passwords are never involved.
r.post('/connect', lim, wrap(async (req, res) => {
  const { code, label } = z.object({ code: z.string().regex(/^[A-Za-z0-9]{8}$/), label: z.string().max(60).optional() }).parse(req.body);
  const pc = await PairingCode.findOneAndUpdate({ codeHash: sha256(code.toUpperCase()), usedAt: null, expiresAt: { $gt: new Date() } }, { usedAt: new Date() }); // atomic: single use
  if (!pc) throw new HttpError(400, 'Invalid or expired code');
  const user = await (await import('../models/index.js')).User.findById(pc.user); if (!user?.active) throw new HttpError(400, 'Invalid or expired code');
  const token = randomToken(32); await ExtensionConnection.create({ user: user._id, tokenHash: sha256(token), label: label || 'Chrome' });
  await log({ user, ip: req.ip }, 'extension.connected', 'User', user._id); await notify(user._id, 'extension_connected', 'Chrome extension connected', undefined, '/extension'); res.json({ token, departments: depts(user) });
}));
r.get('/status', requireExtension, (req, res) => res.json({ connected: true, connectedAt: req.conn.connectedAt, departments: depts(req.user), user: { name: req.user.name } }));
r.post('/import', requireExtension, wrap(async (req, res) => {
  const b = z.object({ department: z.enum(DEPARTMENTS), source: z.string().max(40).default('google_search'), query: z.string().max(300).optional(), sourceUrl: z.string().max(1000).optional(), records: z.array(recordSchema).min(1).max(200) }).parse(req.body);
  if (!hasDept(req.user, b.department)) throw new HttpError(403, 'You do not have access to this workspace');
  const job = await ImportJob.create({ user: req.user._id, department: b.department, source: b.source, method: 'chrome_extension', query: b.query, sourceUrl: b.sourceUrl, counts: { collected: b.records.length } });
  const out = await importRecords({ user: req.user, department: b.department, records: b.records, source: 'chrome_extension', method: 'chrome_extension', query: b.query, sourceUrl: b.sourceUrl, jobId: job._id });
  job.counts = { collected: b.records.length, imported: out.imported.length, duplicates: out.duplicates.length + out.potential.length + out.taken.length, rejected: out.rejected.length, review: out.review.length }; job.status = out.imported.length + out.review.length ? (out.rejected.length ? 'Partial' : 'Completed') : 'Failed'; await job.save();
  if (job.counts.duplicates) await log(req, 'duplicate.prevented', 'ImportJob', job._id, { count: job.counts.duplicates, via: 'extension' }, b.department);
  await log(req, 'lead.imported', 'ImportJob', job._id, { ...job.counts, via: 'extension' }, b.department); await notify(req.user._id, 'import_completed', `Extension import: ${out.imported.length} added`, undefined, '/extension/history');
  res.json({ jobId: job._id, imported: out.imported.length, duplicates: out.duplicates.length + out.potential.length + out.taken.length, rejected: out.rejected.length, review: out.review.length, details: out });
}));
r.get('/history', requireExtension, wrap(async (req, res) => { const jobs = await ImportJob.find({ user: req.user._id, method: 'chrome_extension' }).sort('-createdAt').limit(20);
  res.json({ items: jobs.map((j) => ({ id: j._id, date: j.createdAt, source: j.source, query: j.query, department: j.department, collected: j.counts.collected, imported: j.counts.imported, duplicates: j.counts.duplicates, status: j.status })) }); }));
r.post('/disconnect', requireExtension, wrap(async (req, res) => { req.conn.revokedAt = new Date(); await req.conn.save(); await log(req, 'extension.disconnected', 'User', req.user._id); await notify(req.user._id, 'extension_disconnected', 'Chrome extension disconnected'); res.json({ ok: true }); }));

// Web app views of the same data (own connections / imports; owner sees all)
r.get('/connections', requireAuth, wrap(async (req, res) => { const f = req.user.role === 'owner' ? {} : { user: req.user._id }; const items = await ExtensionConnection.find({ ...f, revokedAt: null }).populate('user', 'name').sort('-connectedAt');
  res.json({ items: items.map((c) => ({ id: c._id, user: c.user?.name, label: c.label, connectedAt: c.connectedAt, lastUsedAt: c.lastUsedAt })) }); }));
r.post('/connections/:id/revoke', requireAuth, wrap(async (req, res) => { const f = req.user.role === 'owner' ? {} : { user: req.user._id }; const c = await ExtensionConnection.findOneAndUpdate({ _id: req.params.id, ...f }, { revokedAt: new Date() }); if (!c) throw new HttpError(404, 'Connection not found'); await log(req, 'extension.disconnected', 'User', c.user); res.json({ ok: true }); }));
r.get('/imports', requireAuth, wrap(async (req, res) => { const f = { method: 'chrome_extension', ...(req.user.role === 'owner' ? {} : { user: req.user._id, department: { $in: req.user.departments } }) };
  const jobs = await ImportJob.find(f).sort('-createdAt').limit(100).populate('user', 'name'); res.json({ items: jobs.map((j) => ({ id: j._id, date: j.createdAt, source: j.source, query: j.query, sourceUrl: j.sourceUrl, department: j.department, user: j.user?.name, ...j.counts.toObject?.() ?? j.counts, status: j.status })) }); }));
export default r;
