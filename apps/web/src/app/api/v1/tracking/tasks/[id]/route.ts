import { z } from 'zod';
import { uuid } from '@nextdoo/contracts';
import { authedRoute, parseQuery } from '@/server/http';
import { getTrackingDetail } from '@/server/services/tracking-history';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}) {
 const {id}=await params;
 return authedRoute({routeName:'tracking.task',rateLimitPerMinute:180},async(r,ctx)=>{
  const query=parseQuery(r,z.object({ eventCursor:z.string().max(1500).optional(),historyCursor:z.string().max(1500).optional() }).strict());
  return getTrackingDetail(ctx.auth,uuid.parse(id),query.eventCursor,query.historyCursor);
 })(request);
}
