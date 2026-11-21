import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { DEPARTMENTS } from '../config.js';
import { IntegrationSetting, UsageRecord } from '../models/index.js';
import { HttpError, wrap, requireAuth, hasDept } from '../middleware/auth.js';
import { decrypt } from '../utils/crypto.js';
import { buildTextQuery, searchPlaces, placeToRecord, isOpen, regionCode, PlacesError } from '../services/places.js';
import { parseResultsText } from '../services/pasteParser.js';
import { log } from '../services/activity.js';

const r = Router(); r.use(requireAuth);
const month = () => new Date().toISOString().slice(0, 7);
const lim = rateLimit({ windowMs: 60e3, limit: 10, keyGenerator: (req) => String(req.user?._id || req.ip), validate: false, message: { message: 'Too many searches. Wait a minute and try again.' } });
const usageOf = async () => (await UsageRecord.findOne({ integration: 'google_places', month: month() })) || { units: 0 };

r.get('/status', wrap(async (req, res) => { const s = await IntegrationSetting.findOne({ key: 'google_places' }); const u = await usageOf();
  res.json({ places: { ready: !!(s?.enabled && s?.verified && s?.monthlyLimit), enabled: !!s?.enabled, verified: !!s?.verified, monthlyLimit: s?.monthlyLimit || null, used: u.units, remaining: s?.monthlyLimit ? Math.max(0, s.monthlyLimit - u.units) : null }, canConfigure: req.user.role === 'owner' }); }));

// Generate a lead list straight from a search (no extension). Nothing is saved: the records go to the normal review and duplicate check.
r.post('/generate', lim, wrap(async (req, res) => {
  const b = z.object({ department: z.enum(DEPARTMENTS), pastedUrl: z.string().max(2000).optional(), category: z.string().max(100).optional(), city: z.string().max(100).optional(), state: z.string().max(100).optional(), country: z.string().max(100).optional(), keywords: z.string().max(200).optional(), maxResults: z.number().int().min(1).max(60).default(20) }).parse(req.body);
  if (!hasDept(req.user, b.department)) throw new HttpError(403, 'No access to this workspace');
  const s = await IntegrationSetting.findOne({ key: 'google_places' }).select('+secretEnc');
  if (!s?.secretEnc || !s.enabled || !s.verified) throw new HttpError(422, req.user.role === 'owner' ? 'Google Places is not set up yet. Add and test your API key under Integrations, then enable it.' : 'Direct lead generation is not switched on yet. Ask the owner to set up Google Places under Integrations. You can still use the extension, CSV, manual entry or paste results.', { code: 'PLACES_NOT_CONFIGURED' });
  if (!s.monthlyLimit) throw new HttpError(422, 'Set a monthly request limit under Integrations first, so the search can never run up charges unexpectedly.', { code: 'NO_LIMIT' });
  const used = (await usageOf()).units; const needed = Math.ceil(b.maxResults / 20); if (used + needed > s.monthlyLimit) throw new HttpError(429, `This search could exceed the monthly limit of ${s.monthlyLimit} requests (${used} used). Raise the limit under Integrations or ask for fewer results.`, { code: 'LIMIT' });
  let textQuery; try { textQuery = buildTextQuery(b); } catch (e) { throw new HttpError(e.status || 400, e.message); }
  try {
    const { places, requests } = await searchPlaces({ apiKey: decrypt(s.secretEnc), textQuery, maxResults: b.maxResults, region: regionCode(b.country) });
    await UsageRecord.updateOne({ integration: 'google_places', month: month() }, { $inc: { units: requests } }, { upsert: true });
    const records = places.filter(isOpen).map((p) => placeToRecord(p, { category: b.category, city: b.city, state: b.state })).filter((x) => x.name);
    await log(req, 'discovery.generated', 'Discovery', undefined, { query: textQuery, found: records.length, requests }, b.department);
    res.json({ query: textQuery, count: records.length, records, requests, remaining: Math.max(0, s.monthlyLimit - used - requests) });
  } catch (e) {
    if (!(e instanceof PlacesError)) throw e; await UsageRecord.updateOne({ integration: 'google_places', month: month() }, { $inc: { units: 1 }, $push: { errors: { $each: [{ at: new Date(), message: e.message.slice(0, 200) }], $slice: -20 } } }, { upsert: true });
    throw new HttpError(e.status === 429 ? 429 : 502, e.status === 429 ? 'Google is rate-limiting this key. Try again shortly.' : `Google rejected the search: ${e.message}`);
  }
}));
// No API needed: copy a Google results page, paste it here, and get a reviewable list.
r.post('/parse-text', wrap(async (req, res) => {
  const b = z.object({ department: z.enum(DEPARTMENTS), text: z.string().min(10).max(200000), category: z.string().max(100).optional(), city: z.string().max(100).optional() }).parse(req.body);
  if (!hasDept(req.user, b.department)) throw new HttpError(403, 'No access to this workspace'); const records = parseResultsText(b.text, b).slice(0, 200);
  if (!records.length) throw new HttpError(422, 'No results found in that text. Copy the whole Google results page (Ctrl+A, Ctrl+C) and paste it again.'); res.json({ count: records.length, records });
}));
export default r;
