import {
  pgTable, pgEnum, uuid, varchar, text, boolean,
  integer, smallint, timestamp, date, jsonb, index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import { users } from './users';

// ── Enums ─────────────────────────────────────────────────
export const gigStatusEnum = pgEnum('gig_status', [
  'draft', 'pending_review', 'active', 'paused',
  'funded', 'completed', 'disputed', 'cancelled'
]);

export const proposalStatusEnum = pgEnum('proposal_status', [
  'pending', 'accepted', 'rejected', 'withdrawn', 'completed'
]);

export const paymentStatusEnum = pgEnum('payment_status', [
  'pending', 'escrowed', 'released', 'refunded', 'disputed'
]);

// ── gigs ──────────────────────────────────────────────────
export const gigs = pgTable('gigs', {
  id:       uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull().references(() => users.id, { onDelete: 'restrict' }),

  // Details
  title:       varchar('title', { length: 150 }).notNull(),
  description: text('description').notNull(),
  category:    varchar('category', { length: 50 }).notNull(),
  subcategory: varchar('subcategory', { length: 50 }),
  tags:        text('tags').array().default([]),

  // Budget (in NPR paisa)
  budgetMinNpr: integer('budget_min_npr').notNull(),
  budgetMaxNpr: integer('budget_max_npr').notNull(),
  budgetType:   varchar('budget_type', { length: 20 }).notNull().default('fixed'),

  // Timeline
  deadline:     date('deadline'),
  durationDays: integer('duration_days'),

  // Status
  status:   gigStatusEnum('status').notNull().default('draft'),
  isFunded: boolean('is_funded').notNull().default(false),
  fundedAt: timestamp('funded_at', { withTimezone: true }),

  acceptedProposalId: uuid('accepted_proposal_id'),

  // Location
  locationType: varchar('location_type', { length: 20 }).default('remote'),
  district:     varchar('district', { length: 50 }),
  province:     smallint('province'),

  // Abuse
  flagged:    boolean('flagged').notNull().default(false),
  flagReason: text('flag_reason'),
  adminNotes: text('admin_notes'),

  // Stats
  proposalCount: integer('proposal_count').notNull().default(0),
  viewCount:     integer('view_count').notNull().default(0),

  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  expiresAt:   timestamp('expires_at', { withTimezone: true }),
}, (table) => ({
  clientIdIdx:  index('idx_gigs_client_id').on(table.clientId),
  statusIdx:    index('idx_gigs_status').on(table.status),
  categoryIdx:  index('idx_gigs_category').on(table.category),
  isFundedIdx:  index('idx_gigs_is_funded').on(table.isFunded),
  createdAtIdx: index('idx_gigs_created_at').on(table.createdAt),
}));

// ── proposals ─────────────────────────────────────────────
export const proposals = pgTable('proposals', {
  id:           uuid('id').primaryKey().defaultRandom(),
  gigId:        uuid('gig_id').notNull().references(() => gigs.id, { onDelete: 'cascade' }),
  freelancerId: uuid('freelancer_id').notNull().references(() => users.id, { onDelete: 'restrict' }),

  // Bid
  bidAmountNpr: integer('bid_amount_npr').notNull(),
  bidType:      varchar('bid_type', { length: 20 }).notNull().default('fixed'),
  coverLetter:  text('cover_letter').notNull(),
  estimatedDays: integer('estimated_days'),

  // Status
  status: proposalStatusEnum('status').notNull().default('pending'),

  // Milestones (flexible JSONB)
  milestones:     jsonb('milestones').default([]),
  portfolioItems: text('portfolio_items').array().default([]),

  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  acceptedAt:  timestamp('accepted_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => ({
  gigIdIdx:        index('idx_proposals_gig_id').on(table.gigId),
  freelancerIdIdx: index('idx_proposals_freelancer_id').on(table.freelancerId),
  statusIdx:       index('idx_proposals_status').on(table.status),
}));

// ── escrow_payments ───────────────────────────────────────
export const escrowPayments = pgTable('escrow_payments', {
  id:           uuid('id').primaryKey().defaultRandom(),
  gigId:        uuid('gig_id').notNull().references(() => gigs.id, { onDelete: 'restrict' }),
  proposalId:   uuid('proposal_id').notNull().references(() => proposals.id, { onDelete: 'restrict' }),
  clientId:     uuid('client_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  freelancerId: uuid('freelancer_id').notNull().references(() => users.id, { onDelete: 'restrict' }),

  grossAmountNpr: integer('gross_amount_npr').notNull(),
  platformFeeNpr: integer('platform_fee_npr').notNull().default(0),
  netAmountNpr:   integer('net_amount_npr').notNull(),

  paymentMethod:  varchar('payment_method', { length: 30 }).default('bank_transfer'),
  paymentRef:     varchar('payment_ref', { length: 100 }),
  paymentProofUrl: text('payment_proof_url'),

  status: paymentStatusEnum('status').notNull().default('pending'),

  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  escrowedAt: timestamp('escrowed_at', { withTimezone: true }),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  refundedAt: timestamp('refunded_at', { withTimezone: true }),

  adminNotes: text('admin_notes'),
  verifiedBy: uuid('verified_by').references(() => users.id),
});

// ── reviews ───────────────────────────────────────────────
export const reviews = pgTable('reviews', {
  id:          uuid('id').primaryKey().defaultRandom(),
  gigId:       uuid('gig_id').notNull().references(() => gigs.id, { onDelete: 'cascade' }),
  proposalId:  uuid('proposal_id').notNull().references(() => proposals.id, { onDelete: 'cascade' }),
  reviewerId:  uuid('reviewer_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  revieweeId:  uuid('reviewee_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

  rating:  smallint('rating').notNull(),
  comment: text('comment'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── abuse_logs ────────────────────────────────────────────
export const abuseLogs = pgTable('abuse_logs', {
  id:         uuid('id').primaryKey().defaultRandom(),
  userId:     uuid('user_id').references(() => users.id, { onDelete: 'set null' }),

  eventType:  varchar('event_type', { length: 50 }).notNull(),
  targetType: varchar('target_type', { length: 30 }),
  targetId:   uuid('target_id'),

  ipAddress:  text('ip_address'),
  deviceHash: varchar('device_hash', { length: 64 }),
  details:    jsonb('details').default({}),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userIdIdx:    index('idx_abuse_logs_user_id').on(table.userId),
  eventTypeIdx: index('idx_abuse_logs_event_type').on(table.eventType),
  createdAtIdx: index('idx_abuse_logs_created_at').on(table.createdAt),
}));

// ── Relations ─────────────────────────────────────────────
export const gigsRelations = relations(gigs, ({ one, many }) => ({
  client:   one(users, { fields: [gigs.clientId], references: [users.id] }),
  proposals: many(proposals),
  escrowPayments: many(escrowPayments),
  reviews: many(reviews),
  acceptedProposal: one(proposals, {
    fields: [gigs.acceptedProposalId],
    references: [proposals.id],
  }),
}));

export const proposalsRelations = relations(proposals, ({ one, many }) => ({
  gig:        one(gigs, { fields: [proposals.gigId], references: [gigs.id] }),
  freelancer: one(users, { fields: [proposals.freelancerId], references: [users.id] }),
  reviews:    many(reviews),
}));

// ── Zod Schemas ───────────────────────────────────────────
const milestoneSchema = z.object({
  title:      z.string().min(1).max(100),
  amountNpr:  z.number().int().positive(),
  dueDays:    z.number().int().positive(),
  completed:  z.boolean().default(false),
});

export const createGigSchema = z.object({
  title:       z.string().min(10).max(150),
  description: z.string().min(50).max(5000),
  category:    z.string().min(1).max(50),
  subcategory: z.string().max(50).optional(),
  tags:        z.array(z.string()).max(10).default([]),
  budgetMinNpr: z.number().int().min(100_00),  // min NPR 100 (in paisa)
  budgetMaxNpr: z.number().int(),
  budgetType:  z.enum(['fixed', 'hourly']).default('fixed'),
  deadline:    z.string().date().optional(),
  durationDays: z.number().int().positive().optional(),
  locationType: z.enum(['remote', 'onsite', 'hybrid']).default('remote'),
  district:    z.string().max(50).optional(),
  province:    z.number().int().min(1).max(7).optional(),
}).refine((d) => d.budgetMaxNpr >= d.budgetMinNpr, {
  message: 'budgetMax must be >= budgetMin',
  path: ['budgetMaxNpr'],
});

export const createProposalSchema = z.object({
  gigId:        z.string().uuid(),
  bidAmountNpr: z.number().int().min(100_00),
  bidType:      z.enum(['fixed', 'hourly']).default('fixed'),
  coverLetter:  z.string().min(100).max(2000),
  estimatedDays: z.number().int().positive().optional(),
  milestones:   z.array(milestoneSchema).max(10).default([]),
  portfolioItems: z.array(z.string().url()).max(5).default([]),
});

// ── Types ─────────────────────────────────────────────────
export type Gig = typeof gigs.$inferSelect;
export type NewGig = typeof gigs.$inferInsert;
export type Proposal = typeof proposals.$inferSelect;
export type NewProposal = typeof proposals.$inferInsert;
export type EscrowPayment = typeof escrowPayments.$inferSelect;
export type Review = typeof reviews.$inferSelect;
export type AbuseLog = typeof abuseLogs.$inferSelect;
export type CreateGig = z.infer<typeof createGigSchema>;
export type CreateProposal = z.infer<typeof createProposalSchema>;
