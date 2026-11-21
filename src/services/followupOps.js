import { FollowUp, Lead, Setting } from '../models/index.js';
import { dueDate, canFollowUp, DEFAULT_INTERVALS } from './followups.js';
export const OPEN = ['Pending', 'Rescheduled'];
export async function refreshNext(leadId) { const f = await FollowUp.findOne({ lead: leadId, status: { $in: OPEN } }).sort('dueAt'); await Lead.updateOne({ _id: leadId }, { nextFollowUpAt: f?.dueAt || null }); }
// Schedules the next step in the sequence. Never for closed statuses, paused leads, or when one is already open.
export async function scheduleNext(lead, from = new Date()) {
  if (!canFollowUp(lead.status) || lead.followUpsPaused || lead.archived) return null;
  if (await FollowUp.exists({ lead: lead._id, status: { $in: OPEN } })) return null;
  const s = await Setting.findOne({ key: 'global' }); const step = await FollowUp.countDocuments({ lead: lead._id, status: 'Completed' });
  const due = dueDate(from, step, s?.followUpIntervals?.length ? s.followUpIntervals : DEFAULT_INTERVALS); if (!due) return null;
  const f = await FollowUp.create({ lead: lead._id, user: lead.assignedTo, department: lead.department, campaign: lead.campaign, dueAt: due, step }); await refreshNext(lead._id); return f;
}
