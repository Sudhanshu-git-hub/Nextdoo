import { uuid } from '@nextdoo/contracts';
import { authedRoute } from '@/server/http';
import { markNotificationRead } from '@/server/services/notification-history';
export const runtime = 'nodejs';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
 const { id } = await params;
 return authedRoute({ routeName: 'notifications.read', idempotent: true, rateLimitPerMinute: 120 }, async (_r, ctx) => markNotificationRead({ ...ctx.auth, requestId: ctx.requestId }, uuid.parse(id)))(request);
}
