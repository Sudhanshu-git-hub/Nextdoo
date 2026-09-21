import { authedRoute } from '@/server/http';
import { getMfaStatus } from '@/server/services/mfa';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = authedRoute({ routeName: 'auth.mfa_status' }, async (_r, ctx) => getMfaStatus(ctx.auth.userId));
