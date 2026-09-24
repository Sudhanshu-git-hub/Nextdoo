import { authedRoute } from '@/server/http';
import { getInsights } from '@/server/services/insights';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){
  const response=await authedRoute({routeName:'insights.read',rateLimitPerMinute:30},(r,ctx)=>getInsights(ctx.auth,Object.fromEntries(new URL(r.url).searchParams)))(request);
  response.headers.set('Cache-Control','private, no-store');return response;
}
