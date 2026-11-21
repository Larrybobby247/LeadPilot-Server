import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { User, ExtensionConnection } from '../models/index.js';
import { sha256 } from '../utils/crypto.js';

export class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const signAccess = (u) => jwt.sign({ sub: String(u._id), role: u.role }, config.accessSecret, { expiresIn: '15m' });
export const signRefresh = (u, sid) => jwt.sign({ sub: String(u._id), sid }, config.refreshSecret, { expiresIn: '30d' });

// Web session: Bearer access JWT. User is reloaded each request so deactivation / department changes apply immediately.
export const requireAuth = wrap(async (req, _res, next) => {
  const h = req.headers.authorization || ''; if (!h.startsWith('Bearer ')) throw new HttpError(401, 'Not signed in');
  let p; try { p = jwt.verify(h.slice(7), config.accessSecret); } catch { throw new HttpError(401, 'Session expired'); }
  const user = await User.findById(p.sub); if (!user || !user.active) throw new HttpError(401, 'Account unavailable');
  req.user = user; req.auth = 'web'; next();
});
// Extension: scoped, revocable opaque token. Only accepted on /api/extension routes that opt in.
export const requireExtension = wrap(async (req, _res, next) => {
  const h = req.headers.authorization || ''; if (!h.startsWith('Bearer ')) throw new HttpError(401, 'Not connected');
  const conn = await ExtensionConnection.findOne({ tokenHash: sha256(h.slice(7)), revokedAt: null }); if (!conn) throw new HttpError(401, 'Not connected');
  const user = await User.findById(conn.user); if (!user || !user.active) throw new HttpError(401, 'Account unavailable');
  conn.lastUsedAt = new Date(); await conn.save(); req.user = user; req.conn = conn; req.auth = 'extension'; next();
});
export const requireOwner = (req, _res, next) => (req.user?.role === 'owner' ? next() : next(new HttpError(403, 'Owner access required')));
export const hasDept = (user, d) => user.role === 'owner' || user.departments.includes(d);
export const requireDept = (getDept) => (req, _res, next) => { const d = getDept(req); return d && hasDept(req.user, d) ? next() : next(new HttpError(403, 'No access to this workspace')); };

// The single place that decides which leads a user may touch. Every lead query goes through it.
export const leadScope = (user, extra = {}) => user.role === 'owner' ? { ...extra } : { ...extra, assignedTo: user._id, department: { $in: user.departments } };
export const departmentFilter = (user, requested) => {
  if (requested) { if (!hasDept(user, requested)) throw new HttpError(403, 'No access to this workspace'); return { department: requested }; }
  return user.role === 'owner' ? {} : { department: { $in: user.departments } };
};

export function errorHandler(err, _req, res, _next) {
  if (err.name === 'ZodError') return res.status(400).json({ message: 'Invalid input', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  if (err.name === 'CastError') return res.status(400).json({ message: 'Invalid id' });
  if (err.code === 11000) return res.status(409).json({ message: 'Already exists' });
  const status = err.status || 500; if (status >= 500) console.error(err);
  res.status(status).json({ message: status >= 500 ? 'Something went wrong' : err.message, ...(err.extra || {}) });
}
