import { User, OutreachEvent, DailyGoalRecord, Setting, Lead, FollowUp } from '../models/index.js';
import { goalsForWeekday, progress, streak, weekSummary } from './goals.js';
import { dateKey, dayStart, dayEnd, weekdayOf, addDays, hoursLeft, weekStartKey } from './time.js';
import { OPEN } from './followupOps.js';

export async function reminderSettings() { const s = await Setting.findOne({ key: 'global' }); const r = s?.reminders || {};
  return { enabled: r.enabled ?? true, first: r.firstTime || '17:00', second: r.secondTime || '19:00', weeklyTime: r.weeklyTime || '18:00', timezone: r.timezone || 'Africa/Lagos' }; }
// Qualifying outreach = recorded (confirmed) sends. One prospect counts once per campaign per day, however many messages or edits.
export async function countByCampaign(userId, from, to) {
  const rows = await OutreachEvent.aggregate([{ $match: { user: userId, type: 'confirmed_sent', at: { $gte: from, $lt: to } } }, { $group: { _id: { d: '$department', l: '$lead' } } }, { $group: { _id: '$_id.d', n: { $sum: 1 } } }]);
  return Object.fromEntries(rows.map((r) => [r._id, r.n]));
}
async function snapshot(user, key, entry) { // locks the day's target the first time the day is seen
  try { return await DailyGoalRecord.findOneAndUpdate({ user: user._id, date: key, campaign: entry.campaign }, { $setOnInsert: { target: entry.target } }, { upsert: true, new: true }); }
  catch (e) { if (e.code === 11000) return DailyGoalRecord.findOne({ user: user._id, date: key, campaign: entry.campaign }); throw e; }
}
export async function goalsOn(user, key, tz, { lock = false } = {}) {
  const wd = weekdayOf(key); const sched = goalsForWeekday(user.goals?.schedule, wd); const existing = await DailyGoalRecord.find({ user: user._id, date: key });
  const entries = sched.map((e) => ({ campaign: e.campaign, target: existing.find((r) => r.campaign === e.campaign)?.target ?? e.target }));
  for (const r of existing) if (!entries.some((e) => e.campaign === r.campaign) && key < dateKey(new Date(), tz)) entries.push({ campaign: r.campaign, target: r.target }); // past days keep what was recorded then
  if (lock) for (const e of entries) await snapshot(user, key, e);
  const counts = await countByCampaign(user._id, dayStart(key, tz), dayEnd(key, tz));
  return { restDay: !entries.length, goals: entries.map((e) => ({ ...e, completed: counts[e.campaign] || 0, ...progress(e.target, counts[e.campaign] || 0) })) };
}
export async function syncToday(user, tz) { // schedule edits apply from today onward; earlier days are never rewritten
  const key = dateKey(new Date(), tz); const sched = goalsForWeekday(user.goals?.schedule, weekdayOf(key)); const have = await DailyGoalRecord.find({ user: user._id, date: key, finalized: false });
  for (const e of sched) await DailyGoalRecord.findOneAndUpdate({ user: user._id, date: key, campaign: e.campaign }, { $set: { target: e.target } }, { upsert: true });
  for (const r of have) if (!sched.some((e) => e.campaign === r.campaign)) await DailyGoalRecord.deleteOne({ _id: r._id });
}
export async function finalizeBefore(user, todayKey, tz) {
  const open = await DailyGoalRecord.find({ user: user._id, date: { $lt: todayKey }, finalized: false });
  for (const r of open) { const c = await countByCampaign(user._id, dayStart(r.date, tz), dayEnd(r.date, tz)); r.completed = c[r.campaign] || 0; r.met = r.completed >= r.target; r.finalized = true; await r.save(); }
}
export async function streakFor(user, tz) {
  const key = dateKey(new Date(), tz); await finalizeBefore(user, key, tz); const recs = await DailyGoalRecord.find({ user: user._id, date: { $lt: key }, finalized: true }).sort('-date').limit(120);
  const days = {}; for (const r of recs) days[r.date] = (days[r.date] ?? true) && r.met; const list = Object.keys(days).sort().reverse().map((d) => ({ met: days[d] }));
  const today = await goalsOn(user, key, tz); const todayMet = today.goals.length && today.goals.every((g) => g.completed >= g.target); return streak(list) + (todayMet ? 1 : 0);
}
export async function lastOutreachAt(userId) { return (await OutreachEvent.findOne({ user: userId, type: 'confirmed_sent' }).sort('-at'))?.at || null; }
export async function todayView(user, tz) {
  const now = new Date(); const key = dateKey(now, tz); const g = await goalsOn(user, key, tz, { lock: true }); const done = g.goals.length > 0 && g.goals.every((x) => x.completed >= x.target);
  return { date: key, timezone: tz, restDay: g.restDay, goals: g.goals, completedAll: done, hoursLeft: Math.round(hoursLeft(now, key, tz) * 10) / 10, streak: await streakFor(user, tz), lastOutreachAt: await lastOutreachAt(user._id) };
}
export async function weekly(user, startKey, tz) {
  const rows = [], days = []; const today = dateKey(new Date(), tz);
  for (let i = 0; i < 7; i++) { const k = addDays(startKey, i); if (k > today) break; const g = await goalsOn(user, k, tz); for (const x of g.goals) { rows.push({ campaign: x.campaign, target: x.target, completed: x.completed }); days.push({ date: k, campaign: x.campaign, target: x.target, completed: x.completed, met: x.completed >= x.target }); } }
  const from = dayStart(startKey, tz), to = dayEnd(addDays(startKey, 6), tz); const f = { assignedTo: user._id, archived: false }; const inR = (field) => ({ ...f, [field]: { $gte: from, $lt: to } });
  const [collected, qualified, contacted, responded, interested, demoRequests, converted, followUpsDue] = await Promise.all([Lead.countDocuments(inR('discoveredAt')), Lead.countDocuments({ ...inR('discoveredAt'), completenessBand: { $ne: 'low' } }), Lead.countDocuments(inR('contactedAt')), Lead.countDocuments(inR('respondedAt')), Lead.countDocuments(inR('interestedAt')), Lead.countDocuments(inR('demoRequestedAt')), Lead.countDocuments(inR('convertedAt')),
    FollowUp.countDocuments({ user: user._id, status: { $in: OPEN }, dueAt: { $lt: dayEnd(today, tz) } })]);
  return { weekStart: startKey, ...weekSummary(rows), days, leads: { collected, qualified, contacted, responded, interested, demoRequests, converted, followUpsDue } };
}
export { weekStartKey };
