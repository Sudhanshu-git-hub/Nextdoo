import { z } from 'zod';
import { authedRoute, parseBody } from '@/server/http';
import { getProfile, updateProfile } from '@/server/services/account-sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const profilePatchSchema = z
  .object({
    name: z.union([z.string().trim().min(1).max(120), z.null()]).optional(),
    timeZone: z.string().trim().min(1).max(64).optional(),
  })
  .refine((v) => v.name !== undefined || v.timeZone !== undefined, {
    message: 'Provide name and/or timeZone.',
  });

/** PRD §6.1/§14.3 — the authenticated user's own profile, nothing else. */
export const GET = authedRoute({ routeName: 'me.get', rateLimitPerMinute: 120 }, async (_request, ctx) =>
  getProfile(ctx.auth.userId),
);

/** PRD §6.1/§14.3 — strict profile update; idempotent (PRD §10.7). */
export const PATCH = authedRoute({ routeName: 'me.update', rateLimitPerMinute: 30, idempotent: true }, async (request, ctx) =>
  updateProfile(ctx.auth.userId, await parseBody(request, profilePatchSchema)),
);
