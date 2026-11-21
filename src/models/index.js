import mongoose from 'mongoose';
import { DEPARTMENTS, LEAD_STATUSES } from '../config.js';
const { Schema, model } = mongoose; const oid = Schema.Types.ObjectId;
const opts = { timestamps: true };
const dept = { type: String, enum: DEPARTMENTS, required: true };

export const User = model('User', new Schema({
  name: { type: String, required: true, trim: true }, email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false }, role: { type: String, enum: ['owner', 'member'], default: 'member' },
  departments: [{ type: String, enum: DEPARTMENTS }], active: { type: Boolean, default: true }, lastActiveAt: Date,
  sessions: { type: [{ sid: String, tokenHash: String, userAgent: String, ip: String, createdAt: Date, expiresAt: Date }], select: false },
  resetTokenHash: { type: String, select: false }, resetExpires: { type: Date, select: false },
  goals: { schedule: { type: [{ _id: false, day: { type: Number, min: 0, max: 6 }, campaign: String, target: { type: Number, min: 0, max: 1000 } }], default: [] }, remindersEnabled: { type: Boolean, default: true }, weeklyReportEnabled: { type: Boolean, default: false }, selfEditable: { type: Boolean, default: false }, reminderEmail: String },
}, opts));

export const Invitation = model('Invitation', new Schema({
  email: { type: String, required: true, lowercase: true }, name: String, role: { type: String, enum: ['owner', 'member'], default: 'member' },
  departments: [{ type: String, enum: DEPARTMENTS }], tokenHash: { type: String, required: true, index: true }, expiresAt: { type: Date, required: true },
  goals: { schedule: { type: [{ _id: false, day: { type: Number, min: 0, max: 6 }, campaign: String, target: { type: Number, min: 0, max: 1000 } }], default: [] }, remindersEnabled: { type: Boolean, default: true }, weeklyReportEnabled: { type: Boolean, default: false }, selfEditable: { type: Boolean, default: false }, reminderEmail: String }, status: { type: String, enum: ['pending', 'accepted', 'revoked'], default: 'pending' }, invitedBy: { type: oid, ref: 'User' }, acceptedAt: Date,
}, opts));

// One canonical identity per real business; Leads are department-specific views of it.
const businessSchema = new Schema({
  name: { type: String, required: true }, normName: { type: String, index: true }, city: String, state: String, country: String, address: String,
  category: String, description: String, website: String, instagram: String, facebook: String, linkedin: String, otherSocials: [String],
  phones: { type: [String], index: true }, emails: { type: [String], index: true }, domains: { type: [String], index: true }, socials: { type: [String], index: true },
  cityKey: String, websiteStatus: { type: String, enum: ['WORKING_WEBSITE', 'NO_WEBSITE', 'BROKEN_WEBSITE', 'PARKED_DOMAIN', 'UNCERTAIN'], default: undefined },
  websiteReason: String, websiteCheckedAt: Date, websiteManual: Boolean, verification: { type: String, enum: ['verified', 'unverified', 'requires_review'], default: 'unverified' },
}, opts);
businessSchema.index({ normName: 1, cityKey: 1 });
export const Business = model('Business', businessSchema);

const leadSchema = new Schema({
  business: { type: oid, ref: 'Business', required: true }, department: dept, assignedTo: { type: oid, ref: 'User', required: true, index: true },
  campaign: { type: oid, ref: 'Campaign', default: null }, status: { type: String, enum: LEAD_STATUSES, default: 'New' },
  source: { type: String, enum: ['google_search', 'chrome_extension', 'csv_import', 'google_maps', 'manual'], required: true }, sourceUrl: String, discoveryMethod: String,
  whatsappNumber: String, whatsappVerified: { type: Boolean, default: false }, contactPerson: String, notes: [{ text: String, by: { type: oid, ref: 'User' }, at: { type: Date, default: Date.now } }],
  verification: { type: String, enum: ['verified', 'unverified', 'requires_review'], default: 'unverified' }, completeness: Number, completenessBand: String,
  importJob: { type: oid, ref: 'ImportJob' }, archived: { type: Boolean, default: false }, followUpsPaused: { type: Boolean, default: false },
  discoveredAt: { type: Date, default: Date.now }, lastContactedAt: Date, nextFollowUpAt: Date,
  contactedAt: Date, respondedAt: Date, interestedAt: Date, demoRequestedAt: Date, demoSentAt: Date, negotiatingAt: Date, convertedAt: Date,
}, opts);
leadSchema.index({ business: 1, department: 1 }, { unique: true });
leadSchema.index({ department: 1, status: 1 }); leadSchema.index({ assignedTo: 1, status: 1 });
export const Lead = model('Lead', leadSchema);

