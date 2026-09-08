import { createReminderSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { createReminder, listDueReminders } from '@/server/services/reminders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = authedRoute({ routeName: 'reminders.due' }, async (_r, ctx) => ({
  data: await listDueReminders(ctx.auth.userId),
}));

export const POST = authedRoute({ routeName: 'reminders.create', idempotent: true, rateLimitPerMinute: 120 }, async (request, ctx) => {
  const input = await parseBody(request, createReminderSchema);
  return createReminder({ userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId }, input);
});
