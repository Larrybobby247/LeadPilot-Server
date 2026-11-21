export const VARIABLES = ['business_name', 'contact_name', 'business_category', 'city', 'state', 'sender_name', 'product_name', 'demo_link', 'signup_link', 'website_url'];
export function render(body, vars = {}) {
  const missing = new Set();
  const text = String(body).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k) => { if (!VARIABLES.includes(k)) return ''; const v = vars[k]; if (v == null || v === '') { missing.add(k); return ''; } return String(v); })
    .replace(/[ \t]+([,.!?])/g, '$1').replace(/[ \t]{2,}/g, ' ');
  return { text: text.trim(), missing: [...missing] };
}
