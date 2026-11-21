// Usage: npm run seed            -> categories, settings, starter templates, owner account (from .env)
//        npm run seed -- --sample -> also imports a few FICTIONAL leads for development only. Never use in production.
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { config } from '../src/config.js';
import { User, Category, Setting, MessageTemplate } from '../src/models/index.js';
import { importRecords } from '../src/services/importer.js';
import { buildSchedule } from '../src/services/goals.js';

const CATS = {
  ordarly: ['Restaurants', 'Lounges', 'Fast food', 'Bakeries', 'Cafes', 'Food vendors', 'Catering', 'Bars and restaurants', 'Food delivery'],
  keykonnec: ['Hotels', 'Shortlet apartments', 'Guest houses', 'Resorts', 'Serviced apartments', 'Boutique hotels', 'Vacation rentals'],
  website: ['Construction companies', 'Solar companies', 'Wholesale suppliers', 'Event planners', 'Real estate', 'Logistics companies', 'Schools', 'Professional services', 'Manufacturers', 'Distributors', 'Cleaning companies', 'Interior design'],
};
const T = (department, purpose, name, body, category = 'General') => ({ department, purpose, name, body, category, scope: 'global', active: true });
const TEMPLATES = [
  T('ordarly', 'initial_outreach', 'Ordarly: first message', 'Hello {{contact_name}}, this is {{sender_name}} from {{product_name}}. We help restaurants like {{business_name}} take orders online so customers in {{city}} can order straight from their phones, with no missed calls or wrong orders. Would you be open to a quick look at how it works?', 'Restaurants'),
  T('ordarly', 'initial_outreach', 'Ordarly: bakery and cafe', 'Hi {{contact_name}}, {{sender_name}} here from {{product_name}}. {{business_name}} looks like a place people would love to pre-order from. We give {{business_category}} businesses a simple online ordering page with order tracking. Can I show you a 2-minute demo?', 'Bakeries'),
  T('ordarly', 'introduction', 'Ordarly: introduction when asked', 'Thanks for asking. {{product_name}} lets {{business_name}} receive and manage orders online: a menu page you can share on WhatsApp and Instagram, order notifications, and a simple dashboard for sales. You can see it here: {{demo_link}}'),
  T('ordarly', 'no_response_followup', 'Ordarly: gentle follow-up', 'Hi {{contact_name}}, just following up on my earlier message about online ordering for {{business_name}}. Happy to answer any questions or show a short demo whenever suits you.'),
  T('ordarly', 'demo_invitation', 'Ordarly: demo invitation', 'Hi {{contact_name}}, would you like to see how {{business_name}} could take orders online? Here is a short demo: {{demo_link}}. I can also walk you through it on a quick call.'),
  T('ordarly', 'signup_invitation', 'Ordarly: signup invitation', 'Great to hear, {{contact_name}}. You can set up {{business_name}} here: {{signup_link}}. If you get stuck at any point, message me and I will help.'),
  T('ordarly', 'final_followup', 'Ordarly: final follow-up', 'Hi {{contact_name}}, this is my last message about online ordering for {{business_name}}. If the timing is not right, no problem. If you would like to revisit it, just reply and I will be glad to help.'),
  T('keykonnec', 'initial_outreach', 'KeyKonnec: hotels', 'Hello {{contact_name}}, I am {{sender_name}} from {{product_name}}. We help hotels like {{business_name}} take direct bookings online and manage rooms, availability and guests in one place. Could I share a short demo?', 'Hotels'),
  T('keykonnec', 'initial_outreach', 'KeyKonnec: shortlets', 'Hi {{contact_name}}, {{sender_name}} from {{product_name}} here. For shortlet hosts in {{city}}, we offer a booking page and calendar that stops double bookings and keeps guest details organised. Would you like to see it?', 'Shortlet apartments'),
  T('keykonnec', 'introduction', 'KeyKonnec: introduction when asked', '{{product_name}} gives {{business_name}} an online booking page, an availability calendar, guest records and payment tracking. You can try the demo here: {{demo_link}}'),
  T('keykonnec', 'no_response_followup', 'KeyKonnec: gentle follow-up', 'Hi {{contact_name}}, checking in on my message about online bookings for {{business_name}}. I can send a quick walkthrough if that helps.'),
  T('keykonnec', 'management_contact_request', 'KeyKonnec: reach the manager', 'Hello, this is {{sender_name}} from {{product_name}}. Could you point me to the person who manages bookings at {{business_name}}? I have a short note about taking direct online reservations.'),
  T('keykonnec', 'signup_invitation', 'KeyKonnec: signup invitation', 'Glad to hear it, {{contact_name}}. You can create the {{business_name}} account here: {{signup_link}}. I am available if you want help adding your rooms.'),
  T('keykonnec', 'final_followup', 'KeyKonnec: final follow-up', 'Hi {{contact_name}}, last note from me about online bookings for {{business_name}}. Reply any time if you would like to take a look later.'),
  T('website', 'initial_outreach', 'Website: no website', 'Hello {{contact_name}}, I am {{sender_name}}. I noticed {{business_name}} in {{city}} does not seem to have a website yet. A simple professional site helps new customers find and trust you. We build affordable sites for {{business_category}} businesses. Can I share a few examples?', 'Professional services'),
  T('website', 'initial_outreach', 'Website: broken or outdated site', 'Hi {{contact_name}}, {{sender_name}} here. I tried to open {{website_url}} for {{business_name}} and it was not loading properly for me. If you would like, we can fix or rebuild it so customers can find you easily. Happy to share how.', 'General'),
  T('website', 'initial_outreach', 'Website: construction and solar', 'Hello {{contact_name}}, this is {{sender_name}}. Companies like {{business_name}} win more projects when clients can see past work and contact details online. We build clean company websites with project galleries and enquiry forms. Interested in seeing samples?', 'Construction companies'),
  T('website', 'initial_outreach', 'Website: event planners', 'Hi {{contact_name}}, {{sender_name}} here. A good website lets {{business_name}} show event photos and take enquiries any time. We build portfolio sites for event planners in {{city}}. Would you like to see examples?', 'Event planners'),
  T('website', 'pricing_enquiry', 'Website: pricing reply', 'Thanks for asking, {{contact_name}}. Pricing depends on the number of pages and features. A starter business site is the most common choice. If you tell me what {{business_name}} needs, I can send a clear quote.'),
  T('website', 'no_response_followup', 'Website: gentle follow-up', 'Hi {{contact_name}}, following up on my note about a website for {{business_name}}. Glad to send examples or answer questions whenever it suits you.'),
  T('website', 'objection_handling', 'Website: "we use social media"', 'That makes sense, {{contact_name}}. Social pages work well for reach, and a website adds credibility and shows up when people search for {{business_category}} in {{city}}. The two work best together. Want me to show how?'),
  T('website', 'final_followup', 'Website: final follow-up', 'Hi {{contact_name}}, this is my last message about a website for {{business_name}}. If you would like to revisit it later, just reply and I will help.'),
];

