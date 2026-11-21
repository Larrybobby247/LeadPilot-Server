import { Business, BusinessKey, Lead, Setting } from '../models/index.js';
import { keysFor, compare, normalizeName, businessKeys, isExact, mergeFields, decideKind } from './dedupe.js';
import { completeness } from './scoring.js';
import { normalizePhone } from './phone.js';
import { checkWebsite } from './websiteCheck.js';

const clean = (r) => ({ name: String(r.name || '').trim().slice(0, 200), category: r.category?.trim(), city: (r.city || r.location || '').trim() || undefined, state: r.state?.trim(), country: r.country?.trim(), address: r.address?.trim(),
  phone: r.phone, email: r.email?.trim(), website: r.website?.trim(), social: r.social?.trim(), instagram: r.instagram, facebook: r.facebook, linkedin: r.linkedin });

export async function findBusinessMatch(rec) {
  const k = keysFor(rec); const or = [];
  if (k.phones.length) or.push({ phones: { $in: k.phones } }); if (k.emails.length) or.push({ emails: { $in: k.emails } });
  if (k.domains.length) or.push({ domains: { $in: k.domains } }); if (k.socials.length) or.push({ socials: { $in: k.socials } });
  if (k.normName && k.city) or.push({ normName: k.normName, cityKey: k.city });
  if (!or.length) return { keys: k, match: null, matchedOn: [] };
  let best = null;
  for (const c of await Business.find({ $or: or }).limit(20)) { const on = compare(k, { phones: c.phones, emails: c.emails, domains: c.domains, socials: c.socials, normName: c.normName, city: c.cityKey || '' });
    if (on.length && (!best || (isExact(on) && !isExact(best.on)))) best = { c, on }; }
  return { keys: k, match: best?.c || null, matchedOn: best?.on || [] };
}

// One decision function for both the dry-run preview and the real import, so what the user reviews is what happens.
export async function evaluate(raw, department, user) {
  const c = clean(raw); if (!c.name) return { kind: 'rejected', reason: 'Business name is missing', c };
  const { keys, match, matchedOn } = await findBusinessMatch(c);
  if (raw.phone && !keys.phones.length && !c.email && !c.website && !c.social) return { kind: 'rejected', reason: 'Phone number is not valid', c };
  if (!keys.phones.length && !keys.emails.length && !keys.domains.length && !keys.socials.length) return { kind: 'rejected', reason: 'No phone, email, website or profile link', c };
  if (!match) return { kind: 'new', c, keys };
  const lead = await Lead.findOne({ business: match._id, department }); const isOwner = user.role === 'owner'; const policy = (await Setting.findOne({ key: 'global' }))?.collisionPolicy || 'filter';
  const heldByOther = isOwner ? false : !!(await Lead.exists({ business: match._id, assignedTo: { $ne: user._id }, archived: false }));
  const kind = decideKind({ matchedOn, leadInDept: !!lead, heldByOther, isOwner, policy }); const mine = lead && (isOwner || String(lead.assignedTo) === String(user._id));
  const existing = lead ? { leadId: mine ? lead._id : undefined, name: mine ? match.name : 'a lead in this workspace', business: match.name } : { business: match.name };
  if (kind === 'taken') return { kind, c, keys, match, matchedOn, existing: { business: 'a business already held by a teammate' } }; // never reveals who or which lead
  return { kind, c, keys, match, lead, existing, matchedOn }; // 'associate': exact match in another workspace you already work in
}

function applyToBusiness(b, c, k, verification) {
  for (const f of ['category', 'city', 'state', 'country', 'address']) if (!b[f] && c[f]) b[f] = c[f];
  if (!b.website && c.website) b.website = c.website;
  const soc = c.social || ''; if (/instagram\.com/i.test(soc) && !b.instagram) b.instagram = soc; else if (/facebook\.com/i.test(soc) && !b.facebook) b.facebook = soc; else if (/linkedin\.com/i.test(soc) && !b.linkedin) b.linkedin = soc; else if (soc && !/(instagram|facebook|linkedin)\.com/i.test(soc)) b.otherSocials = [...new Set([...(b.otherSocials || []), soc])];
  b.phones = [...new Set([...(b.phones || []), ...k.phones])]; b.emails = [...new Set([...(b.emails || []), ...k.emails])]; b.domains = [...new Set([...(b.domains || []), ...k.domains])]; b.socials = [...new Set([...(b.socials || []), ...k.socials])];
  b.normName = normalizeName(b.name); b.cityKey = (b.city || '').toLowerCase();
  if (b.verification !== 'verified' && verification === 'verified') b.verification = 'verified'; // never downgraded
}
// Atomic claim: the unique index on BusinessKey.key is the real guard. Two simultaneous imports of the same phone cannot both succeed.
async function claimKeys(businessId, keys, { tolerate = false } = {}) {
  const docs = businessKeys(keys).map((key) => ({ key, business: businessId })); if (!docs.length) return true;
  try { await BusinessKey.insertMany(docs, { ordered: false }); return true; }
  catch (e) { if (e.code === 11000 || e.writeErrors?.length) { if (tolerate) return true; await BusinessKey.deleteMany({ business: businessId }); return false; } throw e; }
}
const isDupErr = (e) => e?.code === 11000;
const asReview = (v) => v === 'requires_review';

