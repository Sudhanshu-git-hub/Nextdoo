import { z } from 'zod';
import { uuid } from './schemas';
export const connectedSearchQuery = z.object({
  q: z.string().trim().max(200).default(''),
  type: z.enum(['all','task','goal','milestone','tracker','database','record','note','project','list','calendar']).default('all'),
  tagId: uuid.optional(),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(40),
}).strict();
export const connectedCalendarQuery = z.object({
  start: z.string().datetime({offset:true}), end: z.string().datetime({offset:true}),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(100),
}).strict().refine(v=>new Date(v.end)>new Date(v.start)&&new Date(v.end).getTime()-new Date(v.start).getTime()<=93*86400000,'Choose a positive range of at most 93 days.');
export type ConnectedItem = { id:string; type:string; title:string; href:string|null; detail:string; state?:string; version?:number; direct?:boolean; }
export type ConnectedDate = ConnectedItem & { day:string; };
export interface ConnectedPage<T> { data:T[]; nextOffset:number|null; }
