import { Router } from 'express';
import { z } from 'zod';
import { FollowUp, Lead } from '../models/index.js';
import { HttpError, wrap, requireAuth, leadScope } from '../middleware/auth.js';
import { canFollowUp } from '../services/followups.js';
import { refreshNext, scheduleNext, OPEN } from '../services/followupOps.js';
import { log } from '../services/activity.js';

const r = Router(); r.use(requireAuth);
const mine = (u) => (u.role === 'owner' ? {} : { user: u._id, department: { $in: u.departments } });
r.get('/', wrap(async (req, res) => {
  const { bucket, department, page, limit } = z.object({ bucket: z.enum(['today', 'overdue', 'upcoming', 'completed', 'all']).default('all'), department: z.string().optional(), page: z.coerce.number().default(1), limit: z.coerce.number().max(100).default(50) }).parse(req.query);
  const sod = new Date(); sod.setHours(0, 0, 0, 0); const eod = new Date(sod.getTime() + 864e5); const f = { ...mine(req.user), ...(department && { department }) };
  if (bucket === 'today') Object.assign(f, { status: { $in: OPEN }, dueAt: { $gte: sod, $lt: eod } }); if (bucket === 'overdue') Object.assign(f, { status: { $in: OPEN }, dueAt: { $lt: sod } });
  if (bucket === 'upcoming') Object.assign(f, { status: { $in: OPEN }, dueAt: { $gte: eod } }); if (bucket === 'completed') f.status = 'Completed';
  const [items, total] = await Promise.all([FollowUp.find(f).sort(bucket === 'completed' ? '-completedAt' : 'dueAt').skip((page - 1) * limit).limit(limit).populate({ path: 'lead', populate: 'business' }).populate('user', 'name'), FollowUp.countDocuments(f)]);
  const counts = {}; for (const b of ['today', 'overdue', 'upcoming']) { const q = { ...mine(req.user), status: { $in: OPEN }, dueAt: b === 'today' ? { $gte: sod, $lt: eod } : b === 'overdue' ? { $lt: sod } : { $gte: eod } }; counts[b] = await FollowUp.countDocuments(q); }
  counts.completed = await FollowUp.countDocuments({ ...mine(req.user), status: 'Completed' }); res.json({ items, total, counts });
}));
r.post('/', wrap(async (req, res) => { const b = z.object({ leadId: z.string(), dueAt: z.coerce.date(), note: z.string().max(500).optional() }).parse(req.body);
  const l = await Lead.findOne(leadScope(req.user, { _id: b.leadId })); if (!l) throw new HttpError(404, 'Lead not found'); if (!canFollowUp(l.status)) throw new HttpError(422, `Follow-ups are not scheduled for "${l.status}" leads`);
  const f = await FollowUp.create({ lead: l._id, user: l.assignedTo, department: l.department, campaign: l.campaign, dueAt: b.dueAt, note: b.note, step: await FollowUp.countDocuments({ lead: l._id, status: 'Completed' }) }); await refreshNext(l._id); await log(req, 'followup.scheduled', 'Lead', l._id, { dueAt: b.dueAt }, l.department); res.status(201).json(f); }));
const load = async (req) => { const f = await FollowUp.findOne({ _id: req.params.id, ...mine(req.user) }); if (!f) throw new HttpError(404, 'Follow-up not found'); return f; };
r.patch('/:id', wrap(async (req, res) => { const b = z.object({ dueAt: z.coerce.date().optional(), status: z.enum(['Cancelled']).optional(), note: z.string().max(500).optional() }).parse(req.body); const f = await load(req); if (!OPEN.includes(f.status)) throw new HttpError(400, 'This follow-up is closed');
  if (b.dueAt) { f.dueAt = b.dueAt; f.status = 'Rescheduled'; } if (b.status) f.status = 'Cancelled'; if (b.note !== undefined) f.note = b.note; await f.save(); await refreshNext(f.lead); await log(req, 'followup.updated', 'Lead', f.lead, b, f.department); res.json(f); }));
r.post('/:id/complete', wrap(async (req, res) => { const f = await load(req); if (!OPEN.includes(f.status)) throw new HttpError(400, 'This follow-up is already closed');
  f.status = 'Completed'; f.completedAt = new Date(); await f.save(); const l = await Lead.findById(f.lead); await refreshNext(f.lead); const next = l ? await scheduleNext(l) : null;
  await log(req, 'followup.completed', 'Lead', f.lead, {}, f.department); res.json({ ok: true, next: next?.dueAt || null }); }));
export default r;
