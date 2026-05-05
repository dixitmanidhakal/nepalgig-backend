import {
  pgTable, pgEnum, uuid, varchar, text, boolean,
  integer, bigint, numeric, smallint, timestamp,
  index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';

// ── Enums ─────────────────────────────────────────────────
export const userRoleEnum = pgEnum('user_role', [
  'pending', 'freelancer', 'client', 'admin'
]);

// ── Table ─────────────────────────────────────────────────
export const users = pgTable('users', {
  id:           uuid('id').primaryKey().defaultRandom(),

  // Contact
  phone:        varchar('phone', { length: 20 }).unique(),
  email:        varchar('email', { length: 255 }).unique(),

  // Role (LOCKED)
  role:         userRoleEnum('role').notNull().default('pending'),
  roleLocked:   boolean('role_locked').notNull().default(true),

  // Identity
  fullName:     varchar('full_name', { length: 100 }),
  displayName:  varchar('display_name', { length: 50 }),
  avatarUrl:    text('avatar_url'),
  deviceHash:   varchar('device_hash', { length: 64 }),

  // Abuse prevention
  banned:         boolean('banned').notNull().default(false),
  banReason:      text('ban_reason'),
  banExpiresAt:   timestamp('ban_expires_at', { withTimezone: true }),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lastFailedAt:   timestamp('last_failed_at', { withTimezone: true }),

  // Nepal-specific
  district: varchar('district', { length: 50 }),
  province: smallint('province'),

  // Verified
  nidVerified: boolean('nid_verified').notNull().default(false),

  // Freelancer profile
  skills:       text('skills').array().default([]),
  bio:          text('bio'),
  hourlyRateNpr: integer('hourly_rate_npr'),
  portfolioUrls: text('portfolio_urls').array().default([]),

  // Stats (denormalized)
  totalEarnedNpr: bigint('total_earned_npr', { mode: 'number' }).notNull().default(0),
  totalSpentNpr:  bigint('total_spent_npr', { mode: 'number' }).notNull().default(0),
  ratingAvg:      numeric('rating_avg', { precision: 3, scale: 2 }),
  ratingCount:    integer('rating_count').notNull().default(0),

  // Timestamps
  createdAt:        timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt:       timestamp('last_seen_at', { withTimezone: true }),
  emailVerifiedAt:  timestamp('email_verified_at', { withTimezone: true }),
  phoneVerifiedAt:  timestamp('phone_verified_at', { withTimezone: true }),
}, (table) => ({
  phoneIdx:      index('idx_users_phone').on(table.phone),
  emailIdx:      index('idx_users_email').on(table.email),
  roleIdx:       index('idx_users_role').on(table.role),
  deviceHashIdx: index('idx_users_device_hash').on(table.deviceHash),
}));

// ── Zod Schemas ───────────────────────────────────────────
export const insertUserSchema = createInsertSchema(users, {
  phone: z.string().regex(/^\+977[0-9]{9,10}$/, 'Invalid Nepal phone number'),
  email: z.string().email().optional(),
  role:  z.enum(['pending', 'freelancer', 'client', 'admin']).default('pending'),
  province: z.number().int().min(1).max(7).optional(),
});

export const selectUserSchema = createSelectSchema(users);

export const updateProfileSchema = z.object({
  fullName:     z.string().min(2).max(100).optional(),
  displayName:  z.string().min(2).max(50).optional(),
  bio:          z.string().max(1000).optional(),
  district:     z.string().max(50).optional(),
  province:     z.number().int().min(1).max(7).optional(),
  skills:       z.array(z.string()).max(10).optional(),
  hourlyRateNpr: z.number().int().positive().optional(),
  portfolioUrls: z.array(z.string().url()).max(5).optional(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UpdateProfile = z.infer<typeof updateProfileSchema>;
