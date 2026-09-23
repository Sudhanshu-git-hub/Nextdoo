import { AppError } from '@nextdoo/contracts';
import { authedRoute } from '@/server/http';
import { connectedToday, connectedTaskContext, searchConnected, connectedCalendar } from '@/server/services/connected';
export const runtime='nodejs';
export async function GET(request:Request,{params}:{params:Promise<{path:string[]}>}) {
  const {path}=await params;
  return authedRoute({routeName:'connected.read'},async(r,ctx):Promise<unknown>=>{
    const query=Object.fromEntries(new URL(r.url).searchParams);
    if(path.length===1&&path[0]==='search')return searchConnected(ctx.auth.workspaceId,query);
    if(path.length===1&&path[0]==='calendar')return connectedCalendar(ctx.auth.workspaceId,query);
    if(path.length===1&&path[0]==='today')return connectedToday(ctx.auth.workspaceId,ctx.auth.userId);
    if(path.length===2&&path[0]==='tasks')return connectedTaskContext(ctx.auth.workspaceId,path[1]!,query);
    throw new AppError('NOT_FOUND','This connected-workflow endpoint does not exist.');
  })(request);
}
