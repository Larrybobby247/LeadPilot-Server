import { Router } from 'express';
import { z } from 'zod';
import { DEPARTMENTS, LEAD_STATUSES, SYSTEM_ONLY_STATUSES, STAGE_STAMP, NO_FOLLOWUP_STATUSES } from '../config.js';
import { Lead, Business, User, FollowUp, OutreachEvent, ImportJob, ActivityLog } from '../models/index.js';
import { HttpError, wrap, requireAuth, requireOwner, leadScope, departmentFilter, hasDept } from '../middleware/auth.js';
import { importRecords, verifyBusiness, evaluate } from '../services/importer.js';
import { completeness } from '../services/scoring.js';
import { keysFor, mergeFields, normalizeName } from '../services/dedupe.js';
import { log, notify } from '../services/activity.js';
import { applyStatus } from '../services/leadStatus.js';
import { Setting } from '../models/index.js';

const r = Router(); r.use(requireAuth);
export const recordSchema = z.object({ name: z.string().trim().max(200).optional().default(''), category: z.string().max(100).optional(), phone: z.string().max(40).optional(), email: z.string().max(200).optional(), website: z.string().max(300).optional(),
  social: z.string().max(300).optional(), city: z.string().max(100).optional(), location: z.string().max(100).optional(), state: z.string().max(100).optional(), address: z.string().max(300).optional(),
  sourceUrl: z.string().max(1000).optional(), verification: z.enum(['verified', 'unverified', 'requires_review']).optional(), notes: z.array(z.string()).optional(), action: z.enum(['skip', 'update', 'associate', 'import_new', 'override']).optional() });
const importBody = z.object({ department: z.enum(DEPARTMENTS), source: z.enum(['google_search', 'chrome_extension', 'csv_import', 'google_maps', 'manual']), method: z.string().optional(), query: z.string().max(300).optional(), sourceUrl: z.string().max(1000).optional(), records: z.array(recordSchema).min(1).max(500) });

export const shape = (l) => { const b = l.business || {}; return { id: l._id, department: l.department, status: l.status, source: l.source, sourceUrl: l.sourceUrl, verification: l.verification, completeness: l.completeness, completenessBand: l.completenessBand, assignedTo: l.assignedTo?.name ? { id: l.assignedTo._id, name: l.assignedTo.name } : l.assignedTo,
  campaign: l.campaign, contactPerson: l.contactPerson, whatsappNumber: l.whatsappNumber, whatsappVerified: l.whatsappVerified, archived: l.archived, followUpsPaused: l.followUpsPaused, discoveredAt: l.discoveredAt, lastContactedAt: l.lastContactedAt, nextFollowUpAt: l.nextFollowUpAt,
  business: { id: b._id, name: b.name, category: b.category, city: b.city, state: b.state, country: b.country, address: b.address, phones: b.phones, emails: b.emails, website: b.website, instagram: b.instagram, facebook: b.facebook, linkedin: b.linkedin, websiteStatus: b.websiteStatus, websiteReason: b.websiteReason, websiteCheckedAt: b.websiteCheckedAt },
  contactReady: !!b.phones?.length }; };

r.get('/', wrap(async (req, res) => {
  const q = z.object({ department: z.enum(DEPARTMENTS).optional(), status: z.enum(LEAD_STATUSES).optional(), source: z.string().optional(), verification: z.string().optional(), websiteStatus: z.string().optional(), assignedTo: z.string().optional(), campaign: z.string().optional(),
    search: z.string().max(100).optional(), city: z.string().optional(), category: z.string().optional(), archived: z.enum(['true', 'false']).default('false'), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25), sort: z.string().default('-discoveredAt') }).parse(req.query);
  const f = leadScope(req.user, departmentFilter(req.user, q.department)); f.archived = q.archived === 'true';
  for (const k of ['status', 'source', 'verification', 'campaign']) if (q[k]) f[k] = q[k];
  if (q.assignedTo) { if (req.user.role !== 'owner' && q.assignedTo !== String(req.user._id)) throw new HttpError(403, 'Not allowed'); f.assignedTo = q.assignedTo; }
  const bf = {}; if (q.search) bf.name = { $regex: q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }; if (q.city) bf.city = new RegExp('^' + q.city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'); if (q.category) bf.category = q.category; if (q.websiteStatus) bf.websiteStatus = q.websiteStatus === 'opportunities' ? { $ne: 'WORKING_WEBSITE' } : q.websiteStatus; // 'opportunities' = everything except working sites
  if (Object.keys(bf).length) f.business = { $in: (await Business.find(bf).select('_id').limit(5000)).map((b) => b._id) };
  const sortKey = ['discoveredAt', 'lastContactedAt', 'nextFollowUpAt', 'completeness', 'status'].includes(q.sort.replace('-', '')) ? q.sort : '-discoveredAt';
  const [items, total] = await Promise.all([Lead.find(f).sort(sortKey).skip((q.page - 1) * q.limit).limit(q.limit).populate('business').populate('assignedTo', 'name'), Lead.countDocuments(f)]);
  res.json({ items: items.map(shape), total, page: q.page, pages: Math.ceil(total / q.limit) });
}));

