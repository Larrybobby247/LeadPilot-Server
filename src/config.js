try { await import('dotenv/config'); } catch { /* dotenv optional; env may come from the host */ }
const prod = process.env.NODE_ENV === 'production';
const need = (k, dev) => { const v = process.env[k]; if (v) return v; if (prod) throw new Error(`Missing env ${k}`); return dev; };
export const config = {
  prod, port: +(process.env.PORT || 4000),
  mongoUri: need('MONGODB_URI', 'mongodb://127.0.0.1:27017/leadpilot'),
  accessSecret: need('JWT_ACCESS_SECRET', 'dev-access-secret-not-for-production-0123456789'),
  refreshSecret: need('JWT_REFRESH_SECRET', 'dev-refresh-secret-not-for-production-0123456789'),
  encryptionKey: need('ENCRYPTION_KEY', '0'.repeat(64)),
  appUrl: process.env.APP_URL || 'http://localhost:5173',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map((s) => s.trim()),
  geminiKey: process.env.GEMINI_API_KEY || '', geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  setupToken: process.env.SETUP_TOKEN || '', // one-time owner creation; remove after use
  reminderEmail: process.env.REMINDER_EMAIL || '',
  resendKey: process.env.RESEND_API_KEY || '', emailFrom: process.env.EMAIL_FROM || 'LeadPilot <no-reply@example.com>',
};
if (prod && (config.accessSecret.length < 32 || config.refreshSecret.length < 32)) throw new Error('JWT secrets must be >= 32 chars');
export const DEPARTMENTS = ['ordarly', 'keykonnec', 'website'];
export const LEAD_STATUSES = ['New', 'Outreach Opened', 'Contacted', 'Responded', 'Interested', 'Demo Requested', 'Demo Sent', 'Negotiating', 'Converted', 'No Response', 'Not Interested', 'Invalid Contact', 'Do Not Contact', 'Pricing Requested', 'Information Requested', 'Objection Raised', 'Follow-up Required'];
export const SYSTEM_ONLY_STATUSES = ['Outreach Opened', 'Contacted']; // set only by the outreach flow
export const NO_FOLLOWUP_STATUSES = ['Converted', 'Not Interested', 'Do Not Contact', 'Invalid Contact'];
// First time a lead reaches a status, stamp it. Analytics count these stamps, never "opened" events.
export const STAGE_STAMP = { Contacted: 'contactedAt', Responded: 'respondedAt', Interested: 'interestedAt', 'Demo Requested': 'demoRequestedAt', 'Demo Sent': 'demoSentAt', Negotiating: 'negotiatingAt', Converted: 'convertedAt' };