export async function importRecords({ user, department, records, source, method, query, sourceUrl, jobId }) {
  const out = { imported: [], associated: [], updated: [], duplicates: [], potential: [], taken: [], rejected: [], review: [] }; const toVerify = [];
  const mk = (raw, extra = {}) => ({ name: raw.name || 'Unnamed record', ...extra });
  async function createLead(business, raw, verification) {
    const lead = new Lead({ business: business._id, department, assignedTo: user._id, source, sourceUrl: raw.sourceUrl || sourceUrl, discoveryMethod: method, verification, importJob: jobId });
    const sc = completeness({ ...business.toObject(), whatsappVerified: false }); lead.completeness = sc.score; lead.completenessBand = sc.band; await lead.save(); return lead;
  }
  for (const raw of records) {
    const verification = ['verified', 'unverified', 'requires_review'].includes(raw.verification) ? raw.verification : 'unverified'; const action = raw.action; const owner = user.role === 'owner';
    for (let attempt = 0; attempt < 2; attempt++) { // a lost race is retried once; the retry sees the winner and reports a duplicate
      const ev = await evaluate(raw, department, user); const label = ev.c.name || 'Unnamed record';
      try {
        if (ev.kind === 'rejected') { out.rejected.push(mk(raw, { reason: ev.reason })); break; }
        if (ev.kind === 'taken') { out.taken.push(mk(raw, { reason: 'Already held by a teammate', matchedOn: ev.matchedOn.join(', ') })); break; } // filtered out, no override for members
        let businessForNew = null;
        if (ev.kind === 'duplicate' || ev.kind === 'potential') {
          if (action === 'update' && ev.lead) { const b = ev.match; const { conflicts } = mergeFields({ category: b.category, city: b.city, website: b.website, address: b.address }, { category: ev.c.category, city: ev.c.city, website: ev.c.website, address: ev.c.address });
            applyToBusiness(b, ev.c, ev.keys, verification); await b.save(); await claimKeys(b._id, ev.keys, { tolerate: true }); out.updated.push(mk(raw, { leadId: ev.lead._id, conflicts })); break; }
          if (action === 'associate' && ev.kind === 'potential' && !ev.lead) { /* handled below */ }
          else if (action === 'override' && owner) businessForNew = 'override'; // administrator confirms these are different businesses
          else if (action === 'import_new' && owner && ev.kind === 'potential') businessForNew = 'override';
          else { (ev.kind === 'duplicate' ? out.duplicates : out.potential).push(mk(raw, { existing: ev.existing.name, existingLeadId: ev.existing.leadId, matchedOn: ev.matchedOn.join(', ') })); break; }
        }
        if (ev.kind === 'potential' && !ev.lead && action !== 'associate' && !(owner && (action === 'import_new' || action === 'override'))) { out.potential.push(mk(raw, { existing: ev.existing.business, matchedOn: ev.matchedOn.join(', ') })); break; }
        if ((ev.kind === 'associate' || (ev.kind === 'potential' && !ev.lead && action === 'associate')) && businessForNew !== 'override') { // same business, additional campaign: no new business record
          const b = ev.match; applyToBusiness(b, ev.c, ev.keys, verification); await b.save(); await claimKeys(b._id, ev.keys, { tolerate: true });
          const lead = await createLead(b, raw, verification); out.associated.push(mk(raw, { leadId: lead._id, existing: b.name })); (asReview(verification) ? out.review : out.imported).push(mk(raw, { leadId: lead._id, associated: true })); if (department === 'website' && b.website) toVerify.push(b._id); break; }
        // brand-new business (or an owner-confirmed override)
        const business = new Business({ name: ev.c.name }); applyToBusiness(business, ev.c, ev.keys, verification);
        if (!business.website && department === 'website') { business.websiteStatus = 'NO_WEBSITE'; business.websiteReason = 'No website URL supplied.'; business.websiteCheckedAt = new Date(); }
        await business.save();
        if (!(await claimKeys(business._id, ev.keys, { tolerate: businessForNew === 'override' }))) { await Business.deleteOne({ _id: business._id }); if (attempt === 0) continue; out.duplicates.push(mk(raw, { existing: 'a business that was just added', matchedOn: 'identifier' })); break; }
        let lead; try { lead = await createLead(business, raw, verification); } catch (e) { if (isDupErr(e)) { await BusinessKey.deleteMany({ business: business._id }); await Business.deleteOne({ _id: business._id }); out.duplicates.push(mk(raw, { existing: label, matchedOn: 'concurrent import' })); break; } throw e; }
        if (department === 'website' && business.website) toVerify.push(business._id);
        (asReview(verification) ? out.review : out.imported).push(mk(raw, { leadId: lead._id, reason: raw.notes?.[0] })); break;
      } catch (e) { if (isDupErr(e) && attempt === 0) continue; throw e; }
    }
  }
  if (toVerify.length) verifyInBackground(toVerify.slice(0, 25));
  return out;
}
export async function verifyBusiness(id) { const b = await Business.findById(id); if (!b || b.websiteManual) return; const r = await checkWebsite(b.website); b.websiteStatus = r.status; b.websiteReason = r.reason; b.websiteCheckedAt = r.checkedAt; await b.save(); }
function verifyInBackground(ids) { (async () => { for (const id of ids) { try { await verifyBusiness(id); } catch (e) { console.error('website check failed', e.message); } await new Promise((r) => setTimeout(r, 400)); } })(); }
