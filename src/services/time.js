// Timezone helpers built on Intl (no dependencies). "Day" always means the local calendar day in the given IANA zone.
const parts = (date, tz, opts) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', ...opts }).formatToParts(date).reduce((a, x) => ((a[x.type] = x.value), a), {});
export function tzOffsetMs(date, tz) { const p = parts(date, tz, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(date.getTime() / 1000) * 1000; }
export const dateKey = (date, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date); // YYYY-MM-DD
export function dayStart(key, tz) { const [y, m, d] = key.split('-').map(Number); const guess = Date.UTC(y, m - 1, d); let t = guess - tzOffsetMs(new Date(guess), tz); t = guess - tzOffsetMs(new Date(t), tz); return new Date(t); }
export const addDays = (key, n) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
export const dayEnd = (key, tz) => dayStart(addDays(key, 1), tz);
export const weekdayOf = (key) => new Date(key + 'T12:00:00Z').getUTCDay(); // 0 = Sunday
export const weekStartKey = (key) => addDays(key, -((weekdayOf(key) + 6) % 7)); // Monday
export const localHM = (date, tz) => { const p = parts(date, tz, { hour: '2-digit', minute: '2-digit' }); return `${p.hour}:${p.minute}`; };
export const isValidTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
export const hoursLeft = (now, key, tz) => Math.max(0, (dayEnd(key, tz) - now) / 36e5);
