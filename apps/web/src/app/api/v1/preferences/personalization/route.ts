import { personalizationPatchSchema } from '@nextdoo/contracts';
import { authedRoute,parseBody } from '@/server/http';
import { getPersonalization,setPersonalization } from '@/server/services/personalization';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){const response=await authedRoute({routeName:'personalization.get'},(_r,ctx)=>getPersonalization(ctx.auth))(request);response.headers.set('Cache-Control','private, no-store');return response;}
export const PATCH=authedRoute({routeName:'personalization.update',idempotent:true,rateLimitPerMinute:60},async(r,ctx)=>setPersonalization(ctx.auth,await parseBody(r,personalizationPatchSchema)));
