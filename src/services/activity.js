import { ActivityLog, Notification } from '../models/index.js';
export const log = (req, action, entityType, entityId, metadata = {}, department) =>
  ActivityLog.create({ user: req.user?._id, action, entityType, entityId, department, metadata, ip: req.ip }).catch((e) => console.error('activity log failed', e.message));
export const notify = (user, type, title, body, link) => Notification.create({ user, type, title, body, link }).catch(() => {});
