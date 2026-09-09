import { authedRoute } from '@/server/http';
import { listNotifications } from '@/server/services/notification-history';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = authedRoute({ routeName: 'notifications.list' }, async (r, ctx) => listNotifications(ctx.auth, new URL(r.url).searchParams.get('cursor') ?? undefined));
