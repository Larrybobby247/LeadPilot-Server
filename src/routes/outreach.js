import { Router } from 'express';
import { z } from 'zod';
import { Lead, OutreachEvent, MessageTemplate, FollowUp, Setting } from '../models/index.js';
import { HttpError, wrap, requireAuth, leadScope } from '../middleware/auth.js';
import { render } from '../services/templates.js';
import { waUrl, waLinks, normalizePhone } from '../services/phone.js';
import { scheduleNext, refreshNext, OPEN } from '../services/followupOps.js';
import { log } from '../services/activity.js';

const r = Router(); r.use(requireAuth);
const getLead = async (req, id) => { const l = await Lead.findOne(leadScope(req.user, { _id: id })).populate('business'); if (!l) throw new HttpError(404, 'Lead not found'); return l; };
async function varsFor(req, l) { const s = await Setting.findOne({ key: 'global' }); const p = s?.products?.[l.department] || {}; const b = l.business;
  return { business_name: b.name, contact_name: l.contactPerson, business_category: b.category, city: b.city, state: b.state, sender_name: req.user.name, product_name: p.productName, demo_link: p.demoLink, signup_link: p.signupLink, website_url: b.website }; }
const numberFor = (l) => normalizePhone(l.whatsappNumber) || l.business.phones?.[0] || null;

r.post('/preview', wrap(async (req, res) => {
  const { leadId, templateId, body } = z.object({ leadId: z.string(), templateId: z.string().optional(), body: z.string().max(2000).optional() }).parse(req.body);
  const l = await getLead(req, leadId); let text = body; if (!text && templateId) { const t = await MessageTemplate.findOne({ _id: templateId, active: true, $or: [{ scope: 'global' }, { owner: req.user._id }] }); if (!t) throw new HttpError(404, 'Template not found'); text = t.body; }
  if (!text) throw new HttpError(400, 'Choose a template or write a message'); res.json(render(text, await varsFor(req, l)));
}));
r.post('/opened', wrap(async (req, res) => {
  const b = z.object({ leadId: z.string(), templateId: z.string().optional(), message: z.string().min(1).max(2000), channel: z.enum(['whatsapp', 'whatsapp_business']).default('whatsapp'), force: z.boolean().optional() }).parse(req.body);
  const l = await getLead(req, b.leadId); const n = numberFor(l); if (!n) throw new HttpError(422, 'This lead has no usable phone number');
  if (['Do Not Contact', 'Invalid Contact'].includes(l.status)) throw new HttpError(422, `This lead is marked "${l.status}"`);
  if (l.campaign && !b.force && await OutreachEvent.exists({ lead: l._id, campaign: l.campaign, type: 'confirmed_sent', at: { $gt: new Date(Date.now() - 864e5) } }))
    throw new HttpError(409, 'You already sent a message to this lead in this campaign in the last 24 hours.', { code: 'ALREADY_CONTACTED' });
  const ev = await OutreachEvent.create({ lead: l._id, user: req.user._id, department: l.department, campaign: l.campaign, type: 'opened', channel: b.channel, template: b.templateId, message: b.message });
  if (l.status === 'New') { l.status = 'Outreach Opened'; await l.save(); } // opening is NOT contact
  await log(req, 'outreach.whatsapp_opened', 'Lead', l._id, { eventId: ev._id }, l.department); res.json({ eventId: ev._id, url: waUrl(n, b.message), links: waLinks(n, b.message) });
}));
async function completeOutreach(req, l) { // a recorded, genuine contact: status, timestamps, follow-up chain
  if (['New', 'Outreach Opened', 'No Response'].includes(l.status)) l.status = 'Contacted'; if (!l.contactedAt) l.contactedAt = new Date(); l.lastContactedAt = new Date(); await l.save();
  const done = await FollowUp.find({ lead: l._id, status: { $in: OPEN } }); for (const f of done) { f.status = 'Completed'; f.completedAt = new Date(); await f.save(); } await refreshNext(l._id); return scheduleNext(l); }
r.post('/record', wrap(async (req, res) => { // email / call / other contact the user did and is recording as completed (counts toward goals; opens and AI drafts never do)
  const b = z.object({ leadId: z.string(), channel: z.enum(['email', 'call', 'other']), note: z.string().max(500).optional() }).parse(req.body); const l = await getLead(req, b.leadId);
  if (['Do Not Contact', 'Invalid Contact'].includes(l.status)) throw new HttpError(422, `This lead is marked "${l.status}"`);
  await OutreachEvent.create({ lead: l._id, user: req.user._id, department: l.department, campaign: l.campaign, type: 'confirmed_sent', channel: b.channel, message: b.note }); const next = await completeOutreach(req, l); await log(req, 'outreach.recorded', 'Lead', l._id, { channel: b.channel }, l.department); res.json({ ok: true, nextFollowUpAt: next?.dueAt || null }); }));
