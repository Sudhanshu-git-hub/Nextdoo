import { limitsFor } from '@nextdoo/contracts';
import { z } from 'zod';
import { authedRoute, parseQuery } from '@/server/http';
import { getPlan } from '@/server/services/accounts';
import { listAuditLogs } from '@/server/services/data-rights';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `category` is an allow-list, not a free-text prefix: the caller may narrow to
 * a known namespace but cannot craft an arbitrary LIKE pattern.
 */
const CATEGORY_PREFIXES = { account: 'account.', task: 'task.' } as const;

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  category: z.enum(['account', 'task']).optional(),
});

/**
 * Security-relevant history for the signed-in user (PRD §12.4), bounded by the
 * plan's audit-log retention (PRD §18.1: Free None, Pro 30 days, Team 1 year,
 * Enterprise 7 years).
 */
export const GET = authedRoute({ routeName: 'audit.list' }, async (request, ctx) => {
  const { limit, category } = parseQuery(request, querySchema);
  const prefix = category ? CATEGORY_PREFIXES[category] : undefined;
  const retentionDays = limitsFor(await getPlan(ctx.auth.userId)).auditLogRetentionDays;
  return { data: await listAuditLogs(ctx.auth.userId, ctx.auth.workspaceId, limit, prefix, retentionDays) };
});
