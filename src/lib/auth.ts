/**
 * NepalgGig Magic Link Auth Library
 *
 * Flow:
 *  1. User enters email → POST /api/auth/magic → email sent with token
 *  2. User clicks link  → GET /api/auth/verify?token=xxx → session created
 *  3. Every request     → middleware reads session cookie → sets RLS context
 *
 * NO SMS in Phase 1. NO Supabase. NO NextAuth.
 * Pure PostgreSQL + custom session tokens.
 */

import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { db } from '@/db/client';
import { magicTokens, sessions, users } from '@/db/schema';
import { eq, and, gt, isNull } from 'drizzle-orm';
import type { NewMagicToken } from '@/db/schema/auth';
import type { NewUser } from '@/db/schema/users';

// ── Constants ─────────────────────────────────────────────
const MAGIC_LINK_TTL_MS    = 15 * 60 * 1000;          // 15 minutes
const SESSION_TTL_DAYS     = 30;
const MAX_TOKEN_ATTEMPTS   = 3;                        // brute force limit
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;          // 1 hour

// ── Token generation ──────────────────────────────────────

/** Generate a cryptographically secure random token */
export function generateSecureToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/** SHA-256 hash a token for storage (never store raw tokens) */
export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/** SHA-256 hash of device fingerprint */
export function hashDevice(fingerprint: string): string {
  const salt = process.env.DEVICE_FINGERPRINT_SALT ?? 'nepalgig-default-salt';
  return crypto.createHash('sha256').update(salt + fingerprint).digest('hex');
}

// ── Email transport ───────────────────────────────────────

function createTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST!,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: false,
    auth: {
      user: process.env.SMTP_USER!,
      pass: process.env.SMTP_PASS!,
    },
    tls: { rejectUnauthorized: true },
  });
}

// ── Magic link email template ─────────────────────────────

