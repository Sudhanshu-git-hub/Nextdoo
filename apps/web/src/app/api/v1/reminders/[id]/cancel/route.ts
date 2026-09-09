import { taskVersionSchema, uuid } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { cancelReminder } from '@/server/services/reminders';
export const runtime = 'nodejs';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
 const { id } = await params;
 return authedRoute({ routeName: 'reminders.cancel', idempotent: true, rateLimitPerMinute: 120 }, async (r, ctx) => cancelReminder({ ...ctx.auth, requestId: ctx.requestId }, uuid.parse(id), (await parseBody(r, taskVersionSchema.strict())).version))(request);
}
