// Usage: npm run seed            -> categories, settings, starter templates, owner account (from .env)
//        npm run seed -- --sample -> also imports a few FICTIONAL leads for development only. Never use in production.
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { config } from '../src/config.js';
import { User, Category, Setting, MessageTemplate } from '../src/models/index.js';
import { importRecords } from '../src/services/importer.js';
import { buildSchedule } from '../src/services/goals.js';
import { TEMPLATES } from './templates.js';

const CATS = {
  ordarly: ['Restaurants', 'Lounges', 'Fast food', 'Bakeries', 'Cafes', 'Food vendors', 'Catering', 'Bars and restaurants', 'Food delivery'],
  keykonnec: ['Hotels', 'Shortlet apartments', 'Guest houses', 'Resorts', 'Serviced apartments', 'Boutique hotels', 'Vacation rentals'],
  website: ['Construction companies', 'Solar companies', 'Wholesale suppliers', 'Event planners', 'Real estate', 'Logistics companies', 'Schools', 'Professional services', 'Manufacturers', 'Distributors', 'Cleaning companies', 'Interior design'],
};
await mongoose.connect(config.mongoUri);
for (const [department, names] of Object.entries(CATS)) for (const name of names) await Category.updateOne({ department, name }, { $setOnInsert: { department, name } }, { upsert: true });
await Setting.updateOne({ key: 'global' }, { $setOnInsert: { key: 'global', followUpIntervals: [2, 4, 7], defaultCountryCode: '234', reminders: { enabled: true, firstTime: '17:00', secondTime: '19:00', weeklyTime: '18:00', timezone: 'Africa/Lagos' }, products: { ordarly: { productName: 'Ordarly' }, keykonnec: { productName: 'KeyKonnec' }, website: { productName: 'our web studio' } } } }, { upsert: true });
let made = 0; for (const t of TEMPLATES) { const r = await MessageTemplate.updateOne({ name: t.name, scope: 'global' }, { $set: t }, { upsert: true }); made += r.upsertedCount || 0; }
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
