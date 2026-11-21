import { config } from '../config.js';
// Optional. Without RESEND_API_KEY nothing is sent and callers fall back to showing the link to the owner.
export async function sendEmail({ to, subject, html }) {
  if (!config.resendKey) return false;
  try { const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${config.resendKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: config.emailFrom, to, subject, html }) }); return r.ok; } catch { return false; }
}
