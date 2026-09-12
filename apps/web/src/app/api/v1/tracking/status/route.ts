import { z } from 'zod';
import { authedRoute, parseQuery } from '@/server/http';
import { listTrackingStatus } from '@/server/services/tracking-history';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const GET=authedRoute({ routeName:'tracking.status',rateLimitPerMinute:120 },async(request,ctx)=>{
 const query=parseQuery(request,z.object({ cursor:z.string().max(1500).optional(),filter:z.enum(['all','attention','failed']).default('all') }).strict());
 return listTrackingStatus(ctx.auth,query.cursor,query.filter);
});
