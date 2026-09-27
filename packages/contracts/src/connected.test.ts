import { expect,it } from 'vitest';
import { connectedSearchQuery } from './connected';
import { knowledgeRelationInput } from './knowledge';
import { taskQuerySchema } from './schemas';
const id='11111111-1111-4111-8111-111111111111';
it('bounds shared search types, tags, query size and pages',()=>{for(const type of ['project','list','calendar'])expect(connectedSearchQuery.parse({type,tagId:id}).type).toBe(type);for(const data of [{type:'attachment'},{tagId:'review'},{q:'x'.repeat(201)},{limit:101},{offset:-1}])expect(connectedSearchQuery.safeParse(data).success).toBe(false);});
it('requires a version and real target identity for native event references',()=>{expect(knowledgeRelationInput.parse({version:1,kind:'native_event',targetId:id,linked:true}).kind).toBe('native_event');expect(knowledgeRelationInput.safeParse({kind:'native_event',targetId:id,linked:true}).success).toBe(false);});
it('accepts the exact project section filter without weakening identity validation',()=>{expect(taskQuerySchema.parse({workspaceId:id,sectionId:id}).sectionId).toBe(id);expect(taskQuerySchema.safeParse({workspaceId:id,sectionId:'not-an-id'}).success).toBe(false);});