const confirmBody = z.object({ leadId: z.string().optional(), eventId: z.string().optional(), sent: z.boolean(), message: z.string().max(2000).optional(), templateId: z.string().optional(), channel: z.enum(['whatsapp', 'whatsapp_business']).default('whatsapp') })
  .refine((b) => b.leadId || b.eventId, { message: 'leadId or eventId is required' });
// "Did you send it?" can be answered at any time. Opening WhatsApp first is optional: a pending "opened" event is used if there is one, otherwise the answer is recorded directly.
r.post('/confirm-sent', wrap(async (req, res) => {
  const b = confirmBody.parse(req.body); const mine = req.user.role === 'owner' ? {} : { user: req.user._id };
  let ev = b.eventId ? await OutreachEvent.findOne({ _id: b.eventId, type: 'opened', ...mine }) : null; if (b.eventId && !ev) throw new HttpError(404, 'Outreach event not found or already answered');
  const l = await getLead(req, ev ? ev.lead : b.leadId);
  if (!ev) ev = await OutreachEvent.findOne({ lead: l._id, type: 'opened', user: req.user._id, at: { $gt: new Date(Date.now() - 864e5) } }).sort('-at');
  const base = { lead: l._id, user: req.user._id, department: l.department, campaign: l.campaign, channel: b.channel, template: b.templateId, message: b.message };
  if (!b.sent) { // "Not sent" never counts toward the lead, the day's goal or any report
    if (ev) { ev.type = 'not_sent'; await ev.save(); } else await OutreachEvent.create({ ...base, type: 'not_sent' });
    if (l.status === 'Outreach Opened' && !(await OutreachEvent.exists({ lead: l._id, type: 'opened' }))) { l.status = 'New'; await l.save(); }
    await log(req, 'outreach.not_sent', 'Lead', l._id, {}, l.department); return res.json({ ok: true, counted: false });
  }
  if (['Do Not Contact', 'Invalid Contact'].includes(l.status)) throw new HttpError(422, `This lead is marked "${l.status}"`);
  const recent = await OutreachEvent.findOne({ lead: l._id, user: req.user._id, type: 'confirmed_sent', at: { $gt: new Date(Date.now() - 60e3) } }); // double click guard
  if (recent) { if (ev) await ev.deleteOne(); return res.json({ ok: true, counted: true, duplicate: true, eventId: recent._id }); }
  if (ev) { ev.type = 'confirmed_sent'; ev.at = new Date(); ev.channel = b.channel; if (b.message) ev.message = b.message; await ev.save(); } else ev = await OutreachEvent.create({ ...base, type: 'confirmed_sent' });
  const next = await completeOutreach(req, l); await log(req, 'outreach.confirmed', 'Lead', l._id, { channel: b.channel }, l.department); res.json({ ok: true, counted: true, eventId: ev._id, nextFollowUpAt: next?.dueAt || null });
}));
// Changed your mind after "Yes"? Within 24 hours it can be undone: it stops counting and the lead goes back if it was only contacted by this message.
r.post('/undo', wrap(async (req, res) => {
  const { eventId } = z.object({ eventId: z.string() }).parse(req.body);
  const ev = await OutreachEvent.findOne({ _id: eventId, type: 'confirmed_sent', at: { $gt: new Date(Date.now() - 864e5) }, ...(req.user.role === 'owner' ? {} : { user: req.user._id }) }); if (!ev) throw new HttpError(404, 'Nothing to undo. Only the last 24 hours can be undone.');
  const l = await getLead(req, ev.lead); ev.type = 'not_sent'; await ev.save(); const left = await OutreachEvent.find({ lead: l._id, type: 'confirmed_sent' }).sort('-at').limit(1);
  if (!left.length) { l.contactedAt = undefined; l.lastContactedAt = undefined; if (l.status === 'Contacted') l.status = 'New'; await FollowUp.updateMany({ lead: l._id, status: { $in: OPEN } }, { status: 'Cancelled' }); } else l.lastContactedAt = left[0].at;
  await l.save(); await refreshNext(l._id); await log(req, 'outreach.undone', 'Lead', l._id, {}, l.department); res.json({ ok: true });
}));
r.get('/history', wrap(async (req, res) => { const f = req.user.role === 'owner' ? {} : { user: req.user._id, department: { $in: req.user.departments } }; if (req.query.leadId) f.lead = String(req.query.leadId);
  res.json({ items: await OutreachEvent.find(f).sort('-at').limit(100).populate({ path: 'lead', populate: 'business' }) }); }));
export default r;
