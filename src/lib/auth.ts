/**
 * NepalgGig — Phone Magic Link Auth (Phase 1, No SMS)
 *
 * Flow:
 *  1. POST /auth/request { phone, deviceHash? }
 *     → normalise phone → rate-limit check → upsert user
 *     → generate 48-byte token → store SHA-256 hash (15 min TTL)
 *     → return { loginUrl, token, expiresAt }
 *
 *  2. User copies loginUrl, opens in browser (no SMS needed)
 *     /auth/verify?token=xxx&phone=xxx
 *
 *  3. POST /auth/verify { token, phone, deviceHash? }
 *     → look up hash → validate (used/expired/attempts)
 *     → device fingerprint check:
 *         first login  → store deviceHash on user
 *         hash matches → update lastSeenAt, refresh cookie
 *         hash differs → PERMANENT BAN, return 'device_conflict'
 *     → mark token used → create 30-day session → return { sessionToken, role }
 *
 *  4. Frontend sets ng_session (httpOnly) + ng_device cookies → redirect by role
 *
 * Security:
 *  - Raw tokens NEVER stored — only SHA-256 hash
 *  - 15-min TTL, single-use, max 5 verify attempts
 *  - Rate-limited: 3 tokens per phone per hour
 *  - Auto-create user on first login (role='pending')
 *  - Device fingerprint: mismatch → PERMANENT BAN (no recovery without admin)
 */

import crypto from 'crypto';
import { db } from '../db/client';
import { magicTokens, sessions, users } from '../db/schema';
import { eq, and, gt, count } from 'drizzle-orm';

// ── Constants ─────────────────────────────────────────────
export const TOKEN_TTL_MS        = 15 * 60 * 1000;  // 15 minutes
export const SESSION_TTL_DAYS    = 30;
export const RATE_LIMIT_COUNT    = 3;                // tokens per phone per hour
export const RATE_LIMIT_WINDOW   = 60 * 60 * 1000;  // 1 hour
export const MAX_VERIFY_ATTEMPTS = 5;

// ── Crypto ────────────────────────────────────────────────

/** 48-byte cryptographically secure random hex string */
export function generateToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/** SHA-256 — only hashes are stored, never raw tokens */
export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// ── Phone helpers ─────────────────────────────────────────

/** Normalize to +977XXXXXXXXXX */
export function normalizePhone(raw: string): string {
  const d = raw.replace(/[\s\-()+]/g, '');
  if (d.startsWith('977') && d.length === 12) return '+' + d;
  if (d.length === 10 && d.startsWith('9'))   return '+977' + d;
  if (raw.startsWith('+977'))                  return raw.replace(/[\s\-()]/g, '');
  return raw;
}

/** Nepal mobile: +977 followed by 98/97 and 8 digits */
export function isValidNepalPhone(phone: string): boolean {
  return /^\+977(98|97)\d{8}$/.test(phone);
}

// ── Device fingerprint helper ─────────────────────────────

/** Validate that a device hash string looks like a SHA-256 hex */
function isValidHash(h: string | undefined | null): h is string {
  return typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);
}

// ── Types ─────────────────────────────────────────────────

export type RequestTokenResult =
  | { success: true;  loginUrl: string; token: string; expiresAt: Date; isNewUser: boolean; phone: string }
  | { success: false; error: 'invalid_phone' | 'rate_limited' | 'banned' };

export type VerifyTokenResult =
  | { success: true;  sessionToken: string; userId: string; phone: string; role: string; isNewUser: boolean }
  | { success: false; error: 'invalid' | 'expired' | 'used' | 'too_many_attempts' | 'banned' | 'phone_mismatch' | 'device_conflict' };

// ── Step 1: Request token ─────────────────────────────────

export async function requestAuthToken(params: {
  phone:       string;
  deviceHash?: string;
  ipAddress?:  string;
  userAgent?:  string;
  baseUrl?:    string;
}): Promise<RequestTokenResult> {
  const phone = normalizePhone(params.phone);

  if (!isValidNepalPhone(phone)) {
    return { success: false, error: 'invalid_phone' };
  }

  // Rate limit: 3 per phone per hour
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW);
  const [row] = await db
    .select({ count: count() })
    .from(magicTokens)
    .where(and(eq(magicTokens.phone, phone), gt(magicTokens.createdAt, windowStart)));

  if ((row?.count ?? 0) >= RATE_LIMIT_COUNT) {
    return { success: false, error: 'rate_limited' };
  }

  // Upsert user
  let user = await db.query.users.findFirst({ where: eq(users.phone, phone) });
  const isNewUser = !user;

  if (!user) {
    const [created] = await db
      .insert(users)
      .values({ phone, role: 'pending', roleLocked: true, banned: false })
      .returning();
    user = created!;
  } else if (user.banned) {
    return { success: false, error: 'banned' };
  }

  // Invalidate old unused tokens for this phone
  await db
    .update(magicTokens)
    .set({ used: true, usedAt: new Date() })
    .where(and(eq(magicTokens.phone, phone), eq(magicTokens.used, false)));

  // Generate & store token
  const rawToken  = generateToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await db.insert(magicTokens).values({
    userId:     user.id,
    phone,
    tokenHash,
    tokenType:  'magic_link',
    ipAddress:  params.ipAddress,
    userAgent:  params.userAgent,
    deviceHash: isValidHash(params.deviceHash) ? params.deviceHash : undefined,
    expiresAt,
    used:       false,
    attempts:   0,
  });

  const base     = params.baseUrl ?? process.env.APP_BASE_URL ?? 'http://localhost:3000';
  const loginUrl = `${base}/auth/verify?token=${rawToken}&phone=${encodeURIComponent(phone)}`;

  console.log(`[Auth] Token generated for ${phone} — expires ${expiresAt.toISOString()}`);

  return { success: true, loginUrl, token: rawToken, expiresAt, isNewUser, phone };
}

