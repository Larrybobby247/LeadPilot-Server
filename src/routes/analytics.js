import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { DEPARTMENTS } from '../config.js';
import { Lead, FollowUp, OutreachEvent, User, Campaign, ActivityLog } from '../models/index.js';
import { wrap, requireAuth, requireOwner, leadScope, departmentFilter } from '../middleware/auth.js';
import { OPEN } from '../services/followupOps.js';

const r = Router(); r.use(requireAuth);
const O = (id) => new mongoose.Types.ObjectId(id);
const qs = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), department: z.enum(DEPARTMENTS).optional(), userId: z.string().optional(), campaign: z.string().optional(), source: z.string().optional() });
function scope(req, q) { // members are always limited to themselves, whatever the query says
  const f = leadScope(req.user, departmentFilter(req.user, q.department)); if (req.user.role === 'owner' && q.userId) f.assignedTo = O(q.userId);
  if (req.user.role !== 'owner') f.assignedTo = req.user._id; if (q.campaign) f.campaign = O(q.campaign); if (q.source) f.source = q.source; f.archived = false; return f; }
const rangeOf = (q) => { const d = {}; if (q.from) d.$gte = q.from; if (q.to) d.$lte = q.to; return Object.keys(d).length ? d : null; };
const range = (q) => { const d = {}; if (q.from) d.$gte = q.from; if (q.to) d.$lte = q.to; return Object.keys(d).length ? d : null; };
// Definitions: "contacted" = first CONFIRMED send (never a WhatsApp open). Stage metrics count the first time a lead reached that stage.
// Interested != converted. Demo requested != sale. Duplicate imports never create leads, so they are never counted.
async function metrics(f, q) {
  const rg = range(q); const inR = (field) => (rg ? { ...f, [field]: rg } : { ...f, [field]: { $ne: null } });
  const ids = (await Lead.find(f).select('_id').limit(50000)).map((l) => l._id);
  const ev = { lead: { $in: ids }, ...(rg && { at: rg }) };
  const [discovered, contactReady, contacted, responded, interested, demoRequested, demoSent, negotiating, converted, invalid, noResponse, confirmedMsgs, opens, fuDone, fuOverdue] = await Promise.all([
    Lead.countDocuments(rg ? { ...f, discoveredAt: rg } : f),
    Lead.aggregate([{ $match: rg ? { ...f, discoveredAt: rg } : f }, { $lookup: { from: 'businesses', localField: 'business', foreignField: '_id', as: 'b' } }, { $match: { 'b.phones.0': { $exists: true } } }, { $count: 'n' }]).then((x) => x[0]?.n || 0),
    Lead.countDocuments(inR('contactedAt')), Lead.countDocuments(inR('respondedAt')), Lead.countDocuments(inR('interestedAt')), Lead.countDocuments(inR('demoRequestedAt')), Lead.countDocuments(inR('demoSentAt')), Lead.countDocuments(inR('negotiatingAt')), Lead.countDocuments(inR('convertedAt')),
    Lead.countDocuments({ ...f, status: 'Invalid Contact' }), Lead.countDocuments({ ...f, status: 'No Response' }),
    OutreachEvent.countDocuments({ ...ev, type: 'confirmed_sent' }), OutreachEvent.countDocuments({ ...ev, type: 'opened' }),
    FollowUp.countDocuments({ lead: { $in: ids }, status: 'Completed', ...(rg && { completedAt: rg }) }), FollowUp.countDocuments({ lead: { $in: ids }, status: { $in: OPEN }, dueAt: { $lt: new Date() } })]);
  const rate = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  return { discovered, contactReady, contacted, responded, interested, demoRequested, demoSent, negotiating, converted, invalid, noResponse, confirmedMessages: confirmedMsgs, opensNotCounted: opens, followUpsCompleted: fuDone, overdueFollowUps: fuOverdue, responseRate: rate(responded, contacted), conversionRate: rate(converted, contacted) };
}
r.get('/overview', wrap(async (req, res) => {
  const q = qs.parse(req.query); const f = scope(req, q); const m = await metrics(f, q);
  const days = Math.min(90, Math.max(1, Math.round(((q.to || new Date()) - (q.from || new Date(Date.now() - 7 * 864e5))) / 864e5) + 1)); const from = q.from || new Date(Date.now() - 6 * 864e5);
  const day = (field) => [{ $match: { ...f, [field]: { $gte: from, ...(q.to && { $lte: q.to }) } } }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: `$${field}` } }, n: { $sum: 1 } } }];
  const [d, c, rs] = await Promise.all([Lead.aggregate(day('discoveredAt')), Lead.aggregate(day('contactedAt')), Lead.aggregate(day('respondedAt'))]);
  const key = (a) => Object.fromEntries(a.map((x) => [x._id, x.n])); const D = key(d), C = key(c), R = key(rs); const series = [];
  for (let i = 0; i < days; i++) { const k = new Date(from.getTime() + i * 864e5).toISOString().slice(0, 10); series.push({ date: k, discovered: D[k] || 0, contacted: C[k] || 0, responses: R[k] || 0 }); }
  const funnel = ['New', 'Contacted', 'Responded', 'Interested', 'Demo Sent', 'Negotiating', 'Converted'].map((s) => ({ stage: s }));
  const sod = new Date(); sod.setHours(0, 0, 0, 0); const dup = await ActivityLog.aggregate([{ $match: { action: 'duplicate.prevented', ...(rangeOf(q) && { at: rangeOf(q) }), ...(req.user.role === 'owner' ? {} : { user: req.user._id }) } }, { $group: { _id: null, n: { $sum: '$metadata.count' } } }]);
  const extras = { newToday: await Lead.countDocuments({ ...f, discoveredAt: { $gte: sod } }), qualified: await Lead.countDocuments({ ...f, completenessBand: { $ne: 'low' } }), awaitingResponse: await Lead.countDocuments({ ...f, status: 'Contacted', respondedAt: null }), duplicatesPrevented: dup[0]?.n || 0 };
  res.json({ metrics: m, extras, series, funnel: [{ stage: 'Discovered', n: m.discovered }, { stage: 'Contacted', n: m.contacted }, { stage: 'Responded', n: m.responded }, { stage: 'Interested', n: m.interested }, { stage: 'Demo sent', n: m.demoSent }, { stage: 'Negotiating', n: m.negotiating }, { stage: 'Converted', n: m.converted }] });
}));
r.get('/departments', requireOwner, wrap(async (req, res) => { const q = qs.parse(req.query); const items = []; for (const d of DEPARTMENTS) items.push({ department: d, ...(await metrics(scope(req, { ...q, department: d }), q)) }); res.json({ items }); }));
r.get('/team', requireOwner, wrap(async (req, res) => { const q = qs.parse(req.query); const users = await User.find({ role: 'member' }); const items = [];
  for (const u of users) items.push({ userId: u._id, name: u.name, active: u.active, ...(await metrics(scope(req, { ...q, userId: String(u._id) }), q)) }); res.json({ items }); }));
r.get('/campaigns', wrap(async (req, res) => { const q = qs.parse(req.query); const cs = await Campaign.find(req.user.role === 'owner' ? {} : { department: { $in: req.user.departments }, $or: [{ assignedTo: req.user._id }, { createdBy: req.user._id }] }); const items = [];
  for (const c of cs) items.push({ id: c._id, name: c.name, department: c.department, status: c.status, ...(await metrics(scope(req, { ...q, campaign: String(c._id), department: c.department }), q)) }); res.json({ items }); }));
export default r;
