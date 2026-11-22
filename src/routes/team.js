import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config, DEPARTMENTS } from '../config.js';
import { User, Invitation, Lead } from '../models/index.js';
import { HttpError, wrap, requireAuth, requireOwner } from '../middleware/auth.js';
import { randomToken, sha256 } from '../utils/crypto.js';
import { log, notify } from '../services/activity.js';
import { sendEmail } from '../services/email.js';
import { passwordRule, startSession } from './auth.js';
import { buildSchedule, validateSchedule } from '../services/goals.js';
import { STATE_NAMES } from '../data/nigeria.js';

const r = Router();
const dep = z.array(z.enum(DEPARTMENTS)).min(1);
const makeInvite = async (inv) => { const token = randomToken(); inv.tokenHash = sha256(token); inv.expiresAt = new Date(Date.now() + 72 * 3600e3); await inv.save(); return `${config.appUrl}/accept-invitation?token=${token}`; };

// Public: check and accept an invitation
r.get('/invitations/check', wrap(async (req, res) => {
  const inv = await Invitation.findOne({ tokenHash: sha256(String(req.query.token || '')) }).populate('invitedBy', 'name');
  if (!inv) return res.json({ state: 'invalid' }); if (inv.status === 'accepted') return res.json({ state: 'used' });
  if (inv.status === 'revoked' || inv.expiresAt < new Date()) return res.json({ state: 'expired' });
  res.json({ state: 'valid', email: inv.email, name: inv.name, departments: inv.departments, invitedBy: inv.invitedBy?.name });
}));
r.post('/invitations/accept', wrap(async (req, res) => {
  const { token, name, password } = z.object({ token: z.string().min(20), name: z.string().trim().min(2).max(100), password: passwordRule }).parse(req.body);
  const inv = await Invitation.findOne({ tokenHash: sha256(token), status: 'pending', expiresAt: { $gt: new Date() } }); if (!inv) throw new HttpError(400, 'This invitation is invalid, used or expired');
  if (await User.exists({ email: inv.email })) throw new HttpError(409, 'An account with this email already exists');
  const user = await User.create({ name, email: inv.email, passwordHash: await bcrypt.hash(password, 12), role: inv.role, departments: inv.departments, states: inv.states || [], goals: { schedule: inv.goals?.schedule || [], remindersEnabled: inv.goals?.remindersEnabled ?? true, weeklyReportEnabled: inv.goals?.weeklyReportEnabled ?? false } });
  inv.status = 'accepted'; inv.acceptedAt = new Date(); await inv.save(); // single use
  if (inv.invitedBy) await notify(inv.invitedBy, 'invitation_accepted', `${name} accepted their invitation`, undefined, '/team');
  await log({ user, ip: req.ip }, 'invitation.accepted', 'Invitation', inv._id); res.json(await startSession(req, res, user));
}));

const admin = [requireAuth, requireOwner]; // applied per route: this router is mounted at /api and must not gate other routers
r.post('/invitations', ...admin, wrap(async (req, res) => {
  const b = z.object({ email: z.string().email(), name: z.string().trim().max(100).optional(), role: z.enum(['member', 'owner']).default('member'), departments: dep, states: z.array(z.enum(STATE_NAMES)).max(37).default([]),
    goals: z.object({ dailyTarget: z.number().int().min(1).max(1000), schedule: z.array(z.object({ day: z.number().int().min(0).max(6), campaign: z.string(), target: z.number().int().min(0).max(1000) })).max(28).optional(), remindersEnabled: z.boolean().default(true), weeklyReportEnabled: z.boolean().default(false) }) }).parse(req.body); // the target must be chosen by the owner: nothing is inherited
  if (b.role === 'member' && !b.states.length) throw new HttpError(400, 'Choose at least one state for this team member');
  const schedule = b.goals.schedule || buildSchedule(b.departments, b.goals.dailyTarget); const bad = validateSchedule(schedule, b.departments); if (bad) throw new HttpError(400, bad);
  if (await User.exists({ email: b.email.toLowerCase() })) throw new HttpError(409, 'A team member with this email already exists');
  await Invitation.updateMany({ email: b.email.toLowerCase(), status: 'pending' }, { status: 'revoked' });
  const inv = new Invitation({ email: b.email.toLowerCase(), name: b.name, role: b.role, departments: b.departments, states: b.states, goals: { schedule, remindersEnabled: b.goals.remindersEnabled, weeklyReportEnabled: b.goals.weeklyReportEnabled }, invitedBy: req.user._id }); const link = await makeInvite(inv);
  const emailed = await sendEmail({ to: inv.email, subject: 'You are invited to LeadPilot', html: `<p>Accept your invitation: <a href="${link}">${link}</a></p><p>The link works once and expires in 72 hours.</p>` });
  await log(req, 'invitation.created', 'Invitation', inv._id, { email: inv.email, departments: inv.departments }); res.status(201).json({ id: inv._id, link, expiresAt: inv.expiresAt, emailed });
}));
r.get('/invitations', ...admin, wrap(async (_req, res) => res.json({ items: await Invitation.find().sort('-createdAt').limit(100).select('-tokenHash') })));
r.post('/invitations/:id/resend', ...admin, wrap(async (req, res) => { const inv = await Invitation.findOne({ _id: req.params.id, status: 'pending' }); if (!inv) throw new HttpError(404, 'Invitation not found');
  const link = await makeInvite(inv); const emailed = await sendEmail({ to: inv.email, subject: 'Your LeadPilot invitation', html: `<a href="${link}">${link}</a>` }); res.json({ link, expiresAt: inv.expiresAt, emailed }); }));
r.post('/invitations/:id/revoke', ...admin, wrap(async (req, res) => { await Invitation.updateOne({ _id: req.params.id, status: 'pending' }, { status: 'revoked' }); await log(req, 'invitation.revoked', 'Invitation', req.params.id); res.json({ ok: true }); }));

r.get('/team', ...admin, wrap(async (_req, res) => {
  const users = await User.find().sort('createdAt'); const counts = await Lead.aggregate([{ $group: { _id: '$assignedTo', leads: { $sum: 1 }, contacted: { $sum: { $cond: [{ $ifNull: ['$contactedAt', false] }, 1, 0] } } } }]);
  const m = Object.fromEntries(counts.map((c) => [String(c._id), c]));
  res.json({ items: users.map((u) => ({ id: u._id, name: u.name, email: u.email, role: u.role, departments: u.departments, states: u.states || [], goalDays: (u.goals?.schedule || []).filter((e) => e.campaign !== 'rest').length, active: u.active, lastActiveAt: u.lastActiveAt, createdAt: u.createdAt, leads: m[String(u._id)]?.leads || 0, contacted: m[String(u._id)]?.contacted || 0 })) });
}));
r.patch('/team/:id', ...admin, wrap(async (req, res) => {
  const b = z.object({ departments: dep.optional(), active: z.boolean().optional(), states: z.array(z.enum(STATE_NAMES)).max(37).optional() }).parse(req.body);
  if (String(req.user._id) === req.params.id && b.active === false) throw new HttpError(400, 'You cannot deactivate your own account');
  const u = await User.findById(req.params.id).select('+sessions'); if (!u) throw new HttpError(404, 'Team member not found');
  if (b.departments) u.departments = b.departments; if (b.states) { if (u.role === 'member' && !b.states.length) throw new HttpError(400, 'A team member needs at least one state'); u.states = b.states; } if (b.active !== undefined) { u.active = b.active; if (!b.active) u.sessions = []; } await u.save();
  await log(req, 'team.updated', 'User', u._id, b); res.json({ ok: true });
}));
export default r;
