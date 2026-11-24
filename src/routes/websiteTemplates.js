import { Router } from 'express';
import express from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config.js';
import { Category, WebsiteTemplate } from '../models/index.js';
import { HttpError, wrap, requireAuth, requireOwner } from '../middleware/auth.js';
import { writeZip, ZipError } from '../services/zip.js';
import { analyseTemplate, isHtml } from '../services/websiteRender.js';
import { FIELDS, FIELD_KEYS, suggestField, categoryKey } from '../services/websiteFields.js';
import { storage } from '../services/websiteStorage.js';
import { zipLimits } from '../services/websiteGen.js';
import { log } from '../services/activity.js';

export const previewToken = (kind, id) => jwt.sign({ k: kind, id: String(id) }, config.accessSecret, { expiresIn: '15m', audience: 'website-preview' });
const r = Router(); r.use(requireAuth, requireOwner);
const summary = (t) => t && ({ id: t._id, name: t.name, version: t.version, uploadedAt: t.updatedAt, size: t.size, fileCount: t.fileCount, htmlFiles: t.htmlFiles, entry: t.entry, placeholders: t.placeholders, mappings: t.mappings || {}, configured: t.configured });
const decided = (placeholders, mappings) => placeholders.every((p) => mappings[p.name]?.field);
const categoryOr404 = async (id) => { const c = await Category.findOne({ _id: id, department: 'website' }); if (!c) throw new HttpError(404, 'Category not found'); return c; };

// The category list is the existing Category collection (website outreach). Nothing is duplicated.
r.get('/', wrap(async (_q, res) => {
  const [cats, tpls] = await Promise.all([Category.find({ department: 'website' }).sort('name'), WebsiteTemplate.find()]);
  res.json({ fields: FIELD_KEYS.map((key) => ({ key, ...FIELDS[key] })), maxMb: Math.round(config.templateMaxBytes / 1048576), items: cats.map((c) => ({ category: { id: c._id, name: c.name }, template: summary(tpls.find((t) => t.categoryKey === categoryKey(c.name))) })) });
}));
// Raw upload (one ZIP, or a ZIP the browser built from HTML/CSS/JS/image files). Never executed, only read and stored.
r.post('/:categoryId/upload', express.raw({ type: () => true, limit: config.templateMaxBytes }), wrap(async (req, res) => {
  const cat = await categoryOr404(req.params.categoryId); const body = req.body; if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, 'No file received.');
  const filename = decodeURIComponent(req.get('x-filename') || 'template.zip').replace(/[\\/]/g, '_').slice(0, 120);
  let zip = body; if (!(body[0] === 0x50 && body[1] === 0x4b)) { if (!isHtml(filename)) throw new HttpError(400, 'Upload a .zip file, or HTML files with their CSS, JavaScript and images.'); zip = writeZip([{ name: filename, data: body }]); }
  let info; try { info = analyseTemplate(zip, zipLimits()); } catch (e) { if (e instanceof ZipError) throw new HttpError(400, e.message); throw e; }
  const existing = await WebsiteTemplate.findOne({ categoryKey: categoryKey(cat.name) }); const prev = existing?.mappings || {}; const mappings = {};
  for (const p of info.placeholders) { if (prev[p.name]) mappings[p.name] = prev[p.name]; else { const f = suggestField(p.name); if (f) mappings[p.name] = { field: f }; } } // earlier choices survive a replacement
  const fileId = await storage.put(zip, filename); const fields = { category: cat.name, categoryId: cat._id, name: filename, fileId, size: zip.length, fileCount: info.fileCount, htmlFiles: info.htmlFiles, entry: info.entry, placeholders: info.placeholders, mappings, configured: decided(info.placeholders, mappings), uploadedBy: req.user._id };
  let t, oldFile; if (existing) { oldFile = existing.fileId; Object.assign(existing, fields); existing.version += 1; existing.markModified('mappings'); t = await existing.save(); } else t = await WebsiteTemplate.create({ ...fields, categoryKey: categoryKey(cat.name), version: 1 });
  if (oldFile) await storage.remove(oldFile).catch(() => {}); await log(req, existing ? 'websiteTemplate.replaced' : 'websiteTemplate.uploaded', 'WebsiteTemplate', t._id, { category: cat.name, version: t.version, placeholders: info.placeholders.length }); res.status(201).json(summary(t));
}));
r.put('/:categoryId/mappings', wrap(async (req, res) => {
  const cat = await categoryOr404(req.params.categoryId); const t = await WebsiteTemplate.findOne({ categoryKey: categoryKey(cat.name) }); if (!t) throw new HttpError(404, 'No template uploaded for this category');
  const { mappings } = z.object({ mappings: z.record(z.object({ field: z.string(), default: z.string().max(200).optional() })) }).parse(req.body); const names = new Set(t.placeholders.map((p) => p.name)); const next = { ...(t.mappings || {}) };
  for (const [name, m] of Object.entries(mappings)) { if (!names.has(name)) throw new HttpError(400, `"${name}" is not a placeholder in this template`); if (m.field !== 'none' && !FIELD_KEYS.includes(m.field)) throw new HttpError(400, `Unknown field for "${name}"`); next[name] = { field: m.field, ...(m.default?.trim() ? { default: m.default.trim() } : {}) }; }
  t.mappings = next; t.markModified('mappings'); t.configured = decided(t.placeholders, next); await t.save(); await log(req, 'websiteTemplate.mapped', 'WebsiteTemplate', t._id, { category: cat.name }); res.json(summary(t));
}));
r.delete('/:categoryId', wrap(async (req, res) => { const cat = await categoryOr404(req.params.categoryId); const t = await WebsiteTemplate.findOne({ categoryKey: categoryKey(cat.name) }); if (!t) throw new HttpError(404, 'No template to remove');
  await t.deleteOne(); await storage.remove(t.fileId).catch(() => {}); await log(req, 'websiteTemplate.removed', 'WebsiteTemplate', t._id, { category: cat.name }); res.json({ ok: true }); })); // sites already generated keep their own files
r.post('/:categoryId/preview-token', wrap(async (req, res) => { const cat = await categoryOr404(req.params.categoryId); const t = await WebsiteTemplate.findOne({ categoryKey: categoryKey(cat.name) }); if (!t) throw new HttpError(404, 'No template uploaded for this category'); res.json({ path: `/api/website-preview/${previewToken('tpl', t._id)}/` }); }));
export default r;