// ── Step 2: Verify token → session ───────────────────────

export async function verifyAuthToken(params: {
  rawToken:    string;
  phone:       string;
  deviceHash?: string;
  ipAddress?:  string;
  userAgent?:  string;
}): Promise<VerifyTokenResult> {
  const phone     = normalizePhone(params.phone);
  const tokenHash = hashToken(params.rawToken);

  const token = await db.query.magicTokens.findFirst({
    where: eq(magicTokens.tokenHash, tokenHash),
  });

  if (!token)                       return { success: false, error: 'invalid' };
  if (token.phone !== phone)        return { success: false, error: 'phone_mismatch' };
  if (token.used)                   return { success: false, error: 'used' };
  if (token.expiresAt < new Date()) {
    await db.update(magicTokens).set({ used: true, usedAt: new Date() }).where(eq(magicTokens.tokenHash, tokenHash));
    return { success: false, error: 'expired' };
  }
  if ((token.attempts ?? 0) >= MAX_VERIFY_ATTEMPTS) return { success: false, error: 'too_many_attempts' };

  // Increment attempts before validation (brute-force safe)
  await db.update(magicTokens)
    .set({ attempts: (token.attempts ?? 0) + 1 })
    .where(eq(magicTokens.tokenHash, tokenHash));

  const user = await db.query.users.findFirst({ where: eq(users.id, token.userId!) });
  if (!user)       return { success: false, error: 'invalid' };
  if (user.banned) return { success: false, error: 'banned' };

  // ── Device fingerprint check ──────────────────────────────────────────────
  // Incoming hash from the verify page's client-side getDeviceHash()
  const incomingHash = isValidHash(params.deviceHash) ? params.deviceHash : null;

  if (incomingHash) {
    if (user.deviceHash && user.deviceHash !== incomingHash) {
      // ─ CONFLICT: stored hash ≠ incoming hash
      // This means the token is being redeemed from a DIFFERENT device than
      // the one that originally registered/last logged in.
      // → PERMANENT BAN — no SMS recovery, admin must lift it manually.
      console.warn(
        `[Auth] DEVICE CONFLICT for user ${user.id} (${phone}) — ` +
        `stored: ${user.deviceHash.slice(0, 8)}… incoming: ${incomingHash.slice(0, 8)}… — BANNING`
      );

      await db.update(users)
        .set({
          banned:      true,
          banReason:   'device_fingerprint_conflict',
          updatedAt:   new Date(),
        })
        .where(eq(users.id, user.id));

      // Invalidate all active sessions for this user
      await db.update(sessions)
        .set({ revoked: true, revokedAt: new Date(), revokeReason: 'device_conflict_ban' })
        .where(and(eq(sessions.userId, user.id), eq(sessions.revoked, false)));

      return { success: false, error: 'device_conflict' };
    }
  }
  // ── End device check ──────────────────────────────────────────────────────

  // Mark token used
  await db.update(magicTokens)
    .set({ used: true, usedAt: new Date() })
    .where(eq(magicTokens.tokenHash, tokenHash));

  // Update user — set/refresh deviceHash on every successful login
  const deviceHashUpdate = incomingHash ? { deviceHash: incomingHash } : {};
  await db.update(users)
    .set({
      lastSeenAt:      new Date(),
      phoneVerifiedAt: user.phoneVerifiedAt ?? new Date(),
      updatedAt:       new Date(),
      ...deviceHashUpdate,
    })
    .where(eq(users.id, user.id));

  // Create 30-day session
  const rawSession    = generateToken();
  const sessionHash   = hashToken(rawSession);
  const sessionExpiry = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);

  await db.insert(sessions).values({
    userId:       user.id,
    sessionToken: sessionHash,
    ipAddress:    params.ipAddress,
    userAgent:    params.userAgent,
    deviceHash:   incomingHash ?? undefined,
    expiresAt:    sessionExpiry,
    revoked:      false,
  });

  return {
    success:      true,
    sessionToken: rawSession,
    userId:       user.id,
    phone:        user.phone!,
    role:         user.role,
    isNewUser:    !user.displayName,
  };
}

// ── Session validation ────────────────────────────────────

export async function validateSession(rawToken: string): Promise<{
  userId: string; role: string; phone: string; sessionId: string;
} | null> {
  const tokenHash = hashToken(rawToken);

  const session = await db.query.sessions.findFirst({
    where: and(
      eq(sessions.sessionToken, tokenHash),
      eq(sessions.revoked, false),
      gt(sessions.expiresAt, new Date())
    ),
  });
  if (!session) return null;

  // Refresh last_active (non-blocking)
  db.update(sessions).set({ lastActive: new Date() }).where(eq(sessions.id, session.id)).catch(() => {});

  const user = await db.query.users.findFirst({
    where: and(eq(users.id, session.userId), eq(users.banned, false)),
  });
  if (!user) return null;

  return { userId: user.id, role: user.role, phone: user.phone!, sessionId: session.id };
}

/** Logout — revoke session */
export async function revokeSession(rawToken: string): Promise<void> {
  const tokenHash = hashToken(rawToken);
  await db.update(sessions)
    .set({ revoked: true, revokedAt: new Date(), revokeReason: 'logout' })
    .where(eq(sessions.sessionToken, tokenHash));
}
