import { Router } from 'express';
import { z } from 'zod';
import { DEPARTMENTS } from '../config.js';
import { Notification, ActivityLog, Category, Setting, IntegrationSetting, UsageRecord, ImportJob, User } from '../models/index.js';
import { HttpError, wrap, requireAuth, requireOwner } from '../middleware/auth.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { DEFAULT_WEIGHTS } from '../services/scoring.js';
import { DEFAULT_INTERVALS } from '../services/followups.js';
import { log } from '../services/activity.js';
import { productUpdates } from '../services/settings.js';
import { config } from '../config.js';

const r = Router(); r.use(requireAuth);
const NAMES = { ordarly: 'Ordarly', keykonnec: 'KeyKonnec', website: 'Website Outreach' };
r.get('/departments', wrap(async (req, res) => { const allowed = req.user.role === 'owner' ? DEPARTMENTS : req.user.departments; const cats = await Category.find({ department: { $in: allowed } }).sort('name'); const s = await Setting.findOne({ key: 'global' });
  res.json({ items: allowed.map((d) => ({ id: d, name: NAMES[d], categories: cats.filter((c) => c.department === d).map((c) => c.name), product: s?.products?.[d] || {} })) }); }));
r.post('/categories', requireOwner, wrap(async (req, res) => { const b = z.object({ department: z.enum(DEPARTMENTS), name: z.string().trim().min(2).max(80) }).parse(req.body); const c = await Category.create(b); await log(req, 'category.created', 'Category', c._id, b, b.department); res.status(201).json(c); }));
r.delete('/categories/:id', requireOwner, wrap(async (req, res) => { await Category.deleteOne({ _id: req.params.id }); res.json({ ok: true }); }));

r.get('/notifications', wrap(async (req, res) => { const items = await Notification.find({ user: req.user._id }).sort('-createdAt').limit(100); res.json({ items, unread: items.filter((n) => !n.read).length }); }));
r.post('/notifications/read', wrap(async (req, res) => { const { ids } = z.object({ ids: z.array(z.string()).optional() }).parse(req.body); await Notification.updateMany({ user: req.user._id, ...(ids ? { _id: { $in: ids } } : {}) }, { read: true }); res.json({ ok: true }); }));

r.get('/activity', wrap(async (req, res) => { const q = z.object({ action: z.string().optional(), userId: z.string().optional(), department: z.string().optional(), page: z.coerce.number().default(1) }).parse(req.query);
  const f = { ...(q.action && { action: q.action }), ...(q.department && { department: q.department }) }; if (req.user.role === 'owner') { if (q.userId) f.user = q.userId; } else f.user = req.user._id; // members: own history only
  const [items, total] = await Promise.all([ActivityLog.find(f).sort('-at').skip((q.page - 1) * 50).limit(50).populate('user', 'name'), ActivityLog.countDocuments(f)]); res.json({ items, total }); }));
r.get('/discovery/history', wrap(async (req, res) => { const f = req.user.role === 'owner' ? {} : { user: req.user._id, department: { $in: req.user.departments } }; const jobs = await ImportJob.find(f).sort('-createdAt').limit(100).populate('user', 'name');
  res.json({ items: jobs.map((j) => ({ id: j._id, date: j.createdAt, method: j.method, source: j.source, query: j.query, department: j.department, user: j.user?.name, counts: j.counts, status: j.status })) }); }));

const defaults = (s) => ({ scoringWeights: s?.scoringWeights || DEFAULT_WEIGHTS, followUpIntervals: s?.followUpIntervals?.length ? s.followUpIntervals : DEFAULT_INTERVALS, defaultCountryCode: s?.defaultCountryCode || '234', products: s?.products || {}, collisionPolicy: s?.collisionPolicy || 'filter' });
r.get('/settings', wrap(async (req, res) => { const d = defaults(await Setting.findOne({ key: 'global' })); res.json(req.user.role === 'owner' ? d : { followUpIntervals: d.followUpIntervals }); }));
r.put('/settings', requireOwner, wrap(async (req, res) => {
  const b = z.object({ collisionPolicy: z.enum(['filter', 'allow']).optional(), scoringWeights: z.record(z.number().min(0).max(100)).optional(), followUpIntervals: z.array(z.number().int().min(1).max(60)).min(1).max(5).optional(), defaultCountryCode: z.string().regex(/^\d{1,3}$/).optional(), products: z.record(z.any()).optional() }).parse(req.body);
  if (b.scoringWeights && Object.keys(b.scoringWeights).some((k) => !(k in DEFAULT_WEIGHTS))) throw new HttpError(400, 'Unknown scoring field');
  const { products, ...rest } = b; const { set, unset, errors } = productUpdates(products); if (errors.length) throw new HttpError(400, errors[0].message, { issues: errors });
  await Setting.updateOne({ key: 'global', $or: [{ products: null }, { products: { $exists: false } }] }, { $set: { products: {} } }); // make sure the parent object exists before field-level updates
  const update = {}; if (Object.keys({ ...rest, ...set }).length) update.$set = { ...rest, ...set }; if (Object.keys(unset).length) update.$unset = unset;
  if (Object.keys(update).length) await Setting.updateOne({ key: 'global' }, update, { upsert: true }); await log(req, 'settings.updated', 'Setting', undefined, { keys: [...Object.keys(rest), ...Object.keys(set), ...Object.keys(unset)] }); res.json(defaults(await Setting.findOne({ key: 'global' }))); }));

