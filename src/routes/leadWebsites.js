import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config.js';
import { Lead, GeneratedWebsite, WebsiteTemplate } from '../models/index.js';
import { HttpError, wrap, requireAuth, leadScope } from '../middleware/auth.js';
import { websiteState, startGeneration, zipLimits } from '../services/websiteGen.js';
import { storage, cachedBuffer } from '../services/websiteStorage.js';
import { readZip } from '../services/zip.js';
import { resolveEntry } from '../services/websiteRender.js';
import { previewToken } from './websiteTemplates.js';
import { log } from '../services/activity.js';

// ---- authenticated, per-lead (scoped exactly like every other lead route: other people's leads are simply not found)
const r = Router(); r.use(requireAuth);
const load = async (req) => { const l = await Lead.findOne(leadScope(req.user, { _id: req.params.leadId })).populate('business'); if (!l) throw new HttpError(404, 'Lead not found'); return l; };
r.get('/:leadId', wrap(async (req, res) => { const l = await load(req); res.json(await websiteState(l, l.business)); }));
r.post('/:leadId/generate', wrap(async (req, res) => {
  const l = await load(req); z.object({}).passthrough().parse(req.body || {}); if (l.department !== 'website') throw new HttpError(400, 'Website generation is only for Website Outreach leads.'); if (!l.contactedAt) throw new HttpError(409, 'Mark the message as sent first. Websites are only prepared after that.');
  await startGeneration(l, l.business, { force: true, userId: req.user._id }); await log(req, 'website.generate_requested', 'Lead', l._id, {}, l.department); res.json(await websiteState(l, l.business));
}));
r.get('/:leadId/download', wrap(async (req, res) => {
  const l = await load(req); const doc = await GeneratedWebsite.findOne({ lead: l._id, status: 'ready' }); if (!doc?.fileId) throw new HttpError(404, 'No website has been generated for this lead yet.');
  const buf = await storage.get(doc.fileId); await log(req, 'website.downloaded', 'Lead', l._id, {}, l.department);
  res.setHeader('Content-Type', 'application/zip'); res.setHeader('Content-Disposition', `attachment; filename="${(doc.filename || 'website.zip').replace(/[^\w.-]/g, '_')}"`); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'private, no-store'); res.send(buf);
}));
r.post('/:leadId/preview-token', wrap(async (req, res) => { const l = await load(req); const doc = await GeneratedWebsite.findOne({ lead: l._id, status: 'ready' }); if (!doc) throw new HttpError(404, 'No website has been generated for this lead yet.'); res.json({ path: `/api/website-preview/${previewToken('gen', doc._id)}/` }); }));
export default r;

// ---- previews. Reached through a short-lived signed link (the iframe cannot send credentials). Everything is served sandboxed:
// no access to the app's origin, cookies or storage, even if the uploaded template contains scripts.
export const preview = Router();
const TYPES = { html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json', map: 'application/json', txt: 'text/plain; charset=utf-8', xml: 'application/xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', pdf: 'application/pdf' };
const ORIGINS = () => config.corsOrigins.join(' ');
preview.get('/:token/*', wrap(async (req, res) => {
  let p; try { p = jwt.verify(req.params.token, config.accessSecret, { audience: 'website-preview' }); } catch { return res.status(401).type('text').send('This preview link has expired. Open the preview again.'); }
  res.removeHeader('X-Frame-Options'); res.removeHeader('Content-Security-Policy');
  res.setHeader('Content-Security-Policy', `sandbox allow-scripts allow-forms allow-popups; frame-ancestors ${ORIGINS()}; default-src 'none'; img-src * data: blob:; media-src * data: blob:; font-src * data:; style-src * 'unsafe-inline'; script-src * 'unsafe-inline' 'unsafe-eval'; connect-src *; frame-src *; base-uri 'self'; form-action *`);
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cache-Control', 'private, max-age=300');
  let fileId; if (p.k === 'tpl') fileId = (await WebsiteTemplate.findById(p.id))?.fileId; else if (p.k === 'gen') fileId = (await GeneratedWebsite.findOne({ _id: p.id, status: 'ready' }))?.fileId; if (!fileId) return res.status(404).type('text').send('Not found');
  const zip = readZip(await cachedBuffer(fileId), zipLimits()); let rel; try { rel = decodeURIComponent(req.params[0] || ''); } catch { return res.status(400).type('text').send('Bad path'); }
  const en = resolveEntry(zip, rel); if (!en) return res.status(404).type('text').send('Not found');
  res.type(TYPES[en.name.split('.').pop().toLowerCase()] || 'application/octet-stream').send(zip.read(en));
}));
