/**
 * NepalgGig Backend — HTTP Server
 *
 * Auth Routes (Phone Magic Link — No SMS Phase 1):
 *  POST /auth/request  { phone, deviceHash? }              → { loginUrl, expiresAt, isNewUser }
 *  POST /auth/verify   { token, phone, deviceHash? }       → { sessionToken, role, isNewUser }
 *  POST /auth/logout   { sessionToken }       → { success }
 *  GET  /auth/session  (Authorization header) → { userId, role, phone }
 *
 * Other:
 *  GET  /health        → { status, ts }
 *  ANY  /trpc/*        → tRPC router
 */

import http from 'http';
import * as dotenv from 'dotenv';
import { createHTTPHandler } from '@trpc/server/adapters/standalone';
import { appRouter }          from './root';
import { createTRPCContext }  from './trpc';
import {
  requestAuthToken,
  verifyAuthToken,
  validateSession,
  revokeSession,
} from '../lib/auth';

dotenv.config();

const PORT    = Number(process.env.PORT ?? 4000);
const ORIGINS = (process.env.APP_BASE_URL ?? 'http://localhost:3000').split(',');

// ── tRPC handler ──────────────────────────────────────────
const trpcHandler = createHTTPHandler({
  router:        appRouter,
  createContext: createTRPCContext,
  onError: ({ path, error }) => {
    if (process.env.NODE_ENV !== 'production') {
      console.error(`[tRPC] ${path ?? 'unknown'}:`, error.message);
    }
  },
});

