import { and,eq,isNull,inArray } from 'drizzle-orm';
import { AppError,PERSONALIZATION_DEFAULTS,personalizationSchema,personalizationPatchSchema,type Personalization } from '@nextdoo/contracts';
import { userPreferences,projects } from '@nextdoo/db';
import { getDb } from '../db';
import { assertWorkspaceAccess } from '../auth';
import { withWorkspaceTransaction } from './transactions';
import { writeAuditLog } from './events';
const keys=Object.keys(PERSONALIZATION_DEFAULTS) as (keyof Personalization)[];
type Actor={userId:string;workspaceId:string};
/** Existing preference storage, export and purge own these values. */
export async function getPersonalization(actor:Actor):Promise<Personalization>{
  await assertWorkspaceAccess(actor.userId,actor.workspaceId);
  const rows=await getDb().select().from(userPreferences).where(and(eq(userPreferences.userId,actor.userId),inArray(userPreferences.key,keys.map(k=>'personal.'+k))));
  const values:Record<string,unknown>={...PERSONALIZATION_DEFAULTS};
  for(const row of rows){const key=row.key.slice(9) as keyof Personalization;const parsed=personalizationSchema.shape[key].safeParse(row.value);if(parsed.success)values[key]=parsed.data;}
  const result=personalizationSchema.parse(values);
  if(result.defaultTaskList&&!await activeProject(actor.workspaceId,result.defaultTaskList))result.defaultTaskList=null;
  return result;
}
async function activeProject(workspaceId:string,id:string){const [row]=await getDb().select({id:projects.id}).from(projects).where(and(eq(projects.id,id),eq(projects.workspaceId,workspaceId),eq(projects.status,'ACTIVE'),isNull(projects.deletedAt)));return row;}
export async function setPersonalization(actor:Actor,raw:unknown){
  const patch=personalizationPatchSchema.parse(raw);
  return withWorkspaceTransaction(actor.workspaceId,async db=>{
    await assertWorkspaceAccess(actor.userId,actor.workspaceId);
    if(patch.defaultTaskList&&!await activeProject(actor.workspaceId,patch.defaultTaskList))throw new AppError('VALIDATION_FAILED','Choose an active project in your workspace.');
    for(const key of keys){const value=patch[key];if(value===undefined)continue;if(value===null){await db.delete(userPreferences).where(and(eq(userPreferences.userId,actor.userId),eq(userPreferences.key,'personal.'+key)));continue;}await db.insert(userPreferences).values({userId:actor.userId,key:'personal.'+key,value}).onConflictDoUpdate({target:[userPreferences.userId,userPreferences.key],set:{value,updatedAt:new Date()}});}
    await writeAuditLog({userId:actor.userId,action:'account.preferences_updated',entityType:'user',entityId:actor.userId,metadata:{fields:Object.keys(patch).map(k=>'personal.'+k)}});
    return getPersonalization(actor);
  });
}
