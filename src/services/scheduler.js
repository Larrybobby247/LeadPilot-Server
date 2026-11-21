import { User, ReminderLog, Notification } from '../models/index.js';
import { reminderSettings, goalsOn, finalizeBefore, weekly } from './goalsDb.js';
import { pickReminder, reminderEmail, weeklyEmail, NAMES } from './goals.js';
import { dateKey, localHM, weekdayOf, weekStartKey, addDays } from './time.js';
import { sendEmail } from './email.js';
import { config } from '../config.js';

const recipient = (u) => u.goals?.reminderEmail || (u.role === 'owner' && config.reminderEmail) || u.email;
// Claim = insert the unique (user, kind, day) row. Whoever inserts it sends; restarts and parallel instances cannot double-send.
async function claim(user, kind, key, to) {
  try { return await ReminderLog.create({ user: user._id, kind, dateKey: key, to }); }
  catch (e) { if (e.code !== 11000) throw e; return ReminderLog.findOneAndUpdate({ user: user._id, kind, dateKey: key, status: 'failed', attempts: { $lt: 3 } }, { status: 'sending', $inc: { attempts: 1 } }, { new: true }); }
}
async function deliver(log, { subject, html }) {
  if (!config.resendKey) { log.status = 'skipped'; log.error = 'No email provider configured (set RESEND_API_KEY)'; await log.save(); return false; }
  const ok = await sendEmail({ to: log.to, subject, html }); log.status = ok ? 'sent' : 'failed'; log.error = ok ? undefined : 'Email provider rejected the request'; await log.save(); return ok;
}
export async function tick(now = new Date()) {
  const s = await reminderSettings(); const tz = s.timezone; const key = dateKey(now, tz); const hm = localHM(now, tz); const sent = { daily: 0, weekly: 0 };
  const users = await User.find({ active: true, 'goals.schedule.0': { $exists: true } });
  for (const u of users) {
    try {
      await finalizeBefore(u, key, tz); const today = await goalsOn(u, key, tz, { lock: true });
      if (s.enabled && u.goals.remindersEnabled && !today.restDay) {
        const prior = await ReminderLog.find({ user: u._id, dateKey: key, kind: { $in: ['daily1', 'daily2'] } }); const done = new Set(prior.filter((p) => ['sent', 'skipped', 'sending'].includes(p.status) || p.attempts >= 3).map((p) => p.kind));
        const kind = pickReminder({ hm, times: { first: s.first, second: s.second }, goals: today.goals, sent: done });
        if (kind) { const log = await claim(u, kind, key, recipient(u)); if (log) { const mail = reminderEmail({ name: u.name, goals: today.goals, appUrl: config.appUrl }); log.summary = { goals: today.goals }; await Notification.create({ user: u._id, type: 'goal_reminder', title: 'Your daily outreach goal is incomplete', body: today.goals.map((g) => `${NAMES[g.campaign]}: ${g.completed}/${g.target}`).join(', '), link: '/' }).catch(() => {}); await deliver(log, mail); sent.daily++; } }
      }
      if (s.enabled && u.goals.weeklyReportEnabled && weekdayOf(key) === 0 && hm >= s.weeklyTime) {
        const log = await claim(u, 'weekly', key, recipient(u)); if (log) { const week = await weekly(u, weekStartKey(key), tz); let mail = weeklyEmail({ name: u.name, week, appUrl: config.appUrl });
          if (u.role === 'owner') { const team = []; for (const m of await User.find({ active: true, role: 'member', 'goals.schedule.0': { $exists: true } })) { const w = await weekly(m, weekStartKey(key), tz); team.push(`${m.name}: ${w.completed} of ${w.target} (${w.rate}%)`); } if (team.length) { const text = mail.text + '\n\nTeam breakdown:\n' + team.join('\n'); mail = { ...mail, text, html: text.split('\n\n').map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('') }; } }
          log.summary = { target: week.target, completed: week.completed, rate: week.rate }; await deliver(log, mail); sent.weekly++; } }
    } catch (e) { console.error('scheduler error for user', String(u._id), e.message); }
  }
  return sent;
}
let timer = null;
export function startScheduler() { if (timer) return; const run = () => tick().catch((e) => console.error('scheduler tick failed', e.message)); setTimeout(run, 5000); timer = setInterval(run, 60000); timer.unref?.(); }
