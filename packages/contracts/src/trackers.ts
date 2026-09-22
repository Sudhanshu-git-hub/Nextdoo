import { z } from 'zod';
import { uuid, timeZone } from './schemas';

export const trackerDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((day) => {
  const at = new Date(`${day}T00:00:00Z`);
  return !day.startsWith('0000') && Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === day;
}, 'Choose a valid calendar date');
const key = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/).refine((v) => !['constructor', 'prototype', '__proto__'].includes(v), 'Reserved field identifier');
export const trackerValueSchema = z.union([z.number().finite().min(-1e9).max(1e9), z.string().max(5000), z.boolean(), z.null()]);
export type TrackerValue = z.infer<typeof trackerValueSchema>;
export const trackerFieldSchema = z.object({
  id: key, label: z.string().trim().min(1).max(80),
  type: z.enum(['number', 'text', 'checkbox', 'select', 'duration', 'date', 'datetime']),
  source: z.enum(['manual', 'task_completed', 'task_count', 'task_duration', 'task_completed_at']),
  unit: z.string().trim().max(40).default(''), options: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
}).strict();
export const trackerDefinitionSchema = z.object({
  columns: z.array(z.object({ semantic: z.enum(['date', 'task', 'input', 'status', 'stars', 'notes']), label: z.string().trim().min(1).max(80), visible: z.boolean() }).strict()).length(6),
  fields: z.array(trackerFieldSchema).min(1).max(20),
  statuses: z.array(z.object({ id: key, name: z.string().trim().min(1).max(80), stars: z.number().int().min(0).max(5) }).strict()).min(1).max(20),
  defaultStatusId: key.nullable(),
  rules: z.array(z.object({
    id: key, statusId: key,
    match: z.enum(['all', 'any']),
    conditions: z.array(z.object({ fieldId: key, operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains']), value: trackerValueSchema }).strict()).min(1).max(10),
  }).strict()).max(30),
}).strict().superRefine((definition, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  for (const [name, items] of [['columns', definition.columns.map((c) => c.semantic)], ['fields', definition.fields.map((f) => f.id)], ['statuses', definition.statuses.map((s) => s.id)], ['rules', definition.rules.map((r) => r.id)]] as const) if (new Set(items).size !== items.length) fail(`Duplicate ${name}`);
  if (!definition.columns.some((c) => c.semantic === 'date' && c.visible)) fail('The date column must remain visible');
  for (const field of definition.fields) {
    if (field.type === 'select' && (!field.options.length || new Set(field.options).size !== field.options.length)) fail('Select fields need unique options');
    if (field.source === 'task_completed' && field.type !== 'checkbox') fail('Task completion uses a checkbox field');
    if (field.source === 'task_count' && field.type !== 'number') fail('Task count uses a number field');
    if (field.source === 'task_duration' && field.type !== 'duration') fail('Task duration uses a duration field in minutes');
    if (field.source === 'task_completed_at' && field.type !== 'datetime') fail('Task completion time uses a date/time field');
  }
  const statusIds = new Set(definition.statuses.map((s) => s.id));
  if (definition.defaultStatusId && !statusIds.has(definition.defaultStatusId)) fail('Unknown default status');
  for (const rule of definition.rules) {
    if (!statusIds.has(rule.statusId)) fail('Unknown rule status');
    for (const condition of rule.conditions) {
      const field = definition.fields.find((f) => f.id === condition.fieldId);
      if (!field) { fail('Unknown condition field'); continue; }
      if (!validTrackerValue(field, condition.value)) fail(`Invalid condition value for ${field.label}`);
      if (['gt', 'gte', 'lt', 'lte'].includes(condition.operator) && !['number', 'duration', 'date', 'datetime'].includes(field.type)) fail('Ordered comparison requires a number, duration or date');
      if (condition.operator === 'contains' && field.type !== 'text') fail('Contains requires a text field');
      if (condition.value === null) fail('Conditions need a comparison value');
    }
  }
});
export type TrackerDefinition = z.infer<typeof trackerDefinitionSchema>;
export type TrackerField = z.infer<typeof trackerFieldSchema>;
export function validTrackerValue(field: TrackerField, value: TrackerValue): boolean {
  if (value === null) return true;
  switch (field.type) {
    case 'number': return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e9;
    case 'duration': return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e9;
    case 'checkbox': return typeof value === 'boolean';
    case 'text': return typeof value === 'string' && value.length <= 5000;
    case 'select': return typeof value === 'string' && field.options.includes(value);
    case 'date': return typeof value === 'string' && trackerDaySchema.safeParse(value).success;
    case 'datetime': return typeof value === 'string' && z.string().datetime({ offset: true }).safeParse(value).success;
  }
}
export const trackerDeliverySchema = z.object({
  enabled: z.boolean(), channel: z.enum(['EMAIL', 'WHATSAPP', 'TELEGRAM']),
  dayOfMonth: z.number().int().min(1).max(28), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59),
}).strict();
export const createTrackerSchema = z.object({
  workspaceId: uuid, name: z.string().trim().min(1).max(200), description: z.string().max(10000).nullish(),
  startDate: trackerDaySchema, timeZone, goalId: uuid.nullish(), frequency: z.enum(['DAILY', 'WEEKLY', 'CUSTOM']).default('DAILY'),
  definition: trackerDefinitionSchema, delivery: trackerDeliverySchema.default({ enabled: false, channel: 'EMAIL', dayOfMonth: 1, hour: 9, minute: 0 }),
}).strict();
export type CreateTrackerInput = z.infer<typeof createTrackerSchema>;
export const updateTrackerSchema = z.object({
  version: z.number().int().positive(), name: z.string().trim().min(1).max(200).optional(), description: z.string().max(10000).nullable().optional(),
  startDate: trackerDaySchema.optional(), goalId: uuid.nullable().optional(), frequency: z.enum(['DAILY', 'WEEKLY', 'CUSTOM']).optional(),
  state: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']).optional(), definition: trackerDefinitionSchema.optional(), delivery: trackerDeliverySchema.optional(),
}).strict().refine((v) => Object.keys(v).some((k) => k !== 'version'), 'No fields to update');
export type UpdateTrackerInput = z.infer<typeof updateTrackerSchema>;
export const trackerEntrySchema = z.object({ day: trackerDaySchema, values: z.record(key, trackerValueSchema), notes: z.string().max(5000).nullish() }).strict();
export type TrackerEntryInput = z.infer<typeof trackerEntrySchema>;
export const updateTrackerEntrySchema = trackerEntrySchema.extend({ version: z.number().int().positive() });
export const trackerEntryVersionSchema = z.object({ version: z.number().int().positive() }).strict();
export const trackerTaskLinkSchema = z.object({ version: z.number().int().positive(), taskId: uuid, linked: z.boolean() }).strict();
export const trackerListSchema = z.object({ includeArchived: z.preprocess((v) => v === 'true' ? true : v === 'false' ? false : v, z.boolean()).default(false), after: uuid.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
export const trackerRangeSchema = z.object({ from: trackerDaySchema, to: trackerDaySchema, after: uuid.optional() }).refine((v) => {
  return Date.parse(v.to) >= Date.parse(v.from);
}, 'Choose an ordered report range');
