import { STAGE_STAMP, NO_FOLLOWUP_STATUSES } from '../config.js';
import { FollowUp } from '../models/index.js';
import { log, notify } from './activity.js';
// Single path for changing a lead's status (manual edits and confirmed AI recommendations both use it).
export async function applyStatus(req, lead, status, meta = {}) {
  const previous = lead.status; if (previous === status) return previous;
  lead.status = status; const stamp = STAGE_STAMP[status]; if (stamp && !lead[stamp]) lead[stamp] = new Date();
  if (['Responded', 'Interested', 'Demo Requested', 'Pricing Requested', 'Information Requested', 'Objection Raised', 'Follow-up Required', 'Negotiating', 'Converted'].includes(status) && !lead.respondedAt) lead.respondedAt = new Date();
  if (NO_FOLLOWUP_STATUSES.includes(status)) { await FollowUp.updateMany({ lead: lead._id, status: { $in: ['Pending', 'Rescheduled'] } }, { status: 'Cancelled' }); lead.nextFollowUpAt = undefined; }
  await lead.save(); await log(req, 'lead.status_changed', 'Lead', lead._id, { from: previous, to: status, ...meta }, lead.department);
  if (status === 'Converted') await notify(req.user._id, 'lead_converted', 'Lead converted', undefined, `/leads/${lead._id}`); return previous;
}