// Integrations: only what is actually implemented. Nothing is shown "connected" without a successful test.
const INTEGRATIONS = { google_places: { name: 'Google Places / Maps', costNote: 'Billing may be required. Google Maps Platform bills per request beyond its free allowance; set a monthly limit here.', testable: true },
  resend: { name: 'Resend (email)', costNote: 'Optional. Configured with the RESEND_API_KEY environment variable.', testable: false }, whatsapp: { name: 'WhatsApp click-to-chat', costNote: 'Free. Opens WhatsApp with a prepared message; it does not send messages or use the WhatsApp Business API.', testable: false },
  instagram: { name: 'Instagram', costNote: 'Not available in this version.', testable: false }, facebook: { name: 'Facebook', costNote: 'Not available in this version.', testable: false }, linkedin: { name: 'LinkedIn', costNote: 'Not available in this version.', testable: false }, gemini: { name: 'Google Gemini (AI)', costNote: 'Free tier available with limits. Configured with the GEMINI_API_KEY environment variable on the server; the key is never sent to the browser.', testable: false } };
const month = () => new Date().toISOString().slice(0, 7);
r.get('/integrations', requireOwner, wrap(async (_req, res) => { const saved = await IntegrationSetting.find().select('+secretEnc'); const usage = await UsageRecord.find({ month: month() }); const out = [];
  for (const [key, meta] of Object.entries(INTEGRATIONS)) { const s = saved.find((x) => x.key === key); const u = usage.find((x) => x.integration === key); let state = 'Not Connected';
    if (key === 'whatsapp') state = 'Click-to-chat only'; else if (key === 'resend') state = config.resendKey ? 'Configured' : 'Not Connected'; else if (key === 'gemini') state = config.geminiKey ? 'Configured' : 'Not Connected'; else if (!meta.testable) state = 'Not available'; else if (s?.lastError) state = 'Error'; else if (s?.verified && s.enabled) state = 'Connected'; else if (s?.secretEnc) state = 'Configuration Required';
    out.push({ key, name: meta.name, costNote: meta.costNote, state, enabled: !!s?.enabled, hasSecret: !!s?.secretEnc, monthlyLimit: s?.monthlyLimit, lastError: s?.lastError, lastTestedAt: s?.lastTestedAt, usage: u ? { units: u.units, estimatedCost: u.estimatedCost, remaining: s?.monthlyLimit ? Math.max(0, s.monthlyLimit - u.units) : null, errors: u.errors.slice(-5) } : { units: 0, estimatedCost: 0, remaining: s?.monthlyLimit ?? null, errors: [] } }); }
  res.json({ items: out }); }));
r.put('/integrations/:key', requireOwner, wrap(async (req, res) => { const meta = INTEGRATIONS[req.params.key]; if (!meta?.testable) throw new HttpError(400, 'This integration is not configurable in this version');
  const b = z.object({ secret: z.string().min(10).max(300).optional(), enabled: z.boolean().optional(), monthlyLimit: z.number().int().min(0).max(1e7).optional() }).parse(req.body); const set = { ...(b.enabled !== undefined && { enabled: b.enabled }), ...(b.monthlyLimit !== undefined && { monthlyLimit: b.monthlyLimit }) };
  if (b.secret) { set.secretEnc = encrypt(b.secret); set.verified = false; set.lastError = undefined; } if (set.enabled && !b.secret && !(await IntegrationSetting.findOne({ key: req.params.key, verified: true }))) throw new HttpError(400, 'Test the connection successfully before enabling');
  await IntegrationSetting.updateOne({ key: req.params.key }, { $set: set }, { upsert: true }); await log(req, 'integration.updated', 'Integration', undefined, { key: req.params.key, secretChanged: !!b.secret }); res.json({ ok: true }); })); // the key is never returned
r.post('/integrations/:key/test', requireOwner, wrap(async (req, res) => { if (req.params.key !== 'google_places') throw new HttpError(400, 'Nothing to test'); const s = await IntegrationSetting.findOne({ key: 'google_places' }).select('+secretEnc'); if (!s?.secretEnc) throw new HttpError(400, 'Save an API key first');
  let ok = false, msg = ''; try { const resp = await fetch('https://places.googleapis.com/v1/places:searchText', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': decrypt(s.secretEnc), 'X-Goog-FieldMask': 'places.id' }, body: JSON.stringify({ textQuery: 'restaurant Lagos', pageSize: 1 }) }); ok = resp.ok; if (!ok) msg = `Google returned ${resp.status}`; } catch { msg = 'Could not reach Google'; }
  s.verified = ok; s.lastError = ok ? undefined : msg; s.lastTestedAt = new Date(); await s.save(); await UsageRecord.updateOne({ integration: 'google_places', month: month() }, { $inc: { units: 1 }, ...(ok ? {} : { $push: { errors: { at: new Date(), message: msg } } }) }, { upsert: true });
  res.json({ ok, message: ok ? 'Connected' : msg }); }));
export default r;
