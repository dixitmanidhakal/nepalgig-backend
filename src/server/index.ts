/**
 * NepalgGig Backend — HTTP Server Entry Point
 * Serves tRPC + auth REST endpoints on PORT (default: 4000)
 *
 * Routes:
 *  POST /auth/magic   → send magic link
 *  POST /auth/verify  → verify token → return session
 *  GET  /health       → health check
 *  /trpc/*            → tRPC router
 */

import http from 'http';
import * as dotenv from 'dotenv';
import { createHTTPHandler } from '@trpc/server/adapters/standalone';
import { appRouter }       from './root';
import { createTRPCContext } from './trpc';
import { sendMagicLink, verifyMagicToken } from '../lib/auth';

dotenv.config();

const PORT = Number(process.env.PORT ?? 4000);

// ── tRPC handler ─────────────────────────────────────────
const trpcHandler = createHTTPHandler({
  router:        appRouter,
  createContext: createTRPCContext,
  onError: ({ path, error }) => {
    if (process.env.NODE_ENV === 'development') {
      console.error(`[tRPC] ${path}:`, error.message);
    }
  },
});

// ── HTTP Server ───────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin',  process.env.APP_BASE_URL ?? '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  const url = req.url ?? '/';

  // ── Health check ────────────────────────────────────────
  if (url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'nepalgig-backend', ts: new Date().toISOString() }));
    return;
  }

  // ── POST /auth/magic ────────────────────────────────────
  if (url === '/auth/magic' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const { email, ipAddress, userAgent } = JSON.parse(body) as Record<string, string>;
      if (!email) { send(res, 400, { error: 'email required' }); return; }

      const result = await sendMagicLink({ email, ipAddress, userAgent });

      if (result.error === 'rate_limited') { send(res, 429, { error: 'Rate limited' }); return; }
      if (result.error === 'banned')       { send(res, 200, { success: true });           return; }

      send(res, 200, {
        success: true,
        ...(process.env.NODE_ENV !== 'production' && result.devToken
          ? { devToken: result.devToken } : {}),
      });
    } catch (err) {
      console.error('[/auth/magic]', err);
      send(res, 500, { error: 'Server error' });
    }
    return;
  }

  // ── POST /auth/verify ───────────────────────────────────
  if (url === '/auth/verify' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const { rawToken, email, ipAddress, userAgent } = JSON.parse(body) as Record<string, string>;
      if (!rawToken || !email) { send(res, 400, { error: 'rawToken and email required' }); return; }

      const result = await verifyMagicToken({ rawToken, email, ipAddress, userAgent });
      send(res, result.success ? 200 : 401, result);
    } catch (err) {
      console.error('[/auth/verify]', err);
      send(res, 500, { error: 'Server error' });
    }
    return;
  }

  // ── tRPC (/trpc/*) ──────────────────────────────────────
  if (url.startsWith('/trpc')) {
    req.url = url.replace('/trpc', '');
    return trpcHandler(req, res);
  }

  // 404
  send(res, 404, { error: 'Not found' });
});

// ── Helpers ───────────────────────────────────────────────
function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ── Start ─────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🇳🇵 NepalgGig Backend running on port ${PORT}`);
  console.log(`   tRPC:   http://localhost:${PORT}/trpc`);
  console.log(`   Health: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { server.close(() => process.exit(0)); });
