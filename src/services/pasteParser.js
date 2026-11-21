// Best-effort extraction from Google results text the user copied and pasted. No network, no scraping. Everything is flagged for review.
const TLD = '(?:com|ng|org|net|co|info|biz|edu|gov|io|me|app|tv|ly|store|shop|online|site|africa)';
const URL_LINE = new RegExp(`^(?:https?:\\/\\/)?(?:www\\.)?[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9-]+)*\\.${TLD}(?:[\\/\\s›>].*)?$`, 'i');
const PHONE = /(?:\+?234[\s-]?|0)[789][01]\d[\s-]?\d{3}[\s-]?\d{4}/g; const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SOCIAL = /(instagram|facebook|linkedin|x|twitter|tiktok)\.com/i; const NOISE = /^(people also ask|images|videos|maps|news|shopping|more|sponsored|ads?|all|search results|related searches|translate this page|cached|similar|see results about)$/i;
const isUrlLine = (l) => l.length < 220 && URL_LINE.test(l);
export function parseResultsText(text, { city, category } = {}) {
  const lines = String(text).replace(/\u00a0/g, ' ').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const idx = lines.map((l, i) => (isUrlLine(l) ? i : -1)).filter((i) => i >= 0); const seen = new Set(), used = new Set(), records = [];
  idx.forEach((i, k) => {
    const title = i > 0 && !isUrlLine(lines[i - 1]) && !used.has(i - 1) ? lines[i - 1] : null; if (!title || title.length > 150 || NOISE.test(title)) return; used.add(i - 1);
    const token = lines[i].split(' ')[0]; const url = /^https?:\/\//i.test(token) ? token : 'https://' + token; let host; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return; }
    const key = host + new URL(url).pathname.replace(/\/$/, ''); if (seen.has(key)) return; seen.add(key);
    const body = lines.slice(i + 1, k + 1 < idx.length ? idx[k + 1] - 1 : lines.length).join(' '); const blob = `${title} ${body}`;
    const phones = [...new Set((blob.match(PHONE) || []).map((p) => p.trim()))]; const emails = [...new Set(blob.match(EMAIL) || [])]; const social = SOCIAL.test(host); const notes = [];
    if (!phones.length) notes.push('No phone number found in the pasted text.'); if (phones.length > 1) notes.push('Several phone numbers found. Confirm which belongs to the business.'); if (social) notes.push('Social profile. Confirm it is the business page.');
    records.push({ name: title.replace(/\s*[-|·–]\s*(Instagram|Facebook|LinkedIn|Home|Official.*)$/i, '').trim(), category, city, phone: phones.length === 1 ? phones[0] : undefined, email: emails.length === 1 ? emails[0] : undefined, website: social ? undefined : url, social: social ? url : undefined, sourceUrl: url, verification: 'requires_review', notes });
  });
  return records;
}
