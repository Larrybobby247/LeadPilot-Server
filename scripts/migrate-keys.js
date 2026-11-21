// One-off for databases created BEFORE the strict duplicate guard: registers every existing business's identifiers in BusinessKey.
// Safe to re-run. Identifiers already claimed by another business are reported, not overwritten (resolve those by hand).
import mongoose from 'mongoose';
import { config } from '../src/config.js';
import { Business, BusinessKey } from '../src/models/index.js';
import { keysFor, businessKeys } from '../src/services/dedupe.js';
await mongoose.connect(config.mongoUri); await BusinessKey.syncIndexes(); let added = 0, clashes = 0;
for await (const b of Business.find()) {
  const keys = businessKeys(keysFor({ ...b.toObject(), phones: b.phones, emails: b.emails, website: b.website, socials: b.socials }));
  for (const key of keys) { try { await BusinessKey.create({ key, business: b._id }); added++; } catch (e) { if (e.code === 11000) { const o = await BusinessKey.findOne({ key }); if (String(o.business) !== String(b._id)) { clashes++; console.log(`Clash: ${key} is used by ${b.name} and business ${o.business}`); } } else throw e; } }
}
console.log(`Added ${added} identifier rows, ${clashes} clashes to review`); await mongoose.disconnect();
