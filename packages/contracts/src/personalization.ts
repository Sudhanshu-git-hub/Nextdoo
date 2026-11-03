import { z } from 'zod/v4';
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
/** PATCH body: only the keys being changed. Zod 4 applies inner defaults even
 * under `.optional()` (and `.partial()` fills every key), so each field is
 * stripped of its default first — otherwise an empty `{}` would pass the
 * emptiness refine and every patch would write every key. */
export const personalizationPatchSchema=z.object({
  homeCards:personalizationSchema.shape.homeCards.removeDefault().optional(),
  focusMinutes:personalizationSchema.shape.focusMinutes.removeDefault().optional(),
  breakMinutes:personalizationSchema.shape.breakMinutes.removeDefault().optional(),
  focusMode:personalizationSchema.shape.focusMode.removeDefault().optional(),
  longBreakMinutes:personalizationSchema.shape.longBreakMinutes.removeDefault().optional(),
  sessionsBeforeLongBreak:personalizationSchema.shape.sessionsBeforeLongBreak.removeDefault().optional(),
  focusAutoStart:personalizationSchema.shape.focusAutoStart.removeDefault().optional(),
  homeUpcomingDays:personalizationSchema.shape.homeUpcomingDays.removeDefault().optional(),
  homePriority:personalizationSchema.shape.homePriority.removeDefault().optional(),
  theme:personalizationSchema.shape.theme.removeDefault().optional(),
  accent:personalizationSchema.shape.accent.removeDefault().optional(),
  density:personalizationSchema.shape.density.removeDefault().optional(),
  uiSize:personalizationSchema.shape.uiSize.removeDefault().optional(),
  sidebar:personalizationSchema.shape.sidebar.removeDefault().optional(),
  highContrast:personalizationSchema.shape.highContrast.removeDefault().optional(),
  reducedMotion:personalizationSchema.shape.reducedMotion.removeDefault().optional(),
  startPage:personalizationSchema.shape.startPage.removeDefault().optional(),
  defaultTaskView:personalizationSchema.shape.defaultTaskView.removeDefault().optional(),
  defaultTaskList:personalizationSchema.shape.defaultTaskList.removeDefault().optional(),
  calendarView:personalizationSchema.shape.calendarView.removeDefault().optional(),
  insightsPeriod:personalizationSchema.shape.insightsPeriod.removeDefault().optional(),
  reminderMinutes:personalizationSchema.shape.reminderMinutes.removeDefault().optional(),
  reminderChannel:personalizationSchema.shape.reminderChannel.removeDefault().optional(),
}).strict().refine(v=>Object.keys(v).length>0,'Choose a preference to change.');
export type Personalization=z.infer<typeof personalizationSchema>;
export const PERSONALIZATION_DEFAULTS:Personalization=personalizationSchema.parse({});
