import { authedRoute } from '@/server/http';
import { settingsCenterStatus } from '@/server/services/settings-center';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export async function GET(request:Request){const response=await authedRoute({routeName:'settings.status'},(_r,ctx)=>settingsCenterStatus(ctx.auth))(request);response.headers.set('Cache-Control','private, no-store');return response;}
