/**
 * tRPC Initialization
 * - Creates context from session cookie
 * - Middleware: authed, freelancer, client, admin
 */

import { initTRPC, TRPCError } from '@trpc/server';
import { type NextRequest } from 'next/server';
import superjson from 'superjson';
import { z } from 'zod';
import { db } from '@/db/client';
import { validateSession } from '@/lib/auth';
import { SESSION_COOKIE } from '@/lib/constants';
import type { UserRole } from '@/lib/constants';

// ── Context ───────────────────────────────────────────────

export interface TRPCContext {
  req:    NextRequest;
  db:     typeof db;
  user:   { id: string; role: UserRole; sessionId: string } | null;
}

export async function createTRPCContext(req: NextRequest): Promise<TRPCContext> {
  const sessionToken =
    req.cookies.get(SESSION_COOKIE)?.value ??
    req.headers.get('x-session-token') ?? '';

  let user: TRPCContext['user'] = null;

  if (sessionToken) {
    const session = await validateSession(sessionToken);
    if (session) {
      user = {
        id:        session.userId,
        role:      session.role as UserRole,
        sessionId: session.sessionId,
      };
    }
  }

  return { req, db, user };
}

// ── tRPC instance ─────────────────────────────────────────

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        // Don't leak stack traces in production
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      },
    };
  },
});

// ── Exports ───────────────────────────────────────────────
export const router     = t.router;
export const publicProcedure = t.procedure;

// ── Middleware: set RLS context ───────────────────────────
const withRLS = t.middleware(async ({ ctx, next }) => {
  if (ctx.user?.id) {
    // Set PostgreSQL session variable for RLS
    await ctx.db.execute(
      `SET LOCAL app.user_id = '${ctx.user.id}'` as unknown as Parameters<typeof ctx.db.execute>[0]
    );
  }
  return next();
});

// ── Middleware: require auth ──────────────────────────────
const isAuthed = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Please log in.' });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

// ── Middleware: require role ──────────────────────────────
function requireRole(...roles: UserRole[]) {
  return t.middleware(({ ctx, next }) => {
    if (!ctx.user) {
      throw new TRPCError({ code: 'UNAUTHORIZED' });
    }
    if (!roles.includes(ctx.user.role)) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `This action requires role: ${roles.join(' or ')}`,
      });
    }
    return next({ ctx: { ...ctx, user: ctx.user } });
  });
}

// ── Procedure types ───────────────────────────────────────
export const authedProcedure     = t.procedure.use(withRLS).use(isAuthed);
export const freelancerProcedure = t.procedure.use(withRLS).use(isAuthed).use(requireRole('freelancer'));
export const clientProcedure     = t.procedure.use(withRLS).use(isAuthed).use(requireRole('client'));
export const adminProcedure      = t.procedure.use(withRLS).use(isAuthed).use(requireRole('admin'));
