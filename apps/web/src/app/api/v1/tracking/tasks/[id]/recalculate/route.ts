import { z } from 'zod';
import { uuid } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { requestTrackingRecalculation } from '@/server/services/tracking-freshness';
export const runtime='nodejs';
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}) {
 const {id}=await params;
 return authedRoute({routeName:'tracking.recalculate',idempotent:true,rateLimitPerMinute:20},async(r,ctx)=>{
  const input=await parseBody(r,z.object({revision:z.number().int().min(1).max(2147483646),reason:z.string().trim().min(1).max(500)}).strict());
  return requestTrackingRecalculation({...ctx.auth,requestId:ctx.requestId},uuid.parse(id),input.revision,input.reason);
 })(request);
}
