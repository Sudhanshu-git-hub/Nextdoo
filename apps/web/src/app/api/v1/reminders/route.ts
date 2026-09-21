import { listReminderHistory } from '@/server/services/notification-history';
import { createReminderSchema, uuid } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { createReminder, listDueReminders } from '@/server/services/reminders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = authedRoute({ routeName: 'reminders.due' }, async (r, ctx) => {
 const query = new URL(r.url).searchParams, taskId = query.get('taskId');
 if (taskId || query.get('history') === 'true') return listReminderHistory(ctx.auth, taskId ? uuid.parse(taskId) : undefined, query.get('cursor') ?? undefined);
 return { data: await listDueReminders(ctx.auth.userId, ctx.auth.workspaceId) };
});

export const POST = authedRoute({ routeName: 'reminders.create', idempotent: true, rateLimitPerMinute: 120 }, async (request, ctx) => {
  const input = await parseBody(request, createReminderSchema);
  return createReminder({ userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId, requestId: ctx.requestId }, input);
});
