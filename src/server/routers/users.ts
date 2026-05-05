/**
 * tRPC Router: Users
 * - me (own profile)
 * - updateProfile
 * - getPublicProfile
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import {
  router, publicProcedure, authedProcedure, adminProcedure,
} from '../trpc';
import { users } from '@/db/schema';
import { updateProfileSchema } from '@/db/schema/users';

export const usersRouter = router({

  // ── Own profile ────────────────────────────────────────
  me: authedProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.query.users.findFirst({
      where: eq(users.id, ctx.user.id),
      columns: {
        // Exclude internal fields
        deviceHash:    false,
        failedAttempts: false,
        lastFailedAt:  false,
      },
    });

    if (!user) throw new TRPCError({ code: 'NOT_FOUND' });
    return user;
  }),

  // ── Update own profile ─────────────────────────────────
  updateProfile: authedProcedure
    .input(updateProfileSchema)
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(users)
        .set({
          fullName:      input.fullName,
          displayName:   input.displayName,
          bio:           input.bio,
          district:      input.district,
          province:      input.province,
          skills:        input.skills,
          hourlyRateNpr: input.hourlyRateNpr,
          portfolioUrls: input.portfolioUrls,
          updatedAt:     new Date(),
        })
        .where(eq(users.id, ctx.user.id))
        .returning();

      return updated!;
    }),

  // ── Public profile (freelancers) ───────────────────────
  getPublicProfile: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const user = await ctx.db.query.users.findFirst({
        where: eq(users.id, input.id),
        columns: {
          id:            true,
          displayName:   true,
          avatarUrl:     true,
          skills:        true,
          bio:           true,
          hourlyRateNpr: true,
          district:      true,
          province:      true,
          ratingAvg:     true,
          ratingCount:   true,
          totalEarnedNpr: true,
          createdAt:     true,
          role:          true,
        },
      });

      if (!user || user.banned || !['freelancer', 'client'].includes(user.role ?? '')) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }

      return user;
    }),

  // ── Admin: ban user ────────────────────────────────────
  ban: adminProcedure
    .input(z.object({
      userId:    z.string().uuid(),
      reason:    z.string().min(10).max(500),
      expiresAt: z.string().datetime().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(users)
        .set({
          banned:       true,
          banReason:    input.reason,
          banExpiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
        })
        .where(eq(users.id, input.userId))
        .returning({ id: users.id });

      return { success: true, userId: updated?.id };
    }),

  // ── Admin: assign role ─────────────────────────────────
  assignRole: adminProcedure
    .input(z.object({
      userId: z.string().uuid(),
      role:   z.enum(['pending', 'freelancer', 'client', 'admin']),
    }))
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(users)
        .set({ role: input.role, updatedAt: new Date() })
        .where(eq(users.id, input.userId))
        .returning({ id: users.id, role: users.role });

      return updated!;
    }),
});
