import { UsageRecord } from '../models/index.js';
import { setUsageRecorder } from './ai.js';
const month = () => new Date().toISOString().slice(0, 7);
// Real counters only: requests, tokens reported by Gemini, generated messages, rate-limit hits and recent errors.
setUsageRecorder(async (u) => { try { await UsageRecord.updateOne({ integration: 'gemini', month: month() }, { $inc: { units: u.requests || 0, tokens: u.tokens || 0, generated: u.generated || 0, rateLimited: u.rateLimited || 0 }, ...(u.error ? { $push: { errors: { $each: [{ at: new Date(), message: u.error }], $slice: -20 } } } : {}) }, { upsert: true }); } catch (e) { console.error('usage record failed', e.message); } });
export const geminiUsage = async () => (await UsageRecord.findOne({ integration: 'gemini', month: month() })) || { units: 0, tokens: 0, generated: 0, rateLimited: 0, errors: [] };
