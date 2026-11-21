import { Router } from 'express';
import { z } from 'zod';
import { DEPARTMENTS } from '../config.js';
import { User, Setting, ReminderLog, DailyGoalRecord } from '../models/index.js';
import { HttpError, wrap, requireAuth, requireOwner } from '../middleware/auth.js';
import { validateSchedule, goalsForWeekday, progress } from '../services/goals.js';
import { reminderSettings, todayView, goalsOn, weekly, syncToday, lastOutreachAt, finalizeBefore } from '../services/goalsDb.js';
import { dateKey, isValidTz, weekStartKey } from '../services/time.js';
import { log } from '../services/activity.js';
import { tick } from '../services/scheduler.js';

const r = Router(); r.use(requireAuth);
const allowedFor = (u) => (u.role === 'owner' ? DEPARTMENTS : u.departments);
const sched = z.array(z.object({ day: z.number().int().min(0).max(6), campaign: z.string(), target: z.number().int().min(0).max(1000) })).max(28);
const settingsOf = (u) => ({ schedule: u.goals?.schedule || [], remindersEnabled: u.goals?.remindersEnabled ?? true, weeklyReportEnabled: u.goals?.weeklyReportEnabled ?? false, selfEditable: u.goals?.selfEditable ?? false, reminderEmail: u.goals?.reminderEmail || '', allowedCampaigns: allowedFor(u) });

r.get('/today', wrap(async (req, res) => res.json(await todayView(req.user, (await reminderSettings()).timezone))));
r.get('/me', (req, res) => res.json(settingsOf(req.user)));
r.put('/me', wrap(async (req, res) => { // members may only change their own targets, and only when the owner has allowed it
  if (!req.user.goals?.selfEditable) throw new HttpError(403, 'Your targets are set by the administrator'); const { schedule } = z.object({ schedule: sched }).parse(req.body); const cur = req.user.goals.schedule;
  const same = schedule.length === cur.length && schedule.every((e) => cur.some((c) => c.day === e.day && c.campaign === e.campaign)); if (!same) throw new HttpError(403, 'You can change targets but not the days or campaigns'); req.user.goals.schedule = schedule; await req.user.save(); await syncToday(req.user, (await reminderSettings()).timezone); await log(req, 'goals.updated', 'User', req.user._id, { self: true }); res.json(settingsOf(req.user)); }));
r.get('/user/:id', requireOwner, wrap(async (req, res) => { const u = await User.findById(req.params.id); if (!u) throw new HttpError(404, 'User not found'); res.json({ name: u.name, ...settingsOf(u) }); }));
r.put('/user/:id', requireOwner, wrap(async (req, res) => {
  const b = z.object({ schedule: sched.optional(), remindersEnabled: z.boolean().optional(), weeklyReportEnabled: z.boolean().optional(), selfEditable: z.boolean().optional(), reminderEmail: z.string().email().or(z.literal('')).optional() }).parse(req.body);
  const u = await User.findById(req.params.id); if (!u) throw new HttpError(404, 'User not found'); if (b.schedule) { const e = validateSchedule(b.schedule, allowedFor(u)); if (e) throw new HttpError(400, e); }
  const before = settingsOf(u); u.goals = { ...(u.goals?.toObject?.() || {}), ...b, reminderEmail: b.reminderEmail === '' ? undefined : b.reminderEmail ?? u.goals?.reminderEmail }; await u.save();
  await syncToday(u, (await reminderSettings()).timezone); await log(req, 'goals.updated', 'User', u._id, { before: { schedule: before.schedule }, after: b }); res.json({ name: u.name, ...settingsOf(u) });
}));
r.get('/team', requireOwner, wrap(async (req, res) => {
  const q = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), status: z.enum(['completed', 'incomplete', 'none']).optional(), campaign: z.enum(DEPARTMENTS).optional() }).parse(req.query);
  const tz = (await reminderSettings()).timezone; const key = q.date || dateKey(new Date(), tz); const rows = [];
  for (const u of await User.find({ active: true })) { const g = await goalsOn(u, key, tz); const goals = q.campaign ? g.goals.filter((x) => x.campaign === q.campaign) : g.goals; const target = goals.reduce((a, x) => a + x.target, 0), completed = goals.reduce((a, x) => a + x.completed, 0);
    if (q.campaign && !goals.length) continue; const p = progress(target, completed); const row = { id: u._id, name: u.name, role: u.role, campaigns: allowedFor(u), scheduled: goals.map((x) => x.campaign), restDay: g.restDay, goals, target, completed, remaining: p.remaining, percent: p.percent, status: g.restDay ? 'rest' : p.status, lastOutreachAt: await lastOutreachAt(u._id) };
    if (q.status === 'completed' && row.status !== 'completed') continue; if (q.status === 'incomplete' && !['in_progress', 'not_started'].includes(row.status)) continue; if (q.status === 'none' && !(row.status === 'not_started')) continue; rows.push(row); }
  res.json({ date: key, items: rows });
}));
r.get('/weekly', wrap(async (req, res) => { const q = z.object({ userId: z.string().optional(), weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query); const tz = (await reminderSettings()).timezone;
  let u = req.user; if (q.userId && q.userId !== String(req.user._id)) { if (req.user.role !== 'owner') throw new HttpError(403, 'Not allowed'); u = await User.findById(q.userId); if (!u) throw new HttpError(404, 'User not found'); }
  res.json({ name: u.name, ...(await weekly(u, q.weekStart || weekStartKey(dateKey(new Date(), tz)), tz)) }); }));
r.get('/history', wrap(async (req, res) => { const tz = (await reminderSettings()).timezone; let u = req.user; if (req.query.userId && String(req.query.userId) !== String(req.user._id)) { if (req.user.role !== 'owner') throw new HttpError(403, 'Not allowed'); u = await User.findById(String(req.query.userId)); }
  await finalizeBefore(u, dateKey(new Date(), tz), tz); res.json({ items: await DailyGoalRecord.find({ user: u._id, finalized: true }).sort('-date').limit(60) }); }));

const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
r.get('/settings', requireOwner, wrap(async (_q, res) => res.json(await reminderSettings())));
r.put('/settings', requireOwner, wrap(async (req, res) => {
  const b = z.object({ enabled: z.boolean(), first: hm, second: hm, weeklyTime: hm, timezone: z.string() }).parse(req.body); if (!isValidTz(b.timezone)) throw new HttpError(400, 'Unknown timezone'); if (b.first >= b.second) throw new HttpError(400, 'The second reminder must be later than the first');
  await Setting.updateOne({ key: 'global' }, { $set: { reminders: { enabled: b.enabled, firstTime: b.first, secondTime: b.second, weeklyTime: b.weeklyTime, timezone: b.timezone } } }, { upsert: true }); await log(req, 'settings.updated', 'Setting', undefined, { reminders: b }); res.json(await reminderSettings()); }));
r.get('/reminders', requireOwner, wrap(async (_q, res) => { const items = await ReminderLog.find().sort('-createdAt').limit(100).populate('user', 'name'); res.json({ items: items.map((x) => ({ id: x._id, user: x.user?.name, kind: x.kind, dateKey: x.dateKey, status: x.status, attempts: x.attempts, to: x.to, error: x.error, at: x.updatedAt })) }); }));
r.post('/reminders/run', requireOwner, wrap(async (_q, res) => res.json(await tick()))); // manual trigger; the same idempotency rules apply
export default r;