await mongoose.connect(config.mongoUri);
for (const [department, names] of Object.entries(CATS)) for (const name of names) await Category.updateOne({ department, name }, { $setOnInsert: { department, name } }, { upsert: true });
await Setting.updateOne({ key: 'global' }, { $setOnInsert: { key: 'global', followUpIntervals: [2, 4, 7], defaultCountryCode: '234', reminders: { enabled: true, firstTime: '17:00', secondTime: '19:00', weeklyTime: '18:00', timezone: 'Africa/Lagos' }, products: { ordarly: { productName: 'Ordarly' }, keykonnec: { productName: 'KeyKonnec' }, website: { productName: 'our web studio' } } } }, { upsert: true });
let made = 0; for (const t of TEMPLATES) { const r = await MessageTemplate.updateOne({ name: t.name, scope: 'global' }, { $setOnInsert: t }, { upsert: true }); made += r.upsertedCount || 0; }
console.log(`Categories ok, ${made} new templates`);
let owner = await User.findOne({ role: 'owner' });
if (owner && !owner.goals?.schedule?.length) { owner.goals = { schedule: buildSchedule(['ordarly', 'keykonnec', 'website'], 40), remindersEnabled: true, weeklyReportEnabled: true }; await owner.save(); console.log('Owner daily goal set to 40 (Mon Ordarly, Tue KeyKonnec, Wed Ordarly, Thu KeyKonnec, Fri Website, Sat KeyKonnec, Sun rest)'); }
if (!owner) { const { OWNER_EMAIL, OWNER_NAME = 'Owner', OWNER_PASSWORD } = process.env; if (!OWNER_EMAIL || !OWNER_PASSWORD) console.log('No owner yet: set OWNER_EMAIL and OWNER_PASSWORD in .env and run seed again.');
  else { owner = await User.create({ name: OWNER_NAME, email: OWNER_EMAIL, passwordHash: await bcrypt.hash(OWNER_PASSWORD, 12), role: 'owner', departments: ['ordarly', 'keykonnec', 'website'], goals: { schedule: buildSchedule(['ordarly', 'keykonnec', 'website'], 40), remindersEnabled: true, weeklyReportEnabled: true } }); console.log('Owner created:', OWNER_EMAIL); } }
if (process.argv.includes('--sample')) {
  if (config.prod) throw new Error('Refusing to load sample data in production');
  const S = (name, category, city, phone, website) => ({ name, category, city, phone, website, verification: 'unverified' });
  await importRecords({ user: owner, department: 'ordarly', source: 'manual', method: 'sample', records: [S('The Food Court (demo)', 'Restaurants', 'Ibadan', '0803 123 4567', 'thefoodcourt.example'), S('Pepper House (demo)', 'Restaurants', 'Lagos', '0902 555 0188'), S('Sweet Crumbs (demo)', 'Bakeries', 'Ibadan', '0813 777 2210')] });
  await importRecords({ user: owner, department: 'keykonnec', source: 'manual', method: 'sample', records: [S('Haven Suites (demo)', 'Shortlet apartments', 'Ibadan', '0809 410 3322')] });
  console.log('Sample (fictional) leads loaded');
}
await mongoose.disconnect();
