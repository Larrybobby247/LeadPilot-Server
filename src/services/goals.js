import { DEPARTMENTS } from '../config.js';
export const NAMES = { ordarly: 'Ordarly', keykonnec: 'KeyKonnec', website: 'Website Outreach' };
export const DEFAULT_WEEK = [{ day: 1, campaign: 'ordarly' }, { day: 2, campaign: 'keykonnec' }, { day: 3, campaign: 'ordarly' }, { day: 4, campaign: 'keykonnec' }, { day: 5, campaign: 'website' }, { day: 6, campaign: 'keykonnec' }]; // Sunday (0) = rest and weekly review
// All three campaigns -> the default week. Fewer -> only their campaigns, Mon-Sat, alternating. Sunday stays a rest day either way.
export function buildSchedule(departments, target) {
  const ds = DEPARTMENTS.filter((d) => departments.includes(d)); if (!ds.length) return [];
  const week = ds.length === DEPARTMENTS.length ? DEFAULT_WEEK : [1, 2, 3, 4, 5, 6].map((day, i) => ({ day, campaign: ds[i % ds.length] }));
  return week.map((e) => ({ ...e, target }));
}
export function validateSchedule(schedule, allowed) {
  if (!Array.isArray(schedule) || schedule.length > 28) return 'Invalid schedule';
  for (const e of schedule) { if (!Number.isInteger(e.day) || e.day < 0 || e.day > 6) return 'Invalid day'; if (e.campaign !== 'rest' && !allowed.includes(e.campaign)) return `${e.campaign} is not assigned to this user`; if (!Number.isInteger(e.target) || e.target < 0 || e.target > 1000) return 'Targets must be whole numbers from 0 to 1000'; }
  return null;
}
export const goalsForWeekday = (schedule = [], weekday) => schedule.filter((e) => e.day === weekday && e.campaign !== 'rest' && e.target > 0);
export function progress(target, completed) { const remaining = Math.max(0, target - completed); return { remaining, percent: target ? Math.min(100, Math.round((completed / target) * 100)) : 0, status: completed >= target ? 'completed' : completed > 0 ? 'in_progress' : 'not_started' }; }
// records: newest first, only days that HAD a goal. Rest days have no record and do not break a streak.
export function streak(records) { let n = 0; for (const r of records) { if (r.met) n++; else break; } return n; }
export function pickReminder({ hm, times, goals, sent }) { // goals: [{target, completed}]
  if (!goals.length || goals.every((g) => g.completed >= g.target)) return null;
  if (hm >= times.second && !sent.has('daily2')) return 'daily2'; if (hm >= times.first && hm < times.second && !sent.has('daily1')) return 'daily1'; return null;
}
const list = (gs) => gs.map((g) => `${NAMES[g.campaign] || g.campaign}: ${g.completed} of ${g.target} done, ${Math.max(0, g.target - g.completed)} to go`).join('\n');
export function reminderEmail({ name, goals, appUrl }) {
  const left = goals.reduce((a, g) => a + Math.max(0, g.target - g.completed), 0); const none = goals.every((g) => g.completed === 0);
  const text = `Hello ${name || ''},\n\n${none ? 'You have not recorded any outreach on LeadPilot today.' : 'Your outreach target for today is not yet complete.'}\n\n${list(goals)}\n\nYou still have ${left} prospect${left === 1 ? '' : 's'} to contact to complete today's target.\n\nOpen LeadPilot and continue your outreach: ${appUrl}\n\nConsistency is what builds results!`;
  return { subject: 'LeadPilot - Your Daily Outreach Goal Is Incomplete', text, html: text.split('\n\n').map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('') };
}
export function weeklyEmail({ name, week, appUrl }) { // week: {target, completed, rate, byCampaign:[{campaign,target,completed}], strongest, weakest}
  const lines = [`Weekly target: ${week.target}`, `Completed: ${week.completed}`, `Completion rate: ${week.rate}%`];
  if (week.strongest) lines.push(`Your strongest campaign this week: ${NAMES[week.strongest] || week.strongest}`); if (week.weakest && week.weakest !== week.strongest) lines.push(`Your next priority: Improve consistency with your ${NAMES[week.weakest] || week.weakest} outreach.`);
  const text = `Hello ${name || ''},\n\nYour weekly outreach report is ready.\n\n${lines.join('\n')}\n\nReview your weekly progress in LeadPilot: ${appUrl}`;
  return { subject: 'LeadPilot - Your Weekly Outreach Report', text, html: text.split('\n\n').map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('') };
}
export function weekSummary(rows) { // rows: [{campaign,target,completed}] across the week's goal days
  const by = {}; for (const r of rows) { by[r.campaign] ||= { campaign: r.campaign, target: 0, completed: 0 }; by[r.campaign].target += r.target; by[r.campaign].completed += r.completed; }
  const byCampaign = Object.values(by); const target = byCampaign.reduce((a, b) => a + b.target, 0); const completed = byCampaign.reduce((a, b) => a + b.completed, 0);
  const ratio = (c) => (c.target ? c.completed / c.target : 0); const sorted = [...byCampaign].sort((a, b) => ratio(b) - ratio(a));
  return { target, completed, rate: target ? Math.round((completed / target) * 1000) / 10 : 0, byCampaign, strongest: sorted[0]?.completed ? sorted[0].campaign : null, weakest: sorted.length > 1 ? sorted[sorted.length - 1].campaign : null };
}
