import { z } from 'zod';
export const personalizationSchema=z.object({
  homeCards:z.array(z.enum(['today','upcoming','overdue','priorities','goals','focus','calendar','tracker','knowledge','notes','insights'])).max(11).refine(v=>new Set(v).size===v.length,'Choose each card only once.').default(['today','upcoming','goals','priorities','calendar','focus','tracker','knowledge']),
  focusMinutes:z.number().int().min(1).max(180).default(25),
  breakMinutes:z.number().int().min(1).max(60).default(5),
  focusMode:z.enum(['stopwatch','pomodoro']).default('stopwatch'),
  longBreakMinutes:z.number().int().min(1).max(120).default(15),
  sessionsBeforeLongBreak:z.number().int().min(1).max(12).default(4),
  focusAutoStart:z.boolean().default(false),
  homeUpcomingDays:z.union([z.literal(3),z.literal(7),z.literal(14)]).default(7),
  homePriority:z.enum(['LOW','MEDIUM','HIGH']).default('HIGH'),
  theme:z.enum(['system','light','dark']).default('system'),
  accent:z.enum(['blue','purple','green']).default('blue'),
  density:z.enum(['comfortable','compact']).default('comfortable'),
  uiSize:z.enum(['standard','large']).default('standard'),
  sidebar:z.enum(['expanded','compact']).default('expanded'),
  highContrast:z.boolean().default(false),reducedMotion:z.boolean().default(false),
  startPage:z.enum(['/home','/tomorrow','/upcoming','/overdue','/backlog','/completed','/focus','/today','/inbox','/tasks','/goals','/trackers','/knowledge','/projects','/calendar','/insights']).default('/today'),
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
