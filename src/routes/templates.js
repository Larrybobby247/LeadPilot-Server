import { Router } from 'express';
import { z } from 'zod';
import { DEPARTMENTS } from '../config.js';
import { MessageTemplate } from '../models/index.js';
import { HttpError, wrap, requireAuth, hasDept } from '../middleware/auth.js';
import { render, VARIABLES } from '../services/templates.js';
import { log } from '../services/activity.js';

const r = Router(); r.use(requireAuth);
const PURPOSES = ['initial_outreach', 'introduction', 'no_response_followup', 'after_demo_followup', 'interested_prospect', 'management_contact_request', 'pricing_enquiry', 'objection_handling', 'demo_invitation', 'signup_invitation', 'final_followup'];
const body = z.object({ name: z.string().trim().min(2).max(120), department: z.enum(DEPARTMENTS), category: z.string().max(100).default('General'), purpose: z.enum(PURPOSES), body: z.string().trim().min(5).max(2000), active: z.boolean().optional(), scope: z.enum(['global', 'personal']).optional() });
r.get('/variables', (_q, res) => res.json({ variables: VARIABLES }));
r.get('/', wrap(async (req, res) => {
  const q = z.object({ department: z.enum(DEPARTMENTS).optional(), category: z.string().optional(), purpose: z.enum(PURPOSES).optional(), scope: z.enum(['global', 'personal']).optional() }).parse(req.query);
  const f = { ...(q.department && { department: q.department }), ...(q.category && { category: q.category }), ...(q.purpose && { purpose: q.purpose }) };
  const vis = req.user.role === 'owner' ? [{ scope: 'global' }, { owner: req.user._id }] : [{ scope: 'global', active: true, department: { $in: req.user.departments } }, { owner: req.user._id }];
  const items = await MessageTemplate.find({ ...f, $or: vis, ...(q.scope && { scope: q.scope }) }).sort('department purpose name'); res.json({ items });
}));
r.post('/', wrap(async (req, res) => {
  const b = body.parse(req.body); if (!hasDept(req.user, b.department)) throw new HttpError(403, 'No access to this workspace');
  const scope = req.user.role === 'owner' ? (b.scope || 'global') : 'personal'; // members can only create personal templates
  const t = await MessageTemplate.create({ ...b, scope, owner: scope === 'personal' ? req.user._id : undefined }); await log(req, 'template.created', 'MessageTemplate', t._id, { scope }, b.department); res.status(201).json(t);
}));
const canEdit = (u, t) => (t.scope === 'global' ? u.role === 'owner' : String(t.owner) === String(u._id));
r.patch('/:id', wrap(async (req, res) => { const t = await MessageTemplate.findById(req.params.id); if (!t || (t.scope === 'personal' && String(t.owner) !== String(req.user._id) && req.user.role !== 'owner')) throw new HttpError(404, 'Template not found');
  if (!canEdit(req.user, t)) throw new HttpError(403, 'Only the owner can edit global templates'); const b = body.partial().omit({ scope: true }).parse(req.body); Object.assign(t, b); await t.save(); await log(req, 'template.edited', 'MessageTemplate', t._id, {}, t.department); res.json(t); }));
r.post('/:id/duplicate', wrap(async (req, res) => { const t = await MessageTemplate.findOne({ _id: req.params.id, $or: [{ scope: 'global' }, { owner: req.user._id }] }); if (!t || !hasDept(req.user, t.department)) throw new HttpError(404, 'Template not found');
  const c = await MessageTemplate.create({ name: `${t.name} (copy)`, department: t.department, category: t.category, purpose: t.purpose, body: t.body, scope: 'personal', owner: req.user._id }); await log(req, 'template.created', 'MessageTemplate', c._id, { duplicatedFrom: t._id }, t.department); res.status(201).json(c); }));
r.delete('/:id', wrap(async (req, res) => { const t = await MessageTemplate.findById(req.params.id); if (!t) throw new HttpError(404, 'Template not found');
  if (t.scope === 'global' && req.user.role !== 'owner') throw new HttpError(403, 'Only the owner can delete global templates'); if (t.scope === 'personal' && String(t.owner) !== String(req.user._id)) throw new HttpError(404, 'Template not found');
  await t.deleteOne(); await log(req, 'template.deleted', 'MessageTemplate', t._id, {}, t.department); res.json({ ok: true }); }));
r.post('/preview', wrap(async (req, res) => { const { body: b } = z.object({ body: z.string().max(2000) }).parse(req.body);
  res.json(render(b, { business_name: 'Sample Business', contact_name: 'Ada', business_category: 'Restaurant', city: 'Ibadan', state: 'Oyo', sender_name: req.user.name, product_name: 'Your product', demo_link: 'https://example.com/demo', signup_link: 'https://example.com/signup', website_url: 'example.com' })); }));
export default r;
