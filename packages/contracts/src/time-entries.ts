import { z } from 'zod';

export const timeEntrySchema = z.object({
  taskId: z.string().uuid(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  note: z.string().trim().min(1).max(500),
}).strict().refine(v => {
  const seconds = (Date.parse(v.endedAt) - Date.parse(v.startedAt)) / 1000;
  return seconds > 0 && seconds <= 86400;
}, 'End must follow start, with no more than 24 hours of work.');

export const editTimeEntrySchema = z.object({
  entryId: z.string().uuid(), version: z.number().int().positive(),
  startedAt: z.string().datetime(), endedAt: z.string().datetime(),
  note: z.string().trim().min(1).max(500),
}).strict().refine(v => Date.parse(v.endedAt) > Date.parse(v.startedAt) && Date.parse(v.endedAt) - Date.parse(v.startedAt) <= 86400000, 'Enter a positive duration up to 24 hours.');
export const removeTimeEntrySchema = z.object({ entryId: z.string().uuid(), version: z.number().int().positive(), note: z.string().trim().min(1).max(500) }).strict();
