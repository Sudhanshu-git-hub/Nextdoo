import { z } from 'zod';
export const personalizationSchema=z.object({
  theme:z.enum(['system','light','dark']).default('system'),
  accent:z.enum(['blue','purple','green']).default('blue'),
  density:z.enum(['comfortable','compact']).default('comfortable'),
  uiSize:z.enum(['standard','large']).default('standard'),
  sidebar:z.enum(['expanded','compact']).default('expanded'),
  highContrast:z.boolean().default(false),reducedMotion:z.boolean().default(false),
  startPage:z.enum(['/today','/inbox','/tasks','/goals','/trackers','/knowledge','/projects','/calendar','/insights']).default('/today'),
  defaultTaskView:z.enum(['list','board']).default('list'),
  defaultTaskList:z.string().uuid().nullable().default(null),
  calendarView:z.enum(['day','week','month','year','agenda']).default('week'),
  insightsPeriod:z.enum(['day','week','month','quarter','year']).default('month'),
  reminderMinutes:z.number().int().min(0).max(43200).default(15),
  reminderChannel:z.enum(['WEB','PUSH']).default('WEB'),
}).strict();
export const personalizationPatchSchema=personalizationSchema.partial().refine(v=>Object.keys(v).length>0,'Choose a preference to change.');
export type Personalization=z.infer<typeof personalizationSchema>;
export const PERSONALIZATION_DEFAULTS:Personalization=personalizationSchema.parse({});
