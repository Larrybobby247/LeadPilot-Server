import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { config } from './config.js';
import { errorHandler } from './middleware/auth.js';
import auth from './routes/auth.js'; import team from './routes/team.js'; import leads from './routes/leads.js'; import extension from './routes/extension.js'; import outreach from './routes/outreach.js';
import discovery from './routes/discovery.js'; import websiteTemplates from './routes/websiteTemplates.js'; import leadWebsites, { preview as websitePreview } from './routes/leadWebsites.js'; import ai from './routes/ai.js'; import conversations from './routes/conversations.js'; import goals from './routes/goals.js'; import './services/aiUsage.js'; import { startScheduler } from './services/scheduler.js';
import templates from './routes/templates.js'; import followups from './routes/followups.js'; import campaigns from './routes/campaigns.js'; import analytics from './routes/analytics.js'; import misc from './routes/misc.js';

export const app = express();
app.set('trust proxy', 1); app.use(helmet()); app.use(cookieParser()); app.use(express.json({ limit: '1mb' }));
// The extension authenticates with a bearer token (no cookies), so its chrome-extension:// origin is allowed on its own routes only.
app.use('/api/extension', cors({ origin: (o, cb) => cb(null, !o || o.startsWith('chrome-extension://') || config.corsOrigins.includes(o)), credentials: true }));
app.use(cors({ origin: config.corsOrigins, credentials: true }));
app.use('/api/website-preview', websitePreview); // before the rate limiter: a page loads many files, and links are signed and short-lived
app.use('/api', rateLimit({ windowMs: 60e3, limit: 300, standardHeaders: true, legacyHeaders: false }));
app.get('/health', (_q, r) => r.json({ ok: true }));
app.use('/api/auth', auth); app.use('/api', team); app.use('/api/leads', leads); const alias = (path) => (req, res, next) => { req.url = path; leads(req, res, next); }; app.post('/api/discovery/import', alias('/bulk-import')); app.post('/api/discovery/preview', alias('/preview')); app.use('/api/discovery', discovery); app.use('/api/extension', extension);
app.use('/api/outreach', outreach); app.use('/api/website-templates', websiteTemplates); app.use('/api/lead-websites', leadWebsites); app.use('/api/ai', ai); app.use('/api/conversations', conversations); app.use('/api/goals', goals); app.use('/api/templates', templates); app.use('/api/followups', followups); app.use('/api/campaigns', campaigns); app.use('/api/analytics', analytics); app.use('/api', misc);
app.use('/api', (_q, _r, next) => next(Object.assign(new Error('Not found'), { status: 404 }))); app.use(errorHandler);

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  await mongoose.connect(config.mongoUri); console.log('MongoDB connected');
  app.listen(config.port, () => console.log(`LeadPilot API on :${config.port}`)); startScheduler();
}
