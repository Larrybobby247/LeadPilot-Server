import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import crypto from 'node:crypto';
import { Lead, AiMessage, ConversationEntry, MessageTemplate, Setting, OutreachEvent } from '../models/index.js';
import { HttpError, wrap, requireAuth, requireOwner, leadScope } from '../middleware/auth.js';
import { generateText, AiError, KINDS, TONES } from '../services/ai.js';
import { geminiUsage } from '../services/aiUsage.js';
import { domainOf } from '../services/dedupe.js';
import { config } from '../config.js';
import { log } from '../services/activity.js';

const r = Router(); r.use(requireAuth);
const aiLimit = rateLimit({ windowMs: 60e3, limit: 15, keyGenerator: (req) => String(req.user?._id || req.ip), standardHeaders: true, legacyHeaders: false, validate: false, message: { message: 'Too many AI requests. Wait a minute and try again.' } });

// Only the facts the model may use. No phone numbers or emails are ever sent to Gemini.
export async function leadContext(req, lead) {
  const s = await Setting.findOne({ key: 'global' }); const b = lead.business; const [conv, outreach] = await Promise.all([ConversationEntry.find({ lead: lead._id }).sort('-receivedAt').limit(3), OutreachEvent.countDocuments({ lead: lead._id, type: 'confirmed_sent' })]);
  return { business: { name: b.name, category: b.category, city: b.city, state: b.state, websiteDomain: domainOf(b.website), hasSocial: !!(b.instagram || b.facebook || b.linkedin), description: b.description }, contactPerson: lead.contactPerson, status: lead.status, senderName: req.user.name, product: s?.products?.[lead.department] || {},
    notes: (lead.notes || []).slice(-3).map((n) => n.text), history: [outreach ? `${outreach} message(s) sent so far` : 'No message sent yet', ...conv.map((c) => `Prospect intent earlier: ${c.analysis?.intent || 'unknown'}`)] };
}
export const loadLead = async (req, id) => { const l = await Lead.findOne(leadScope(req.user, { _id: id })).populate('business'); if (!l) throw new HttpError(404, 'Lead not found'); return l; };
const aiErr = (e) => (e instanceof AiError ? new HttpError(e.status, e.message, { code: e.kind }) : e);
export const templatize = (text, v) => { let t = text; for (const [val, tag] of [[v.business, '{{business_name}}'], [v.contact, '{{contact_name}}'], [v.city, '{{city}}'], [v.sender, '{{sender_name}}']]) if (val && val.length > 1) t = t.split(val).join(tag); return t; };
const PURPOSE = { initial: 'initial_outreach', followup: 'no_response_followup', interested: 'interested_prospect', more_info: 'introduction', later: 'no_response_followup', not_interested: 'final_followup', custom: 'initial_outreach' };

r.get('/options', (_q, res) => res.json({ kinds: Object.keys(KINDS), tones: Object.keys(TONES), configured: !!config.geminiKey, model: config.geminiModel }));
r.post('/generate', aiLimit, wrap(async (req, res) => {
  const b = z.object({ leadId: z.string(), kind: z.enum(Object.keys(KINDS)), tone: z.enum(Object.keys(TONES)).default('friendly'), instructions: z.string().max(500).optional(), regenerate: z.boolean().optional() }).parse(req.body);
  if (b.kind === 'custom' && !b.instructions?.trim()) throw new HttpError(400, 'Describe the message you want');
  const lead = await loadLead(req, b.leadId); const ctx = await leadContext(req, lead);
  const cacheKey = crypto.createHash('sha256').update(JSON.stringify([lead._id, b.kind, b.tone, b.instructions || '', lead.updatedAt, lead.notes.length, ctx.product, lead.status, req.user._id])).digest('hex');
  if (!b.regenerate) { const hit = await AiMessage.findOne({ cacheKey, createdAt: { $gt: new Date(Date.now() - 864e5) } }); if (hit) return res.json({ id: hit._id, text: hit.text, cached: true, productInfoMissing: !ctx.product.description }); }
  let out; try { out = await generateText(ctx, b); } catch (e) { throw aiErr(e); }
  const m = await AiMessage.create({ lead: lead._id, user: req.user._id, department: lead.department, kind: b.kind, tone: b.tone, instructions: b.instructions, cacheKey, text: out.text, tokens: out.tokens });
  await log(req, 'ai.message_generated', 'Lead', lead._id, { kind: b.kind, tone: b.tone }, lead.department); res.json({ id: m._id, text: m.text, cached: false, productInfoMissing: !ctx.product.description });
}));
r.get('/messages', wrap(async (req, res) => { const lead = await loadLead(req, String(req.query.leadId)); res.json({ items: await AiMessage.find({ lead: lead._id, user: req.user._id }).sort('-createdAt').limit(20).select('-cacheKey') }); }));
r.post('/messages/:id/save-template', wrap(async (req, res) => {
  const { name } = z.object({ name: z.string().trim().min(2).max(120) }).parse(req.body); const m = await AiMessage.findOne({ _id: req.params.id, user: req.user._id }); if (!m) throw new HttpError(404, 'Message not found');
  const lead = await loadLead(req, m.lead); const t = await MessageTemplate.create({ name, department: m.department, category: lead.business.category || 'General', purpose: PURPOSE[m.kind] || 'initial_outreach', body: templatize(m.text, { business: lead.business.name, contact: lead.contactPerson, city: lead.business.city, sender: req.user.name }), scope: 'personal', owner: req.user._id });
  await log(req, 'template.created', 'MessageTemplate', t._id, { fromAi: true }, m.department); res.status(201).json(t);
}));
r.get('/usage', requireOwner, wrap(async (_q, res) => { const u = await geminiUsage(); res.json({ configured: !!config.geminiKey, model: config.geminiModel, requests: u.units, tokens: u.tokens, generated: u.generated, rateLimited: u.rateLimited, errors: (u.errors || []).slice(-5) }); }));
export default r;
