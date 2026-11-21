import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { User } from '../models/index.js';
import { HttpError, wrap, requireAuth, signAccess, signRefresh } from '../middleware/auth.js';
import { randomToken, sha256 } from '../utils/crypto.js';
import { log } from '../services/activity.js';
import { sendEmail } from '../services/email.js';

const r = Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { message: 'Too many attempts. Try again later.' } });
const COOKIE = { httpOnly: true, secure: config.prod, sameSite: config.prod ? 'none' : 'lax', path: '/api/auth', maxAge: 30 * 864e5 };
const DUMMY = bcrypt.hashSync('not-a-real-password', 10);
export const passwordRule = z.string().min(10, 'Use at least 10 characters').max(128).regex(/[a-z]/, 'Add a lowercase letter').regex(/[A-Z]/, 'Add an uppercase letter').regex(/\d/, 'Add a number');
export const publicUser = (u) => ({ id: u._id, name: u.name, email: u.email, role: u.role, departments: u.role === 'owner' ? ['ordarly', 'keykonnec', 'website'] : u.departments });

export async function startSession(req, res, user) {
  const sid = crypto.randomUUID(); const refresh = signRefresh(user, sid);
  await User.updateOne({ _id: user._id }, { $push: { sessions: { $each: [{ sid, tokenHash: sha256(refresh), userAgent: req.get('user-agent')?.slice(0, 200), ip: req.ip, createdAt: new Date(), expiresAt: new Date(Date.now() + 30 * 864e5) }], $slice: -10 } }, lastActiveAt: new Date() });
  res.cookie('lp_refresh', refresh, COOKIE); return { accessToken: signAccess(user), user: publicUser(user) };
}
r.post('/login', limiter, wrap(async (req, res) => {
  const { email, password } = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
  const ok = await bcrypt.compare(password, user?.passwordHash || DUMMY);
  if (!user || !ok || !user.active) throw new HttpError(401, 'Email or password is incorrect');
  await log({ user, ip: req.ip }, 'auth.login', 'User', user._id); res.json(await startSession(req, res, user));
}));
r.post('/refresh', wrap(async (req, res) => {
  const t = req.cookies?.lp_refresh; if (!t) throw new HttpError(401, 'Not signed in');
  let p; try { p = jwt.verify(t, config.refreshSecret); } catch { throw new HttpError(401, 'Session expired'); }
  const user = await User.findById(p.sub).select('+sessions'); const s = user?.sessions.find((x) => x.sid === p.sid);
  if (!user || !user.active || !s || s.tokenHash !== sha256(t)) { if (user && s) { user.sessions = user.sessions.filter((x) => x.sid !== p.sid); await user.save(); } throw new HttpError(401, 'Session expired'); }
  user.sessions = user.sessions.filter((x) => x.sid !== p.sid); await user.save(); // rotate
  res.json(await startSession(req, res, user));
}));
r.post('/logout', wrap(async (req, res) => {
  const t = req.cookies?.lp_refresh; if (t) { try { const p = jwt.verify(t, config.refreshSecret); await User.updateOne({ _id: p.sub }, { $pull: { sessions: { sid: p.sid } } }); } catch {} }
  res.clearCookie('lp_refresh', { ...COOKIE, maxAge: undefined }); res.json({ ok: true });
}));
r.post('/forgot-password', limiter, wrap(async (req, res) => {
  const { email } = z.object({ email: z.string().email() }).parse(req.body);
  const user = await User.findOne({ email: email.toLowerCase(), active: true });
  if (user) { const token = randomToken(); user.resetTokenHash = sha256(token); user.resetExpires = new Date(Date.now() + 3600e3); await user.save();
    const link = `${config.appUrl}/reset-password?token=${token}`; const sent = await sendEmail({ to: user.email, subject: 'Reset your LeadPilot password', html: `<p>Reset your password: <a href="${link}">${link}</a></p><p>This link expires in 1 hour.</p>` });
    if (!sent && !config.prod) console.log('[dev] password reset link:', link); }
  res.json({ message: 'If that email belongs to an account, a reset link has been sent.' }); // same answer either way
}));
r.post('/reset-password', limiter, wrap(async (req, res) => {
  const { token, password } = z.object({ token: z.string().min(20), password: passwordRule }).parse(req.body);
  const user = await User.findOne({ resetTokenHash: sha256(token), resetExpires: { $gt: new Date() } }).select('+resetTokenHash +resetExpires +sessions');
  if (!user) throw new HttpError(400, 'This reset link is invalid or has expired');
  user.passwordHash = await bcrypt.hash(password, 12); user.resetTokenHash = undefined; user.resetExpires = undefined; user.sessions = []; await user.save(); res.json({ ok: true });
}));
r.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));
r.post('/change-password', requireAuth, wrap(async (req, res) => {
  const { current, password } = z.object({ current: z.string(), password: passwordRule }).parse(req.body);
  const u = await User.findById(req.user._id).select('+passwordHash +sessions'); if (!(await bcrypt.compare(current, u.passwordHash))) throw new HttpError(400, 'Current password is incorrect');
  u.passwordHash = await bcrypt.hash(password, 12); u.sessions = []; await u.save(); res.clearCookie('lp_refresh', { ...COOKIE, maxAge: undefined }); res.json({ ok: true });
}));
r.get('/sessions', requireAuth, wrap(async (req, res) => { const u = await User.findById(req.user._id).select('+sessions'); res.json({ items: u.sessions.map((s) => ({ id: s.sid, userAgent: s.userAgent, ip: s.ip, createdAt: s.createdAt })) }); }));
r.delete('/sessions/:sid', requireAuth, wrap(async (req, res) => { await User.updateOne({ _id: req.user._id }, { $pull: { sessions: { sid: req.params.sid } } }); res.json({ ok: true }); }));
export default r;
