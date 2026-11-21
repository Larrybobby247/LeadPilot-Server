import { NO_FOLLOWUP_STATUSES } from '../config.js';
export const DEFAULT_INTERVALS = [2, 4, 7];
export const canFollowUp = (status) => !NO_FOLLOWUP_STATUSES.includes(status);
export function dueDate(from, step, intervals = DEFAULT_INTERVALS) {
  if (step >= intervals.length) return null; const d = new Date(from); d.setUTCDate(d.getUTCDate() + intervals[step]); return d;
}