export const Campaign = model('Campaign', new Schema({
  name: { type: String, required: true }, department: dept, category: String, location: String, description: String,
  assignedTo: [{ type: oid, ref: 'User' }], template: { type: oid, ref: 'MessageTemplate' }, status: { type: String, enum: ['Draft', 'Active', 'Paused', 'Completed', 'Archived'], default: 'Draft' },
  startDate: Date, endDate: Date, createdBy: { type: oid, ref: 'User' },
}, opts));

export const OutreachEvent = model('OutreachEvent', new Schema({
  lead: { type: oid, ref: 'Lead', required: true, index: true }, user: { type: oid, ref: 'User', required: true }, department: dept, campaign: { type: oid, ref: 'Campaign' },
  type: { type: String, enum: ['opened', 'confirmed_sent', 'not_sent'], required: true }, channel: { type: String, default: 'whatsapp' }, template: { type: oid, ref: 'MessageTemplate' }, message: String,
  at: { type: Date, default: Date.now, index: true },
}, opts));

export const MessageTemplate = model('MessageTemplate', new Schema({
  name: { type: String, required: true }, department: dept, category: { type: String, default: 'General' },
  purpose: { type: String, enum: ['initial_outreach', 'introduction', 'no_response_followup', 'after_demo_followup', 'interested_prospect', 'management_contact_request', 'pricing_enquiry', 'objection_handling', 'demo_invitation', 'signup_invitation', 'final_followup'], required: true },
  body: { type: String, required: true, maxlength: 2000 }, scope: { type: String, enum: ['global', 'personal'], default: 'global' }, owner: { type: oid, ref: 'User' }, active: { type: Boolean, default: true },
}, opts));

export const FollowUp = model('FollowUp', new Schema({
  lead: { type: oid, ref: 'Lead', required: true, index: true }, user: { type: oid, ref: 'User', required: true, index: true }, department: dept, campaign: { type: oid, ref: 'Campaign' },
  dueAt: { type: Date, required: true, index: true }, step: { type: Number, default: 0 }, status: { type: String, enum: ['Pending', 'Completed', 'Rescheduled', 'Cancelled'], default: 'Pending' }, completedAt: Date, note: String,
}, opts));

export const Notification = model('Notification', new Schema({
  user: { type: oid, ref: 'User', required: true, index: true }, type: { type: String, required: true }, title: { type: String, required: true }, body: String, link: String, read: { type: Boolean, default: false },
}, opts));

export const ActivityLog = model('ActivityLog', new Schema({
  user: { type: oid, ref: 'User', index: true }, action: { type: String, required: true, index: true }, entityType: String, entityId: oid, department: String, metadata: Schema.Types.Mixed, ip: String,
  at: { type: Date, default: Date.now, index: true },
}));

export const ExtensionConnection = model('ExtensionConnection', new Schema({
  user: { type: oid, ref: 'User', required: true, index: true }, tokenHash: { type: String, required: true, index: true }, label: String, connectedAt: { type: Date, default: Date.now }, lastUsedAt: Date, revokedAt: Date,
}, opts));
export const PairingCode = model('PairingCode', new Schema({
  user: { type: oid, ref: 'User', required: true }, codeHash: { type: String, required: true, index: true }, expiresAt: { type: Date, required: true }, usedAt: Date,
}, opts));
// Auto-clean old pairing codes
PairingCode.schema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

export const ImportJob = model('ImportJob', new Schema({
  user: { type: oid, ref: 'User', required: true, index: true }, department: dept, source: String, method: String, query: String, sourceUrl: String,
  counts: { collected: Number, imported: Number, duplicates: Number, rejected: Number, review: Number }, status: { type: String, enum: ['Completed', 'Partial', 'Failed'], default: 'Completed' },
}, opts));

