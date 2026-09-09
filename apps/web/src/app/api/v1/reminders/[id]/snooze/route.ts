import { snoozeReminderSchema, taskVersionSchema, uuid } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { snoozeReminder } from '@/server/services/reminders';
export const runtime = 'nodejs';
const schema = snoozeReminderSchema.merge(taskVersionSchema).strict();
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
 const { id } = await params;
 return authedRoute({ routeName: 'reminders.snooze', idempotent: true, rateLimitPerMinute: 120 }, async (r, ctx) => { const input = await parseBody(r, schema); return snoozeReminder({ ...ctx.auth, requestId: ctx.requestId }, uuid.parse(id), input.minutes, input.version); })(request);
}
