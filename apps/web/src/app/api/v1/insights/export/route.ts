import { AppError } from '@nextdoo/contracts';
import { authedRoute } from '@/server/http';
import { getInsights } from '@/server/services/insights';
import { insightsExport } from '@/server/services/insights-export';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){
  const response=await authedRoute({routeName:'insights.export',rateLimitPerMinute:15},async(r,ctx)=>{
    const {format,...query}=Object.fromEntries(new URL(r.url).searchParams);
    if(format!=='csv'&&format!=='json')throw new AppError('VALIDATION_FAILED','Choose CSV or JSON.');
    return insightsExport(await getInsights(ctx.auth,query),format);
  })(request);
  response.headers.set('Cache-Control','private, no-store');return response;
}