// Owner audit: businesses held by more than one person, and businesses sharing a phone number. Resolve = keep one lead, archive the rest.
r.get('/collisions/audit', requireOwner, wrap(async (_q, res) => {
  const held = await Lead.aggregate([{ $match: { archived: false } }, { $group: { _id: '$business', users: { $addToSet: '$assignedTo' }, leads: { $push: { id: '$_id', user: '$assignedTo', department: '$department', status: '$status' } } } }, { $match: { 'users.1': { $exists: true } } }, { $limit: 100 }]);
  const names = Object.fromEntries((await Business.find({ _id: { $in: held.map((h) => h._id) } }).select('name')).map((b) => [String(b._id), b.name])); const us = Object.fromEntries((await User.find().select('name')).map((u) => [String(u._id), u.name]));
  const phones = await Business.aggregate([{ $unwind: '$phones' }, { $group: { _id: '$phones', businesses: { $addToSet: '$name' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $limit: 100 }]);
  res.json({ heldByMultiple: held.map((h) => ({ business: names[String(h._id)], leads: h.leads.map((l) => ({ id: l.id, department: l.department, status: l.status, user: us[String(l.user)] })) })), sharedPhones: phones.map((p) => ({ phone: p._id, businesses: p.businesses })) }); }));
r.post('/collisions/resolve', requireOwner, wrap(async (req, res) => { const { keepLeadId, archiveLeadIds } = z.object({ keepLeadId: z.string(), archiveLeadIds: z.array(z.string()).min(1).max(20) }).parse(req.body);
  if (archiveLeadIds.includes(keepLeadId)) throw new HttpError(400, 'Cannot archive the lead you are keeping'); await Lead.updateMany({ _id: { $in: archiveLeadIds } }, { archived: true }); await FollowUp.updateMany({ lead: { $in: archiveLeadIds }, status: { $in: ['Pending', 'Rescheduled'] } }, { status: 'Cancelled' });
  await log(req, 'collision.resolved', 'Lead', keepLeadId, { archived: archiveLeadIds.length }); res.json({ ok: true }); }));
const loadLead = async (req, populate = true) => { const l = await Lead.findOne(leadScope(req.user, { _id: req.params.id })); if (!l) throw new HttpError(404, 'Lead not found'); return populate ? l.populate([{ path: 'business' }, { path: 'assignedTo', select: 'name' }]) : l; }; // 404, not 403: don't reveal other users' records
r.get('/:id', wrap(async (req, res) => {
  const l = await loadLead(req); const [events, followUps, activity] = await Promise.all([OutreachEvent.find({ lead: l._id }).sort('-at').limit(50), FollowUp.find({ lead: l._id }).sort('dueAt'), ActivityLog.find({ entityType: 'Lead', entityId: l._id }).sort('-at').limit(50).populate('user', 'name')]);
  res.json({ ...shape(l), notes: l.notes, outreach: events, followUps, activity: activity.map((a) => ({ action: a.action, at: a.at, by: a.user?.name, metadata: a.metadata })) });
}));

r.post('/', wrap(async (req, res) => { // manual entry
  const b = importBody.omit({ source: true, records: true }).extend({ record: recordSchema }).parse(req.body); if (!hasDept(req.user, b.department)) throw new HttpError(403, 'No access to this workspace');
  const out = await importRecords({ user: req.user, department: b.department, records: [b.record], source: 'manual', method: 'manual' });
  if (out.imported.length + out.review.length) { await log(req, 'lead.created', 'Lead', (out.imported[0] || out.review[0]).leadId, {}, b.department); return res.status(201).json(out); }
  if (out.duplicates.length || out.potential.length || out.taken.length) { await log(req, 'duplicate.prevented', 'Lead', undefined, { count: out.duplicates.length + out.potential.length + out.taken.length, via: 'manual' }, b.department); return res.status(409).json({ message: 'Possible duplicate detected. This business already exists in your LeadPilot database.', ...out }); }
  res.status(422).json(out);
}));

r.post('/bulk-import', wrap(async (req, res) => { // CSV + discovery
  const b = importBody.parse(req.body); if (!hasDept(req.user, b.department)) throw new HttpError(403, 'No access to this workspace');
  const job = await ImportJob.create({ user: req.user._id, department: b.department, source: b.source, method: b.method || b.source, query: b.query, sourceUrl: b.sourceUrl, counts: { collected: b.records.length } });
  const out = await importRecords({ user: req.user, department: b.department, records: b.records, source: b.source, method: b.method, query: b.query, sourceUrl: b.sourceUrl, jobId: job._id });
  job.counts = { collected: b.records.length, imported: out.imported.length, duplicates: out.duplicates.length + out.potential.length + out.taken.length, rejected: out.rejected.length, review: out.review.length }; job.status = out.imported.length + out.review.length + out.updated.length ? (out.rejected.length ? 'Partial' : 'Completed') : 'Failed'; await job.save();
  if (job.counts.duplicates) await log(req, 'duplicate.prevented', 'ImportJob', job._id, { count: job.counts.duplicates, via: b.source }, b.department);
  await log(req, b.source === 'csv_import' ? 'csv.imported' : 'lead.imported', 'ImportJob', job._id, job.counts, b.department);
  await notify(req.user._id, 'import_completed', `Import finished: ${out.imported.length} added`, `${out.duplicates.length} already existed, ${out.rejected.length} rejected`, '/leads'); res.json({ jobId: job._id, ...out });
}));
r.post('/preview', wrap(async (req, res) => { // dry run, nothing saved: new / duplicate / potential / associate / rejected
  const b = importBody.omit({ source: true }).parse(req.body); if (!hasDept(req.user, b.department)) throw new HttpError(403, 'No access to this workspace');
  const items = []; const seen = new Set();
  for (const rec of b.records) { const ev = await evaluate(rec, b.department, req.user); const k = ev.keys ? [...ev.keys.phones, ...ev.keys.domains, ...ev.keys.socials, ...ev.keys.emails] : [];
    let kind = ev.kind; if (kind === 'new' && k.some((x) => seen.has(x))) kind = 'duplicate'; k.forEach((x) => seen.add(x)); // repeats inside the same batch
    items.push({ name: rec.name, kind, reason: ev.reason, matchedOn: ev.matchedOn?.join(', '), existing: ev.existing }); }
  res.json({ items }); }));

const patchSchema = z.object({ contactPerson: z.string().max(100).optional(), whatsappNumber: z.string().max(40).optional(), whatsappVerified: z.boolean().optional(), status: z.enum(LEAD_STATUSES).optional(), verification: z.enum(['verified', 'unverified', 'requires_review']).optional(),
  business: z.object({ name: z.string().trim().min(1).max(200), category: z.string().max(100), city: z.string().max(100), state: z.string().max(100), address: z.string().max(300), website: z.string().max(300), email: z.string().max(200), phone: z.string().max(40) }).partial().optional(), followUpsPaused: z.boolean().optional(), archived: z.boolean().optional() });
r.patch('/:id', wrap(async (req, res) => {
  const b = patchSchema.parse(req.body); const l = await loadLead(req, false);
  if (b.status && b.status !== l.status) {
    if (SYSTEM_ONLY_STATUSES.includes(b.status)) throw new HttpError(400, `"${b.status}" is set automatically when you confirm a message was sent`);
    await applyStatus(req, l, b.status);
  }
  for (const k of ['contactPerson', 'whatsappVerified', 'verification', 'followUpsPaused', 'archived']) if (b[k] !== undefined) l[k] = b[k];
  if (b.whatsappNumber !== undefined) l.whatsappNumber = b.whatsappNumber;
  if (b.business) { const biz = await Business.findById(l.business); const old = biz.website; const { business: bz } = b; const { phone, email, ...rest } = bz;
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) biz[k] = v;
    const k = keysFor({ ...biz.toObject(), phone, email, phones: [...biz.phones, ...(phone ? [phone] : [])], emails: [...biz.emails, ...(email ? [email] : [])] }); biz.phones = k.phones; biz.emails = k.emails; biz.domains = k.domains; biz.normName = normalizeName(biz.name); biz.cityKey = (biz.city || '').toLowerCase();
    if (biz.website !== old && !biz.websiteManual) { biz.websiteStatus = biz.website ? undefined : 'NO_WEBSITE'; } await biz.save();
    const s = await Setting.findOne({ key: 'global' }); const sc = completeness({ ...biz.toObject(), whatsappVerified: l.whatsappVerified }, s?.scoringWeights || undefined); l.completeness = sc.score; l.completenessBand = sc.band; }
  await l.save(); await log(req, 'lead.edited', 'Lead', l._id, { fields: Object.keys(b) }, l.department); res.json({ ok: true });
}));
r.post('/:id/notes', wrap(async (req, res) => { const { text } = z.object({ text: z.string().trim().min(1).max(2000) }).parse(req.body); const l = await loadLead(req, false); l.notes.push({ text, by: req.user._id }); await l.save(); await log(req, 'lead.note_added', 'Lead', l._id, {}, l.department); res.status(201).json({ notes: l.notes }); }));
r.post('/:id/website-check', wrap(async (req, res) => { const l = await loadLead(req, false); await verifyBusiness(l.business); const b = await Business.findById(l.business); res.json({ status: b.websiteStatus, reason: b.websiteReason, checkedAt: b.websiteCheckedAt }); }));
r.post('/:id/website-status', wrap(async (req, res) => { const { status } = z.object({ status: z.enum(['WORKING_WEBSITE', 'NO_WEBSITE', 'BROKEN_WEBSITE', 'PARKED_DOMAIN', 'UNCERTAIN']) }).parse(req.body); const l = await loadLead(req, false);
  await Business.updateOne({ _id: l.business }, { websiteStatus: status, websiteManual: true, websiteReason: 'Set manually.', websiteCheckedAt: new Date() }); await log(req, 'lead.website_status_set', 'Lead', l._id, { status }, l.department); res.json({ ok: true }); }));
r.delete('/:id', wrap(async (req, res) => { const l = await loadLead(req, false); l.archived = true; await l.save(); await FollowUp.updateMany({ lead: l._id, status: 'Pending' }, { status: 'Cancelled' }); await log(req, 'lead.archived', 'Lead', l._id, {}, l.department); res.json({ ok: true }); })); // archive, never hard-delete

r.post('/:id/assign', requireOwner, wrap(async (req, res) => { const { userId } = z.object({ userId: z.string() }).parse(req.body); const l = await Lead.findById(req.params.id); if (!l) throw new HttpError(404, 'Lead not found');
  const u = await User.findOne({ _id: userId, active: true }); if (!u || !hasDept(u, l.department)) throw new HttpError(400, 'That team member does not have access to this workspace');
  l.assignedTo = u._id; await l.save(); await FollowUp.updateMany({ lead: l._id, status: 'Pending' }, { user: u._id }); await log(req, 'lead.assigned', 'Lead', l._id, { to: u._id }, l.department); await notify(u._id, 'lead_assigned', 'New lead assigned', undefined, `/leads/${l._id}`); res.json({ ok: true }); }));
r.post('/:id/merge', wrap(async (req, res) => { // merge incoming fields into an existing lead's business; never overwrites verified data
  const { incoming } = z.object({ incoming: recordSchema }).parse(req.body); const l = await loadLead(req, false); const b = await Business.findById(l.business);
  const { merged, conflicts } = mergeFields({ category: b.category, city: b.city, website: b.website, address: b.address }, { category: incoming.category, city: incoming.city || incoming.location, website: incoming.website, address: incoming.address }, { existingVerified: b.verification === 'verified', incomingVerified: incoming.verification === 'verified' });
  Object.assign(b, merged); const k = keysFor({ ...incoming, phones: b.phones, emails: b.emails, website: b.website, socials: b.socials }); b.phones = k.phones; b.emails = k.emails; b.domains = [...new Set([...b.domains, ...k.domains])]; b.socials = [...new Set([...b.socials, ...k.socials])]; await b.save();
  await log(req, 'lead.merged', 'Lead', l._id, { conflicts: conflicts.length }, l.department); res.json({ conflicts }); }));
export default r;
