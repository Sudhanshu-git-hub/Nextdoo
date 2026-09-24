import { z } from 'zod';
import { AppError } from '@nextdoo/contracts';
import { authedRoute,parseBody,problemResponse,toProblem } from '@/server/http';
import * as service from '@/server/services/calendar-center';
export const runtime='nodejs';
export const dynamic='force-dynamic';
type Params={params:Promise<{path:string[]}>};
async function handle(request:Request,params:Params){
  // Bound bytes before the shared idempotency layer clones/parses the body.
  if(request.method!=='GET'&&request.body){try{const reader=request.body.getReader(),chunks:Uint8Array[]= [];let size=0;
    for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>2100000){await reader.cancel();throw new AppError('VALIDATION_FAILED','Calendar request exceeds 2.1 MB.');}chunks.push(chunk.value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    request=new Request(request.url,{method:request.method,headers:request.headers,body:new TextDecoder().decode(bytes)});
  }catch(e){return problemResponse(toProblem(e,crypto.randomUUID()));}}
  const {path}=await params.params;
  return authedRoute({routeName:'calendar.center.'+request.method,idempotent:request.method!=='GET',rateLimitPerMinute:120},async(r,ctx):Promise<unknown>=>{
    const actor={...ctx.auth,requestId:ctx.requestId},[kind,id,action]=path;
    if(r.method==='GET'){
      if(kind==='sources'&&path.length===1)return {data:await service.listCalendarSources(actor)};
      if(kind==='events'&&path.length===1)return service.listCenterEvents(actor,Object.fromEntries(new URL(r.url).searchParams),true);
      if(kind==='events'&&path.length===2)return service.loadNativeEvent(actor,id!);
      if(kind==='sources'&&id&&action==='export'&&path.length===3)return {content:await service.exportCalendar(actor,id)};
      throw new AppError('NOT_FOUND','Calendar command not found.');
    }
    const body=await parseBody(r,z.unknown());
    if(kind==='sources'&&path.length===1&&r.method==='POST')return service.createCalendarSource(actor,body);
    if(kind==='sources'&&path.length===2&&r.method==='PATCH')return service.updateCalendarSource(actor,id!,body);
    if(kind==='events'&&path.length===1&&r.method==='POST')return service.saveNativeEvent(actor,null,body);
    if(kind==='events'&&path.length===2&&r.method==='PATCH')return service.saveNativeEvent(actor,id!,body);
    if(kind==='events'&&path.length===2&&r.method==='DELETE'){const {version}=z.object({version:z.number().int().positive()}).strict().parse(body);return service.deleteNativeEvent(actor,id!,version);}
    if(kind==='import'&&path.length===1&&r.method==='POST')return service.importCalendar(actor,body);
    throw new AppError('NOT_FOUND','Calendar command not found.');
  })(request);
}
export const GET=handle,POST=handle,PATCH=handle,DELETE=handle;