function buildMagicLinkEmail(params: {
  recipientName: string;
  magicUrl: string;
  expiresMinutes: number;
}) {
  const { recipientName, magicUrl, expiresMinutes } = params;
  return {
    subject: 'Your NepalgGig Login Link',
    html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login to NepalgGig</title>
</head>
<body style="font-family: Arial, sans-serif; background: #f4f4f4; margin: 0; padding: 20px;">
  <div style="max-width: 500px; margin: 0 auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
    <!-- Header -->
    <div style="background: #1a56db; padding: 24px; text-align: center;">
      <h1 style="color: #fff; margin: 0; font-size: 24px;">🇳🇵 NepalgGig</h1>
      <p style="color: #93c5fd; margin: 4px 0 0; font-size: 14px;">Nepal's Freelance Platform</p>
    </div>

    <!-- Body -->
    <div style="padding: 32px 24px;">
      <p style="color: #374151; margin: 0 0 8px;">नमस्ते ${recipientName || 'there'},</p>
      <p style="color: #374151; margin: 0 0 24px;">
        Click the button below to securely log in to your NepalgGig account.
        This link expires in <strong>${expiresMinutes} minutes</strong>.
      </p>

      <div style="text-align: center; margin: 0 0 24px;">
        <a href="${magicUrl}"
           style="display: inline-block; background: #1a56db; color: #fff; text-decoration: none;
                  padding: 14px 32px; border-radius: 6px; font-size: 16px; font-weight: bold;">
          Log in to NepalgGig
        </a>
      </div>

      <p style="color: #6b7280; font-size: 13px; margin: 0 0 8px;">
        Or copy this link into your browser:
      </p>
      <p style="background: #f3f4f6; padding: 12px; border-radius: 4px; font-size: 12px;
                word-break: break-all; color: #374151; margin: 0 0 24px;">
        ${magicUrl}
      </p>

      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 16px;">
      <p style="color: #9ca3af; font-size: 12px; margin: 0;">
        If you didn't request this link, ignore this email — your account is safe.
        Links are single-use and expire in ${expiresMinutes} minutes.
      </p>
    </div>
  </div>
</body>
</html>`,
    text: `
NepalgGig — Login Link

नमस्ते ${recipientName || 'there'},

Click the link below to log in (expires in ${expiresMinutes} minutes):

${magicUrl}

If you didn't request this, ignore this email.
    `.trim(),
  };
}

// ── Core Auth Functions ───────────────────────────────────

export interface SendMagicLinkParams {
  email: string;
  ipAddress?: string;
  userAgent?: string;
  deviceFingerprint?: string;
}

export interface SendMagicLinkResult {
  success: boolean;
  error?: 'rate_limited' | 'banned' | 'invalid_email' | 'send_failed';
  /** Only in dev mode — never expose in production */
  devToken?: string;
}

/**
 * Step 1: Request magic link
 * - Creates/finds user by email
 * - Generates token, stores hash
 * - Sends email
 */
export async function sendMagicLink(
  params: SendMagicLinkParams
): Promise<SendMagicLinkResult> {
  const { email, ipAddress, userAgent, deviceFingerprint } = params;
  const normalizedEmail = email.toLowerCase().trim();

  // 1. Rate limit check (max 3 magic links per email per hour via DB)
  const recentTokens = await db
    .select()
    .from(magicTokens)
    .where(
      and(
        eq(magicTokens.email, normalizedEmail),
        gt(magicTokens.createdAt, new Date(Date.now() - RATE_LIMIT_WINDOW_MS))
      )
    )
    .limit(10);

  const limit = Number(process.env.RATE_LIMIT_MAGIC_LINK ?? 3);
  if (recentTokens.length >= limit) {
    return { success: false, error: 'rate_limited' };
  }

  // 2. Find or create user
  let user = await db.query.users.findFirst({
    where: eq(users.email, normalizedEmail),
  });

  if (!user) {
    // Auto-create pending user
    const [newUser] = await db
      .insert(users)
      .values({
        email:    normalizedEmail,
        role:     'pending',
        roleLocked: true,
        banned:   false,
        deviceHash: deviceFingerprint ? hashDevice(deviceFingerprint) : undefined,
      } satisfies Partial<NewUser> as NewUser)
      .returning();
    user = newUser!;
  }

  // 3. Check if banned
  if (user.banned) {
    return { success: false, error: 'banned' };
  }

  // 4. Generate token
  const rawToken = generateSecureToken(48);
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS);

  // 5. Invalidate old unused tokens for this email
  await db
    .update(magicTokens)
    .set({ used: true, usedAt: new Date() })
    .where(
      and(
        eq(magicTokens.email, normalizedEmail),
        eq(magicTokens.used, false)
      )
    );

  // 6. Store token hash
  await db.insert(magicTokens).values({
    userId:     user.id,
    tokenHash,
    tokenType:  'magic_link',
    email:      normalizedEmail,
    ipAddress,
    userAgent,
    deviceHash: deviceFingerprint ? hashDevice(deviceFingerprint) : undefined,
    expiresAt,
    used:       false,
  } satisfies NewMagicToken);

  // 7. Build magic URL
  const baseUrl  = process.env.APP_BASE_URL ?? 'http://localhost:3000';
  const magicUrl = `${baseUrl}/api/auth/verify?token=${rawToken}&email=${encodeURIComponent(normalizedEmail)}`;

  // 8. Send email
  const isDev = process.env.NODE_ENV !== 'production';
  if (isDev) {
    console.log('\n[DEV] Magic link:', magicUrl, '\n');
    return { success: true, devToken: rawToken };
  }

  try {
    const transport = createTransport();
    const emailContent = buildMagicLinkEmail({
      recipientName: user.displayName ?? user.fullName ?? '',
      magicUrl,
      expiresMinutes: MAGIC_LINK_TTL_MS / 60_000,
    });

    await transport.sendMail({
      from:    process.env.SMTP_FROM!,
      to:      normalizedEmail,
      subject: emailContent.subject,
      html:    emailContent.html,
      text:    emailContent.text,
    });

    return { success: true };
  } catch (err) {
    console.error('[Auth] Failed to send magic link email:', err);
    return { success: false, error: 'send_failed' };
  }
}

// ─────────────────────────────────────────────────────────

export interface VerifyTokenParams {
  rawToken: string;
  email: string;
  ipAddress?: string;
  userAgent?: string;
  deviceFingerprint?: string;
}

export interface VerifyTokenResult {
  success: boolean;
  sessionToken?: string;
  userId?: string;
  role?: string;
  error?: 'invalid' | 'expired' | 'used' | 'too_many_attempts' | 'banned';
}

/**
 * Step 2: Verify magic link token → create session
 */
export async function verifyMagicToken(
  params: VerifyTokenParams
): Promise<VerifyTokenResult> {
  const { rawToken, email, ipAddress, userAgent, deviceFingerprint } = params;
  const tokenHash = hashToken(rawToken);
  const normalizedEmail = email.toLowerCase().trim();

  // 1. Find token
  const token = await db.query.magicTokens.findFirst({
    where: eq(magicTokens.tokenHash, tokenHash),
  });

  if (!token) {
    return { success: false, error: 'invalid' };
  }

  // 2. Check email matches
  if (token.email !== normalizedEmail) {
    return { success: false, error: 'invalid' };
  }

  // 3. Check already used
  if (token.used) {
    return { success: false, error: 'used' };
  }

  // 4. Check expiry
  if (token.expiresAt < new Date()) {
    await db
      .update(magicTokens)
      .set({ used: true, usedAt: new Date() })
      .where(eq(magicTokens.tokenHash, tokenHash));
    return { success: false, error: 'expired' };
  }

  // 5. Check attempts (brute force)
  if ((token.attempts ?? 0) >= MAX_TOKEN_ATTEMPTS) {
    return { success: false, error: 'too_many_attempts' };
  }

  // 6. Get user
  const user = await db.query.users.findFirst({
    where: eq(users.id, token.userId!),
  });

  if (!user) return { success: false, error: 'invalid' };
  if (user.banned) return { success: false, error: 'banned' };

  // 7. Mark token as used
  await db
    .update(magicTokens)
    .set({ used: true, usedAt: new Date() })
    .where(eq(magicTokens.tokenHash, tokenHash));

  // 8. Update user last seen + verify email
  await db
    .update(users)
    .set({
      lastSeenAt:      new Date(),
      emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
      deviceHash:      deviceFingerprint ? hashDevice(deviceFingerprint) : user.deviceHash,
    })
    .where(eq(users.id, user.id));

  // 9. Create session
  const rawSessionToken = generateSecureToken(48);
  const sessionHash     = hashToken(rawSessionToken);
  const sessionExpiresAt = new Date(
    Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000
  );

  await db.insert(sessions).values({
    userId:       user.id,
    sessionToken: sessionHash,
    ipAddress,
    userAgent,
    deviceHash: deviceFingerprint ? hashDevice(deviceFingerprint) : undefined,
    expiresAt:  sessionExpiresAt,
    revoked:    false,
  });

  return {
    success:      true,
    sessionToken: rawSessionToken,   // send this as cookie
    userId:       user.id,
    role:         user.role,
  };
}

// ─────────────────────────────────────────────────────────

/**
 * Validate session token from cookie
 * Returns user if valid, null if invalid/expired
 */
export async function validateSession(rawSessionToken: string): Promise<{
  userId: string;
  role: string;
  sessionId: string;
} | null> {
  const tokenHash = hashToken(rawSessionToken);

  const session = await db.query.sessions.findFirst({
    where: and(
      eq(sessions.sessionToken, tokenHash),
      eq(sessions.revoked, false),
      gt(sessions.expiresAt, new Date())
    ),
  });

  if (!session) return null;

  // Refresh last_active
  await db
    .update(sessions)
    .set({ lastActive: new Date() })
    .where(eq(sessions.id, session.id));

  const user = await db.query.users.findFirst({
    where: and(eq(users.id, session.userId), eq(users.banned, false)),
  });

  if (!user) return null;

  return {
    userId:    user.id,
    role:      user.role,
    sessionId: session.id,
  };
}

/**
 * Revoke a session (logout)
 */
export async function revokeSession(rawSessionToken: string): Promise<void> {
  const tokenHash = hashToken(rawSessionToken);
  await db
    .update(sessions)
    .set({ revoked: true, revokedAt: new Date(), revokeReason: 'user_logout' })
    .where(eq(sessions.sessionToken, tokenHash));
}
