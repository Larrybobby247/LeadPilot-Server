// Orchestrates website generation for a lead. Runs only after the lead's message is confirmed sent; never changes the original template.
import { WebsiteTemplate, GeneratedWebsite } from '../models/index.js';
import { storage, cachedBuffer } from './websiteStorage.js';
import { renderSite } from './websiteRender.js';
import { leadValues, makeResolver, dataHash, categoryKey } from './websiteFields.js';
import { ZipError } from './zip.js';
import { config } from '../config.js';

export const zipLimits = () => ({ maxEntries: config.maxSiteFiles, maxFile: 25 * 1048576, maxTotal: config.extractMaxBytes });
export const templateFor = (category) => (category ? WebsiteTemplate.findOne({ categoryKey: categoryKey(category) }) : null);
const fileLabel = (s) => (String(s || 'website').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'website') + '-website.zip';
const STUCK_MS = 5 * 60e3;

export async function websiteState(lead, business) {
  if (lead.department !== 'website') return { state: 'not_applicable' };
  if (!lead.contactedAt) return { state: 'not_sent' }; // nothing is generated, and nothing is shown, until the message is marked as sent
  const [tpl, doc] = await Promise.all([templateFor(business.category), GeneratedWebsite.findOne({ lead: lead._id })]); const category = business.category || null;
  if (!tpl && !(doc && doc.status === 'ready')) return { state: 'no_template', category, message: category ? `No website template has been configured for "${category}" yet.` : 'This lead has no category, so a website template cannot be chosen.' };
  if (tpl && !tpl.configured && !doc) return { state: 'needs_config', category: tpl.category, message: 'The template for this category still needs its placeholders mapped.' };
  if (!doc) return { state: 'pending', category: tpl.category };
  if (doc.status === 'generating') return Date.now() - doc.updatedAt > STUCK_MS ? { state: 'failed', category: doc.category, error: 'Generation did not finish. Try again.' } : { state: 'generating', category: doc.category };
  if (doc.status === 'failed') return { state: 'failed', category: doc.category, error: doc.error };
  const stale = tpl ? tpl.version !== doc.templateVersion || dataHash(leadValues(lead, business), tpl.mappings, tpl.version) !== doc.dataHash : false;
  return { state: 'ready', category: doc.category, templateVersion: doc.templateVersion, generatedAt: doc.generatedAt, stale, templateRemoved: !tpl, unfilled: doc.unfilled, warnings: doc.warnings, size: doc.size, filename: doc.filename };
}

async function run({ docId, tpl, values, hash, name }) {
  try {
    const buf = await cachedBuffer(tpl.fileId); const out = renderSite(buf, makeResolver(values, tpl.mappings), zipLimits()); const filename = fileLabel(name); const fileId = await storage.put(out.zip, filename);
    const doc = await GeneratedWebsite.findById(docId); const old = doc.fileId;
    Object.assign(doc, { status: 'ready', error: undefined, fileId, size: out.zip.length, filename, dataHash: hash, template: tpl._id, templateVersion: tpl.version, category: tpl.category, businessName: name, unfilled: out.unfilled, warnings: out.warnings, generatedAt: new Date() }); await doc.save();
    if (old && old !== fileId) await storage.remove(old).catch(() => {});
  } catch (e) { console.error('website generation failed', e.message); await GeneratedWebsite.updateOne({ _id: docId }, { status: 'failed', error: e instanceof ZipError ? e.message : 'The website could not be generated. Check the template and try again.' }); }
}
// Starts (or reuses) the lead's website. Returns quickly; the work happens in the background.
export async function startGeneration(lead, business, { force = false, userId } = {}) {
  if (lead.department !== 'website' || !lead.contactedAt) return null;
  const tpl = await templateFor(business.category); if (!tpl || !tpl.configured) return null;
  const values = leadValues(lead, business); const hash = dataHash(values, tpl.mappings, tpl.version); let doc = await GeneratedWebsite.findOne({ lead: lead._id });
  if (doc) {
    if (doc.status === 'generating' && Date.now() - doc.updatedAt < STUCK_MS) return doc; // already running
    if (doc.status === 'ready' && doc.templateVersion === tpl.version && doc.dataHash === hash) return doc; // same template, same information: reuse, never duplicate
    if (doc.status === 'ready' && !force) return doc; // status updates never regenerate; only the first time, or when asked
    doc.status = 'generating'; doc.error = undefined; await doc.save();
  } else {
    try { doc = await GeneratedWebsite.create({ lead: lead._id, business: business._id, businessName: business.name, category: tpl.category, template: tpl._id, templateVersion: tpl.version, status: 'generating', requestedBy: userId }); }
    catch (e) { if (e.code === 11000) return GeneratedWebsite.findOne({ lead: lead._id }); throw e; }
  }
  setImmediate(() => run({ docId: doc._id, tpl, values, hash, name: business.name }));
  return doc;
}
