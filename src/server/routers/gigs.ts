/**
 * tRPC Router: Gigs
 * - list (public: funded gigs for freelancers)
 * - get (by id)
 * - create (client only)
 * - update (client only, own gig)
 * - submit proposal (freelancer only, funded gigs)
 * - myGigs (client: own gigs)
 * - myProposals (freelancer: own proposals)
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { eq, and, desc, or, sql, ilike, inArray } from 'drizzle-orm';
import {
  router, publicProcedure, authedProcedure,
  clientProcedure, freelancerProcedure, adminProcedure,
} from '../trpc';
import { gigs, proposals, users } from '@/db/schema';
import {
  createGigSchema, createProposalSchema,
  type CreateGig, type CreateProposal,
} from '@/db/schema/gigs';

export const gigsRouter = router({

  // ── Public: list funded/active gigs ────────────────────
  list: publicProcedure
    .input(z.object({
      category:  z.string().optional(),
      search:    z.string().max(100).optional(),
      province:  z.number().int().min(1).max(7).optional(),
      budgetMin: z.number().int().optional(),
      budgetMax: z.number().int().optional(),
      page:      z.number().int().min(1).default(1),
      limit:     z.number().int().min(1).max(50).default(20),
    }))
    .query(async ({ ctx, input }) => {
      const { category, search, province, budgetMin, budgetMax, page, limit } = input;
      const offset = (page - 1) * limit;

      const conditions = [
        eq(gigs.isFunded, true),
        inArray(gigs.status, ['funded', 'active']),
        eq(gigs.flagged, false),
      ];

      if (category)  conditions.push(eq(gigs.category, category));
      if (province)  conditions.push(eq(gigs.province, province));
      if (budgetMin) conditions.push(sql`${gigs.budgetMinNpr} >= ${budgetMin}`);
      if (budgetMax) conditions.push(sql`${gigs.budgetMaxNpr} <= ${budgetMax}`);
      if (search) {
        conditions.push(
          sql`to_tsvector('english', ${gigs.title} || ' ' || ${gigs.description})
              @@ plainto_tsquery('english', ${search})`
        );
      }

      const rows = await ctx.db
        .select({
          id:           gigs.id,
          title:        gigs.title,
          description:  gigs.description,
          category:     gigs.category,
          subcategory:  gigs.subcategory,
          tags:         gigs.tags,
          budgetMinNpr: gigs.budgetMinNpr,
          budgetMaxNpr: gigs.budgetMaxNpr,
          budgetType:   gigs.budgetType,
          deadline:     gigs.deadline,
          durationDays: gigs.durationDays,
          locationType: gigs.locationType,
          district:     gigs.district,
          province:     gigs.province,
          proposalCount: gigs.proposalCount,
          publishedAt:  gigs.publishedAt,
          expiresAt:    gigs.expiresAt,
          // Client info
          clientDisplayName: users.displayName,
          clientRating:      users.ratingAvg,
          clientDistrict:    users.district,
        })
        .from(gigs)
        .innerJoin(users, eq(gigs.clientId, users.id))
        .where(and(...conditions))
        .orderBy(desc(gigs.publishedAt))
        .limit(limit)
        .offset(offset);

      return { gigs: rows, page, limit };
    }),

  // ── Public: single gig ─────────────────────────────────
  get: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const gig = await ctx.db.query.gigs.findFirst({
        where: and(
          eq(gigs.id, input.id),
          eq(gigs.flagged, false)
        ),
        with: {
          client: {
            columns: {
              id: true,
              displayName: true,
              ratingAvg: true,
              ratingCount: true,
              district: true,
              createdAt: true,
            },
          },
        },
      });

      if (!gig) throw new TRPCError({ code: 'NOT_FOUND', message: 'Gig not found' });

      // Increment view count (fire-and-forget, no await)
      ctx.db
        .update(gigs)
        .set({ viewCount: sql`${gigs.viewCount} + 1` })
        .where(eq(gigs.id, input.id))
        .catch(console.error);

      return gig;
    }),

  // ── Client: create gig ─────────────────────────────────
  create: clientProcedure
    .input(createGigSchema)
    .mutation(async ({ ctx, input }) => {
      const clientId = ctx.user.id;

      // Check client not banned (redundant due to RLS, belt+suspenders)
      const client = await ctx.db.query.users.findFirst({
        where: and(eq(users.id, clientId), eq(users.banned, false)),
      });
      if (!client) throw new TRPCError({ code: 'FORBIDDEN', message: 'Account restricted.' });

      const [gig] = await ctx.db
        .insert(gigs)
        .values({
          clientId,
          title:        input.title,
          description:  input.description,
          category:     input.category,
          subcategory:  input.subcategory,
          tags:         input.tags,
          budgetMinNpr: input.budgetMinNpr,
          budgetMaxNpr: input.budgetMaxNpr,
          budgetType:   input.budgetType,
          deadline:     input.deadline,
          durationDays: input.durationDays,
          locationType: input.locationType,
          district:     input.district,
          province:     input.province,
          status:       'draft',
          isFunded:     false,
        })
        .returning();

      return gig!;
    }),

  // ── Client: own gigs ───────────────────────────────────
  myGigs: clientProcedure
    .input(z.object({
      status: z.enum(['draft', 'pending_review', 'active', 'funded', 'completed', 'cancelled']).optional(),
      page:   z.number().int().min(1).default(1),
      limit:  z.number().int().min(1).max(50).default(20),
    }))
    .query(async ({ ctx, input }) => {
      const { status, page, limit } = input;
      const offset = (page - 1) * limit;

      const conditions = [eq(gigs.clientId, ctx.user.id)];
      if (status) conditions.push(eq(gigs.status, status));

      const rows = await ctx.db
        .select()
        .from(gigs)
        .where(and(...conditions))
        .orderBy(desc(gigs.createdAt))
        .limit(limit)
        .offset(offset);

      return { gigs: rows, page, limit };
    }),

  // ── Freelancer: submit proposal ────────────────────────
  submitProposal: freelancerProcedure
    .input(createProposalSchema)
    .mutation(async ({ ctx, input }) => {
      const freelancerId = ctx.user.id;

      // Verify gig is funded and accepting proposals
      const gig = await ctx.db.query.gigs.findFirst({
        where: and(
          eq(gigs.id, input.gigId),
          eq(gigs.isFunded, true),
          inArray(gigs.status, ['funded', 'active']),
          eq(gigs.flagged, false)
        ),
      });

      if (!gig) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Gig not found or not accepting proposals.',
        });
      }

      // Check freelancer hasn't already proposed
      const existing = await ctx.db.query.proposals.findFirst({
        where: and(
          eq(proposals.gigId, input.gigId),
          eq(proposals.freelancerId, freelancerId)
        ),
      });

      if (existing) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'You have already submitted a proposal for this gig.',
        });
      }

      const [proposal] = await ctx.db
        .insert(proposals)
        .values({
          gigId:         input.gigId,
          freelancerId,
          bidAmountNpr:  input.bidAmountNpr,
          bidType:       input.bidType,
          coverLetter:   input.coverLetter,
          estimatedDays: input.estimatedDays,
          milestones:    input.milestones,
          portfolioItems: input.portfolioItems,
          status:        'pending',
        })
        .returning();

      return proposal!;
    }),

  // ── Freelancer: own proposals ──────────────────────────
  myProposals: freelancerProcedure
    .input(z.object({
      status: z.enum(['pending', 'accepted', 'rejected', 'withdrawn', 'completed']).optional(),
      page:   z.number().int().min(1).default(1),
      limit:  z.number().int().min(1).max(50).default(20),
    }))
    .query(async ({ ctx, input }) => {
      const { status, page, limit } = input;
      const offset = (page - 1) * limit;

      const conditions = [eq(proposals.freelancerId, ctx.user.id)];
      if (status) conditions.push(eq(proposals.status, status));

      const rows = await ctx.db
        .select({
          proposal: proposals,
          gig: {
            id:          gigs.id,
            title:       gigs.title,
            category:    gigs.category,
            budgetMinNpr: gigs.budgetMinNpr,
            budgetMaxNpr: gigs.budgetMaxNpr,
            status:      gigs.status,
          },
        })
        .from(proposals)
        .innerJoin(gigs, eq(proposals.gigId, gigs.id))
        .where(and(...conditions))
        .orderBy(desc(proposals.createdAt))
        .limit(limit)
        .offset(offset);

      return { proposals: rows, page, limit };
    }),

  // ── Client: view proposals on own gig ─────────────────
  gigProposals: clientProcedure
    .input(z.object({
      gigId: z.string().uuid(),
      page:  z.number().int().min(1).default(1),
      limit: z.number().int().min(1).max(50).default(20),
    }))
    .query(async ({ ctx, input }) => {
      // Verify gig belongs to client
      const gig = await ctx.db.query.gigs.findFirst({
        where: and(
          eq(gigs.id, input.gigId),
          eq(gigs.clientId, ctx.user.id)
        ),
      });

      if (!gig) throw new TRPCError({ code: 'NOT_FOUND' });

      const offset = (input.page - 1) * input.limit;

      const rows = await ctx.db
        .select({
          proposal: proposals,
          freelancer: {
            id:          users.id,
            displayName: users.displayName,
            ratingAvg:   users.ratingAvg,
            ratingCount: users.ratingCount,
            skills:      users.skills,
            district:    users.district,
          },
        })
        .from(proposals)
        .innerJoin(users, eq(proposals.freelancerId, users.id))
        .where(eq(proposals.gigId, input.gigId))
        .orderBy(desc(proposals.createdAt))
        .limit(input.limit)
        .offset(offset);

      return { proposals: rows, page: input.page, limit: input.limit };
    }),

  // ── Client: accept proposal ────────────────────────────
  acceptProposal: clientProcedure
    .input(z.object({
      gigId:      z.string().uuid(),
      proposalId: z.string().uuid(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { gigId, proposalId } = input;

      const gig = await ctx.db.query.gigs.findFirst({
        where: and(
          eq(gigs.id, gigId),
          eq(gigs.clientId, ctx.user.id),
          eq(gigs.isFunded, true)
        ),
      });

      if (!gig) throw new TRPCError({ code: 'NOT_FOUND', message: 'Gig not found or not funded.' });

      const proposal = await ctx.db.query.proposals.findFirst({
        where: and(
          eq(proposals.id, proposalId),
          eq(proposals.gigId, gigId),
          eq(proposals.status, 'pending')
        ),
      });

      if (!proposal) throw new TRPCError({ code: 'NOT_FOUND', message: 'Proposal not found.' });

      // Accept this proposal, reject others
      await ctx.db.transaction(async (tx) => {
        await tx
          .update(proposals)
          .set({ status: 'accepted', acceptedAt: new Date() })
          .where(eq(proposals.id, proposalId));

        await tx
          .update(proposals)
          .set({ status: 'rejected' })
          .where(and(
            eq(proposals.gigId, gigId),
            sql`${proposals.id} != ${proposalId}`,
            eq(proposals.status, 'pending')
          ));

        await tx
          .update(gigs)
          .set({ acceptedProposalId: proposalId, status: 'funded' })
          .where(eq(gigs.id, gigId));
      });

      return { success: true };
    }),
});
