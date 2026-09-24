import { z } from 'zod';
export const insightsQuerySchema=z.object({
  period:z.enum(['day','week','month','quarter','year','custom']).default('month'),
  date:z.string().date().optional(),from:z.string().date().optional(),to:z.string().date().optional(),
  compare:z.enum(['true','false']).default('false'),
}).strict();
export type InsightsQuery=z.infer<typeof insightsQuerySchema>;
export interface InsightsWindow {period:InsightsQuery['period'];from:string;to:string;start:string;end:string;days:number;timeZone:string;complete:boolean;}
