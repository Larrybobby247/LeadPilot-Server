import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { ConversationEntry, FollowUp, Setting } from '../models/index.js';
import { HttpError, wrap, requireAuth } from '../middleware/auth.js';
import { analyseMessage, AiError, followUpDate } from '../services/ai.js';
import { applyStatus } from '../services/leadStatus.js';
import { canFollowUp } from '../services/followups.js';
import { refreshNext } from '../services/followupOps.js';
import { loadLead, leadContext } from './ai.js';
import { reminderSettings } from '../services/goalsDb.js';
import { log } from '../services/activity.js';

const r = Router(); r.use(requireAuth);
const limit = rateLimit({ windowMs: 60e3, limit: 15, keyGenerator: (req) => String(req.user?._id || req.ip), validate: false, message: { message: 'Too many AI requests. Wait a minute and try again.' } });
const own = async (req) => { const e = await ConversationEntry.findById(req.params.id); if (!e) throw new HttpError(404, 'Entry not found'); const lead = await loadLead(req, e.lead); return { e, lead }; };

async function analyseInto(req, entry, lead) { // never changes the lead status: it only stores a recommendation
  const ctx = await leadContext(req, lead); const tz = (await reminderSettings()).timezone;
  try {
    const a = await analyseMessage(ctx, entry.received);
    entry.analysis = { intent: a.intent, explanation: a.explanation, nextAction: a.nextAction, confidence: a.confidence, followUpInDays: a.followUpInDays }; entry.reply = a.reply; entry.replyEdited = false; entry.aiFailed = false;
    entry.previousStatus = lead.status; entry.recommendedStatus = a.recommendedStatus && a.recommendedStatus !== lead.status ? a.recommendedStatus : undefined; entry.decision = entry.recommendedStatus ? 'pending' : 'none';
    const when = canFollowUp(lead.status) && a.followUpInDays ? followUpDate(a.followUpInDays, new Date(), tz) : null; entry.followUp = when ? { suggestedFor: when, state: 'pending' } : { state: 'none' };
    await entry.save(); if (!lead.respondedAt) { lead.respondedAt = new Date(); await lead.save(); } return null;
  } catch (e) { if (!(e instanceof AiError)) throw e; entry.aiFailed = true; await entry.save(); return new HttpError(e.status, e.message, { code: e.kind, entryId: entry._id }); }
}
const view = (e, lead) => ({ ...e.toObject(), reviewNeeded: !e.aiFailed && e.analysis && !e.recommendedStatus && e.decision === 'none', recommendation: e.recommendedStatus ? { from: e.previousStatus, to: e.recommendedStatus } : null, currentStatus: lead.status });

r.get('/', wrap(async (req, res) => { const lead = await loadLead(req, String(req.query.leadId)); const items = await ConversationEntry.find({ lead: lead._id }).sort('receivedAt'); res.json({ items: items.map((e) => view(e, lead)) }); }));
r.post('/analyse', limit, wrap(async (req, res) => {
  const { leadId, message } = z.object({ leadId: z.string(), message: z.string().trim().min(2).max(2000) }).parse(req.body); const lead = await loadLead(req, leadId);
  const entry = await ConversationEntry.create({ lead: lead._id, user: req.user._id, department: lead.department, received: message }); // saved before the AI call so nothing pasted is lost
  const err = await analyseInto(req, entry, lead); await log(req, 'conversation.analysed', 'Lead', lead._id, { intent: entry.analysis?.intent, failed: !!err }, lead.department);
  if (err) throw err; res.status(201).json(view(entry, lead));
}));
r.post('/:id/regenerate', limit, wrap(async (req, res) => { const { e, lead } = await own(req); if (e.decision === 'accepted') throw new HttpError(400, 'This analysis was already applied'); const err = await analyseInto(req, e, lead); if (err) throw err; res.json(view(e, lead)); }));
r.patch('/:id', wrap(async (req, res) => { const { reply } = z.object({ reply: z.string().trim().min(1).max(1500) }).parse(req.body); const { e, lead } = await own(req); e.reply = reply; e.replyEdited = true; await e.save(); await log(req, 'conversation.reply_edited', 'Lead', lead._id, {}, lead.department); res.json(view(e, lead)); }));
r.post('/:id/status', wrap(async (req, res) => { // the only way an AI recommendation changes a lead, and only on an explicit confirmation
  const { accept } = z.object({ accept: z.boolean() }).parse(req.body); const { e, lead } = await own(req); if (e.decision !== 'pending' || !e.recommendedStatus) throw new HttpError(400, 'There is no pending recommendation');
  if (accept) { const from = await applyStatus(req, lead, e.recommendedStatus, { via: 'ai', conversation: e._id }); e.previousStatus = from; e.appliedStatus = e.recommendedStatus; e.decision = 'accepted'; } else e.decision = 'rejected';
  await e.save(); await log(req, accept ? 'conversation.status_accepted' : 'conversation.status_rejected', 'Lead', lead._id, { recommended: e.recommendedStatus }, lead.department); res.json(view(e, lead));
}));
r.post('/:id/followup', wrap(async (req, res) => { // never scheduled silently: the user approves or edits the date
  const { approve, date } = z.object({ approve: z.boolean(), date: z.coerce.date().optional() }).parse(req.body); const { e, lead } = await own(req); if (e.followUp?.state !== 'pending') throw new HttpError(400, 'There is no pending follow-up suggestion');
  if (!approve) { e.followUp.state = 'dismissed'; await e.save(); return res.json(view(e, lead)); }
  const due = date || e.followUp.suggestedFor; if (!due || due < new Date(Date.now() - 36e5)) throw new HttpError(400, 'Choose a date in the future'); if (!canFollowUp(lead.status)) throw new HttpError(422, `Follow-ups are not scheduled for "${lead.status}" leads`);
  const f = await FollowUp.create({ lead: lead._id, user: lead.assignedTo, department: lead.department, campaign: lead.campaign, dueAt: due, note: 'From conversation analysis', step: await FollowUp.countDocuments({ lead: lead._id, status: 'Completed' }) });
  await refreshNext(lead._id); e.followUp.state = 'approved'; e.followUp.followUpId = f._id; e.followUp.suggestedFor = due; await e.save(); await log(req, 'followup.scheduled', 'Lead', lead._id, { via: 'ai', dueAt: due }, lead.department); res.json(view(e, lead));
}));
export default r;
