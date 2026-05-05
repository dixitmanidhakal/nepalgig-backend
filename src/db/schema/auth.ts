import {
  pgTable, pgEnum, uuid, varchar, boolean,
  smallint, timestamp, inet, text, index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createInsertSchema } from 'drizzle-zod';
import { z } from 'zod';
import { users } from './users';

// ── Enums ─────────────────────────────────────────────────
export const tokenTypeEnum = pgEnum('token_type', [
  'magic_link', 'email_verify', 'password_reset'
]);

// ── magic_tokens ──────────────────────────────────────────
export const magicTokens = pgTable('magic_tokens', {
  id:         uuid('id').primaryKey().defaultRandom(),
  userId:     uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),

  tokenHash:  varchar('token_hash', { length: 64 }).notNull().unique(),
  tokenType:  tokenTypeEnum('token_type').notNull().default('magic_link'),

  email:      varchar('email', { length: 255 }),
  phone:      varchar('phone', { length: 20 }),

  ipAddress:  text('ip_address'),      // INET stored as text in Drizzle
  userAgent:  text('user_agent'),
  deviceHash: varchar('device_hash', { length: 64 }),

  used:       boolean('used').notNull().default(false),
  usedAt:     timestamp('used_at', { withTimezone: true }),
  attempts:   smallint('attempts').notNull().default(0),

  expiresAt:  timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tokenHashIdx:  index('idx_magic_tokens_token_hash').on(table.tokenHash),
  userIdIdx:     index('idx_magic_tokens_user_id').on(table.userId),
  emailIdx:      index('idx_magic_tokens_email').on(table.email),
  expiresAtIdx:  index('idx_magic_tokens_expires_at').on(table.expiresAt),
}));

// ── sessions ──────────────────────────────────────────────
export const sessions = pgTable('sessions', {
  id:           uuid('id').primaryKey().defaultRandom(),
  userId:       uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

  sessionToken: varchar('session_token', { length: 64 }).notNull().unique(),

  ipAddress:    text('ip_address'),
  userAgent:    text('user_agent'),
  deviceHash:   varchar('device_hash', { length: 64 }),

  revoked:      boolean('revoked').notNull().default(false),
  revokedAt:    timestamp('revoked_at', { withTimezone: true }),
  revokeReason: text('revoke_reason'),

  expiresAt:  timestamp('expires_at', { withTimezone: true }).notNull(),
  lastActive: timestamp('last_active', { withTimezone: true }).notNull().defaultNow(),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tokenIdx:     index('idx_sessions_token').on(table.sessionToken),
  userIdIdx:    index('idx_sessions_user_id').on(table.userId),
  expiresAtIdx: index('idx_sessions_expires_at').on(table.expiresAt),
}));

// ── rate_limits ───────────────────────────────────────────
export const rateLimits = pgTable('rate_limits', {
  id:         uuid('id').primaryKey().defaultRandom(),
  key:        varchar('key', { length: 100 }).notNull().unique(),
  tokens:     smallint('tokens').notNull().default(10),
  lastRefill: timestamp('last_refill', { withTimezone: true }).notNull().defaultNow(),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Relations ─────────────────────────────────────────────
export const magicTokensRelations = relations(magicTokens, ({ one }) => ({
  user: one(users, { fields: [magicTokens.userId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(sessions, { fields: [sessions.userId], references: [sessions.id] }),
}));

// ── Types ─────────────────────────────────────────────────
export type MagicToken = typeof magicTokens.$inferSelect;
export type NewMagicToken = typeof magicTokens.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