// ── HTTP Server ───────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin ?? '';

  // CORS
  res.setHeader('Access-Control-Allow-Origin',  ORIGINS.includes(origin) ? origin : ORIGINS[0]!);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = (req.url ?? '/').split('?')[0]!;
  const ip  = String(req.headers['x-real-ip'] ?? req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '');

  try {
    // ── GET /health ────────────────────────────────────────
    if (url === '/health' && req.method === 'GET') {
      return send(res, 200, { status: 'ok', service: 'nepalgig-backend', ts: new Date().toISOString() });
    }

    // ── POST /auth/request ─────────────────────────────────
    // Body: { phone: string, deviceHash?: string }
    // Returns: { success, loginUrl, expiresAt, isNewUser, phone }
    if (url === '/auth/request' && req.method === 'POST') {
      const body = await readJSON<{ phone?: string; deviceHash?: string }>(req);
      if (!body.phone?.trim()) return send(res, 400, { error: 'phone is required' });

      const result = await requestAuthToken({
        phone:      body.phone,
        deviceHash: body.deviceHash,
        ipAddress:  ip,
        userAgent:  req.headers['user-agent'],
        baseUrl:    process.env.APP_BASE_URL,
      });

      if (!result.success) {
        const statusMap = { invalid_phone: 400, rate_limited: 429, banned: 403 } as const;
        return send(res, statusMap[result.error] ?? 400, { error: result.error });
      }

      return send(res, 200, {
        success:   true,
        loginUrl:  result.loginUrl,
        expiresAt: result.expiresAt,
        isNewUser: result.isNewUser,
        phone:     result.phone,
        // In dev: also return raw token for easy testing
        ...(process.env.NODE_ENV !== 'production' ? { token: result.token } : {}),
      });
    }

    // ── POST /auth/verify ──────────────────────────────────
    // Body: { token: string, phone: string, deviceHash?: string }
    // Returns: { success, sessionToken, role, isNewUser }
    if (url === '/auth/verify' && req.method === 'POST') {
      const body = await readJSON<{ token?: string; phone?: string; deviceHash?: string }>(req);
      if (!body.token || !body.phone) {
        return send(res, 400, { error: 'token and phone are required' });
      }

      const result = await verifyAuthToken({
        rawToken:   body.token,
        phone:      body.phone,
        deviceHash: body.deviceHash,
        ipAddress:  ip,
        userAgent:  req.headers['user-agent'],
      });

      if (!result.success) {
        const statusMap = {
          invalid:           401,
          expired:           401,
          used:              409,
          too_many_attempts: 429,
          banned:            403,
          phone_mismatch:    401,
          // device_conflict is a permanent ban — 403 Forbidden
          device_conflict:   403,
        } as const;
        return send(res, statusMap[result.error] ?? 401, {
          success: false,
          error:   result.error,
        });
      }

      return send(res, 200, {
        success:      true,
        sessionToken: result.sessionToken,
        role:         result.role,
        userId:       result.userId,
        isNewUser:    result.isNewUser,
      });
    }

    // ── POST /auth/logout ──────────────────────────────────
    // Body: {} (reads session from Authorization: Bearer <token>)
    if (url === '/auth/logout' && req.method === 'POST') {
      const rawToken = extractBearerToken(req);
      if (!rawToken) return send(res, 401, { error: 'No session token provided' });
      await revokeSession(rawToken);
      return send(res, 200, { success: true });
    }

    // ── GET /auth/session ──────────────────────────────────
    // Authorization: Bearer <sessionToken>
    // Returns: { userId, role, phone } or 401
    if (url === '/auth/session' && req.method === 'GET') {
      const rawToken = extractBearerToken(req);
      if (!rawToken) return send(res, 401, { error: 'Not authenticated' });
      const session = await validateSession(rawToken);
      if (!session)  return send(res, 401, { error: 'Session invalid or expired' });
      return send(res, 200, { ...session, success: true });
    }

    // ── POST /auth/role ────────────────────────────────────
    // Set role for newly onboarded user (pending → freelancer/client)
    // Body: { role: 'freelancer' | 'client' }
    if (url === '/auth/role' && req.method === 'POST') {
      const rawToken = extractBearerToken(req);
      if (!rawToken) return send(res, 401, { error: 'Not authenticated' });

      const session = await validateSession(rawToken);
      if (!session)  return send(res, 401, { error: 'Session invalid' });

      const body = await readJSON<{ role?: string }>(req);
      if (!body.role || !['freelancer', 'client'].includes(body.role)) {
        return send(res, 400, { error: "role must be 'freelancer' or 'client'" });
      }

      // Only allow pending users to pick role
      if (session.role !== 'pending') {
        return send(res, 409, { error: 'Role already assigned' });
      }

      // Update role in DB
      const { db } = await import('../db/client');
      const { users } = await import('../db/schema');
      const { eq } = await import('drizzle-orm');

      await db.update(users)
        .set({ role: body.role as 'freelancer' | 'client', updatedAt: new Date() })
        .where(eq(users.id, session.userId));

      return send(res, 200, { success: true, role: body.role });
    }

    // ── tRPC /trpc/* ───────────────────────────────────────
    if (url.startsWith('/trpc')) {
      req.url = req.url!.replace('/trpc', '') || '/';
      return trpcHandler(req, res);
    }

    return send(res, 404, { error: 'Not found' });

  } catch (err) {
    console.error('[Server Error]', err);
    return send(res, 500, { error: 'Internal server error' });
  }
});

// ── Helpers ───────────────────────────────────────────────
function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJSON<T = Record<string, unknown>>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}') as T); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function extractBearerToken(req: http.IncomingMessage): string | null {
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

// ── Start ─────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🇳🇵 NepalgGig Backend`);
  console.log(`   POST /auth/request  → generate phone login URL`);
  console.log(`   POST /auth/verify   → verify token → session`);
  console.log(`   POST /auth/logout   → revoke session`);
  console.log(`   GET  /auth/session  → validate session`);
  console.log(`   POST /auth/role     → assign role (pending → freelancer/client)`);
  console.log(`   ANY  /trpc/*        → tRPC API`);
  console.log(`   GET  /health        → health check`);
  console.log(`\n   Running on http://0.0.0.0:${PORT}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