export const IntegrationSetting = model('IntegrationSetting', new Schema({
  key: { type: String, required: true, unique: true }, enabled: { type: Boolean, default: false }, secretEnc: { type: String, select: false }, monthlyLimit: Number, lastError: String, lastTestedAt: Date, verified: { type: Boolean, default: false },
}, opts));
export const UsageRecord = model('UsageRecord', new Schema({
  integration: { type: String, required: true }, month: { type: String, required: true }, units: { type: Number, default: 0 }, tokens: { type: Number, default: 0 }, generated: { type: Number, default: 0 }, rateLimited: { type: Number, default: 0 }, estimatedCost: { type: Number, default: 0 }, errors: [{ at: Date, message: String }],
}, opts));
UsageRecord.schema.index({ integration: 1, month: 1 }, { unique: true });

export const Setting = model('Setting', new Schema({
  key: { type: String, unique: true }, scoringWeights: { type: Schema.Types.Mixed }, followUpIntervals: { type: [Number], default: [2, 4, 7] }, defaultCountryCode: { type: String, default: '234' },
  products: { type: Schema.Types.Mixed }, // per-department { productName, demoLink, signupLink, description, pricing, competitorNotes } -- the only facts the AI may state
  collisionPolicy: { type: String, enum: ['filter', 'allow'], default: 'filter' }, // filter: a teammate's business is filtered out of everyone else's imports
  reminders: { type: Schema.Types.Mixed }, // { enabled, firstTime, secondTime, timezone, weeklyTime }
}, opts));
export const Category = model('Category', new Schema({ department: dept, name: { type: String, required: true } }, opts));
Category.schema.index({ department: 1, name: 1 }, { unique: true });

// Atomic duplicate guard: one row per identifier (phone:, email:, domain:, social:). The unique index makes concurrent imports safe;
// businesses with no phone/website simply have no rows, so empty values can never collide.
export const BusinessKey = model('BusinessKey', new Schema({ key: { type: String, required: true, unique: true }, business: { type: oid, ref: 'Business', required: true, index: true } }));

export const ConversationEntry = model('ConversationEntry', new Schema({
  lead: { type: oid, ref: 'Lead', required: true, index: true }, user: { type: oid, ref: 'User', required: true }, department: dept,
  received: { type: String, required: true, maxlength: 4000 }, receivedAt: { type: Date, default: Date.now },
  analysis: { intent: String, explanation: String, nextAction: String, confidence: Number, followUpInDays: Number },
  reply: String, replyEdited: { type: Boolean, default: false }, aiFailed: { type: Boolean, default: false },
  recommendedStatus: String, previousStatus: String, appliedStatus: String, decision: { type: String, enum: ['pending', 'accepted', 'rejected', 'none'], default: 'none' },
  followUp: { suggestedFor: Date, state: { type: String, enum: ['none', 'pending', 'approved', 'dismissed'], default: 'none' }, followUpId: { type: oid, ref: 'FollowUp' } },
}, opts));
export const AiMessage = model('AiMessage', new Schema({
  lead: { type: oid, ref: 'Lead', required: true, index: true }, user: { type: oid, ref: 'User', required: true }, department: dept, kind: String, tone: String, instructions: String,
  cacheKey: { type: String, index: true }, text: { type: String, required: true }, tokens: Number,
}, opts));
export const DailyGoalRecord = model('DailyGoalRecord', new Schema({
  user: { type: oid, ref: 'User', required: true }, date: { type: String, required: true }, campaign: { type: String, required: true }, target: { type: Number, required: true },
  completed: { type: Number, default: 0 }, finalized: { type: Boolean, default: false }, met: { type: Boolean, default: false },
}, opts));
DailyGoalRecord.schema.index({ user: 1, date: 1, campaign: 1 }, { unique: true });
export const ReminderLog = model('ReminderLog', new Schema({
  user: { type: oid, ref: 'User', required: true }, kind: { type: String, enum: ['daily1', 'daily2', 'weekly'], required: true }, dateKey: { type: String, required: true },
  status: { type: String, enum: ['sending', 'sent', 'failed', 'skipped'], default: 'sending' }, attempts: { type: Number, default: 1 }, to: String, error: String, summary: Schema.Types.Mixed,
}, opts));
ReminderLog.schema.index({ user: 1, kind: 1, dateKey: 1 }, { unique: true }); // one reminder of each kind per user per day, even across restarts or multiple instances
