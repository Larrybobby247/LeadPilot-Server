import { Router } from 'express';
import { z } from 'zod';
import { DEPARTMENTS } from '../config.js';
import { Campaign, Lead, MessageTemplate, User } from '../models/index.js';
import { HttpError, wrap, requireAuth, hasDept, leadScope } from '../middleware/auth.js';
import { log, notify } from '../services/activity.js';

const r = Router(); r.use(requireAuth);
const vis = (u) => (u.role === 'owner' ? {} : { department: { $in: u.departments }, $or: [{ assignedTo: u._id }, { createdBy: u._id }] });
const schema = z.object({ name: z.string().trim().min(2).max(120), department: z.enum(DEPARTMENTS), category: z.string().max(100).optional(), location: z.string().max(100).optional(), description: z.string().max(1000).optional(), assignedTo: z.array(z.string()).max(50).optional(),
  template: z.string().optional(), status: z.enum(['Draft', 'Active', 'Paused', 'Completed', 'Archived']).optional(), startDate: z.coerce.date().optional(), endDate: z.coerce.date().optional() });
async function stats(c) { const base = { campaign: c._id }; const [total, contacted, responded, interested, converted] = await Promise.all([Lead.countDocuments(base), Lead.countDocuments({ ...base, contactedAt: { $ne: null } }), Lead.countDocuments({ ...base, respondedAt: { $ne: null } }), Lead.countDocuments({ ...base, interestedAt: { $ne: null } }), Lead.countDocuments({ ...base, convertedAt: { $ne: null } })]); return { total, contacted, responded, interested, converted }; }
r.get('/', wrap(async (req, res) => { const f = { ...vis(req.user), ...(req.query.department && { department: String(req.query.department) }), ...(req.query.status && { status: String(req.query.status) }) };
  const cs = await Campaign.find(f).sort('-createdAt').populate('assignedTo', 'name'); res.json({ items: await Promise.all(cs.map(async (c) => ({ ...c.toObject(), stats: await stats(c) }))) }); }));
r.post('/', wrap(async (req, res) => { const b = schema.parse(req.body); if (!hasDept(req.user, b.department)) throw new HttpError(403, 'No access to this workspace');
  let assigned = req.user.role === 'owner' ? b.assignedTo || [] : [String(req.user._id)]; if (assigned.length) { const users = await User.find({ _id: { $in: assigned }, active: true }); assigned = users.filter((u) => hasDept(u, b.department)).map((u) => u._id); }
  if (b.template && !(await MessageTemplate.exists({ _id: b.template, department: b.department, $or: [{ scope: 'global' }, { owner: req.user._id }] }))) throw new HttpError(400, 'Template not available for this workspace');
  const c = await Campaign.create({ ...b, assignedTo: assigned, createdBy: req.user._id }); await log(req, 'campaign.created', 'Campaign', c._id, {}, b.department); for (const u of assigned) if (String(u) !== String(req.user._id)) await notify(u, 'campaign_assigned', `Campaign assigned: ${c.name}`, undefined, `/campaigns/${c._id}`); res.status(201).json(c); }));
const load = async (req) => { const c = await Campaign.findOne({ _id: req.params.id, ...vis(req.user) }); if (!c) throw new HttpError(404, 'Campaign not found'); return c; };
r.get('/:id', wrap(async (req, res) => { const c = await load(req); res.json({ ...c.toObject(), stats: await stats(c) }); }));
r.patch('/:id', wrap(async (req, res) => { const c = await load(req); if (req.user.role !== 'owner' && String(c.createdBy) !== String(req.user._id)) throw new HttpError(403, 'You can only edit campaigns you created');
  const b = schema.partial().omit({ department: true, assignedTo: true }).parse(req.body); Object.assign(c, b); await c.save(); await log(req, 'campaign.updated', 'Campaign', c._id, b, c.department); res.json(c); }));
r.post('/:id/leads', wrap(async (req, res) => { const { leadIds } = z.object({ leadIds: z.array(z.string()).min(1).max(500) }).parse(req.body); const c = await load(req);
  const out = await Lead.updateMany(leadScope(req.user, { _id: { $in: leadIds }, department: c.department }), { campaign: c._id }); await log(req, 'campaign.leads_added', 'Campaign', c._id, { n: out.modifiedCount }, c.department); res.json({ added: out.modifiedCount }); }));
export default r;
