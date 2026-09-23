import { z } from 'zod';
import { AppError, uuid, knowledgeDatabaseInput, knowledgeDatabaseUpdate, knowledgeRecordInput, knowledgeRecordUpdate, knowledgeNoteInput, knowledgeNoteUpdate, knowledgeVersion, knowledgeRelationInput, knowledgeFileInput, knowledgeTargetKind } from '@nextdoo/contracts';
import { knowledgeTemplates } from '@nextdoo/core';
import { authedRoute, parseBody } from '@/server/http';
import * as k from '@/server/services/knowledge';
import * as q from '@/server/services/knowledge-query';
import * as links from '@/server/services/knowledge-relations';

export const runtime = 'nodejs';
type Params = { params: Promise<{ path: string[] }> };
async function handle(request: Request, { params }: Params) {
  const { path } = await params;
  const [collection,id,command,propertyId] = path;
  const method=request.method;
  return authedRoute({ routeName: `knowledge.${method}`, idempotent: method!=='GET', rateLimitPerMinute: method==='GET'?600:120 }, async (r,ctx):Promise<unknown> => {
    const actor={...ctx.auth,requestId:ctx.requestId}, workspace=ctx.auth.workspaceId;
    const query=Object.fromEntries(new URL(r.url).searchParams);
    if (collection==='templates' && path.length===1 && method==='GET') return {data:knowledgeTemplates()};
    if (collection==='resources' && path.length===1 && method==='GET') return q.knowledgeResources(workspace,ctx.auth.userId,query);
    if (collection==='targets' && path.length===1 && method==='GET') return links.searchKnowledgeTargets(workspace,query);
    if (collection==='backlinks' && path.length===1 && method==='GET') {
      const input=z.object({kind:knowledgeTargetKind,id:uuid,offset:z.coerce.number().int().min(0).max(1000000).default(0)}).strict().parse(query);
      return links.knowledgeBacklinks(workspace,input.kind,input.id,input.offset);
    }
    if (collection==='databases') {
      if (path.length===1 && method==='GET') return q.listKnowledgeDatabases(workspace,query);
      if (path.length===1 && method==='POST') return k.createKnowledgeDatabase(actor,await parseBody(r,knowledgeDatabaseInput));
      if(id) uuid.parse(id);
      if (path.length===2 && method==='GET') return q.knowledgeRecordPage(workspace,id!,query);
      if (path.length===2 && method==='PATCH') return k.updateKnowledgeDatabase(actor,id!,await parseBody(r,knowledgeDatabaseUpdate));
      if (path.length===3 && command==='records' && method==='POST') return k.createKnowledgeRecord(actor,id!,await parseBody(r,knowledgeRecordInput));
      if (path.length===3 && command==='export' && method==='GET') { const {format,...filters}=query;return q.exportKnowledgePage(workspace,id!,filters,z.enum(['csv','json']).parse(format)); }
      if (path.length===3 && command==='properties' && method==='POST') return k.saveKnowledgeProperty(actor,id!,null,await parseBody(r,k.knowledgePropertyCommand));
      if (path.length===3 && command==='reorder' && method==='POST') { const input=await parseBody(r,z.object({version:z.number().int().positive(),ids:z.array(uuid).min(1).max(40)}).strict());return k.reorderKnowledgeProperties(actor,id!,input.version,input.ids); }
      if (path.length===4 && command==='properties') {
        uuid.parse(propertyId);
        if(method==='PATCH') return k.saveKnowledgeProperty(actor,id!,propertyId!,await parseBody(r,k.knowledgePropertyCommand));
        if(method==='DELETE') return k.deleteKnowledgeProperty(actor,id!,propertyId!,(await parseBody(r,knowledgeVersion)).version);
      }
    }
    if (collection==='notes' && path.length===1) {
      if(method==='POST') return k.createKnowledgeNote(actor,await parseBody(r,knowledgeNoteInput));
      if(method==='GET') {const {recordId,databaseId,...filters}=query; const parent=z.object({recordId:uuid.optional(),databaseId:uuid.optional()}).parse({recordId,databaseId});return q.listKnowledgeNotes(workspace,filters,parent);}
    }
    if ((collection==='records' || collection==='notes') && id) {
      uuid.parse(id); const record=collection==='records';
      if(path.length===2) {
        if(method==='GET') return record?q.knowledgeRecordDetail(workspace,id):q.knowledgeNoteDetail(workspace,id);
        if(method==='PATCH') return record?k.updateKnowledgeRecord(actor,id,await parseBody(r,knowledgeRecordUpdate)):k.updateKnowledgeNote(actor,id,await parseBody(r,knowledgeNoteUpdate));
        if(method==='DELETE') {const {version}=await parseBody(r,knowledgeVersion);return record?k.setKnowledgeRecordDeleted(actor,id,version,true):k.setKnowledgeNoteDeleted(actor,id,version,true);}
      }
      if(path.length===3 && method==='POST') {
        if(command==='relations') return links.linkKnowledgeRelation(actor,record?'record':'note',id,await parseBody(r,knowledgeRelationInput));
        if(command==='files' && record) return links.linkKnowledgeFile(actor,id,await parseBody(r,knowledgeFileInput));
        if(command==='restore') {const {version}=await parseBody(r,knowledgeVersion);return record?k.setKnowledgeRecordDeleted(actor,id,version,false):k.setKnowledgeNoteDeleted(actor,id,version,false);}
        if(command==='duplicate' && record) return k.duplicateKnowledgeRecord(actor,id,(await parseBody(r,knowledgeVersion)).version);
      }
    }
    throw new AppError('NOT_FOUND','This Knowledge endpoint does not exist.');
  })(request);
}
export const GET=handle;
export const POST=handle;
export const PATCH=handle;
export const DELETE=handle;
