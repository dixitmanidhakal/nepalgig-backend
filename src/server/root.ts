/**
 * Root tRPC Router — aggregates all sub-routers
 */

import { router } from './trpc';
import { gigsRouter } from './routers/gigs';
import { usersRouter } from './routers/users';

export const appRouter = router({
  gigs:  gigsRouter,
  users: usersRouter,
});

export type AppRouter = typeof appRouter;
