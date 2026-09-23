import { z } from 'zod';
import { uuid } from './schemas';
import { trackerDaySchema } from './trackers';

export const KNOWLEDGE_TYPES = ['TITLE', 'TEXT', 'RICH_TEXT', 'NUMBER', 'CHECKBOX', 'SELECT', 'MULTI_SELECT', 'DATE', 'URL', 'EMAIL', 'PHONE', 'FILE', 'RELATION'] as const;
export const knowledgeType = z.enum(KNOWLEDGE_TYPES);
export const knowledgeTargetKind = z.enum(['record', 'database', 'note', 'task', 'goal', 'milestone', 'tracker', 'calendar']);
export const knowledgeConfig = z.object({ options: z.array(z.string().trim().min(1).max(80)).max(50).default([]), relationKind: knowledgeTargetKind.default('record'), relationDatabaseId: uuid.nullable().default(null) }).strict();
export const knowledgePropertyInput = z.object({ name: z.string().trim().min(1).max(80), type: knowledgeType, hidden: z.boolean().default(false), config: knowledgeConfig.default({}) }).strict().superRefine((p, ctx) => {
  if (['SELECT', 'MULTI_SELECT'].includes(p.type) && (!p.config.options.length || new Set(p.config.options).size !== p.config.options.length)) ctx.addIssue({ code: 'custom', message: 'Select properties require unique choices.' });
  if (p.type === 'TITLE' && p.hidden) ctx.addIssue({ code: 'custom', message: 'The title property stays visible.' });
  if (p.config.relationDatabaseId && (p.type !== 'RELATION' || p.config.relationKind !== 'record')) ctx.addIssue({ code: 'custom', message: 'A related database applies only to record relations.' });
});
export type KnowledgePropertyInput = z.infer<typeof knowledgePropertyInput>;
export const knowledgeDatabaseInput = z.object({ name: z.string().trim().min(1).max(200), description: z.string().max(10000).nullable().default(null), icon: z.string().max(8).nullable().default(null), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().default(null), templateId: z.string().max(40).optional(), properties: z.array(knowledgePropertyInput).min(1).max(40).optional() }).strict();
export const knowledgeDatabaseUpdate = z.object({ version: z.number().int().positive(), name: z.string().trim().min(1).max(200).optional(), description: z.string().max(10000).nullable().optional(), icon: z.string().max(8).nullable().optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(), archived: z.boolean().optional(), favorite: z.boolean().optional() }).strict().refine((v) => Object.keys(v).length > 1, 'Choose something to update.');
export const knowledgeValue = z.union([z.string().max(20000), z.number().finite().min(-1e12).max(1e12), z.boolean(), z.array(z.string().max(80)).max(50), z.null()]);
export type KnowledgeValue = z.infer<typeof knowledgeValue>;
export const knowledgeRecordInput = z.object({ title: z.string().trim().min(1).max(500), content: z.string().max(20000).default(''), values: z.record(uuid, knowledgeValue).default({}) }).strict();
export const knowledgeRecordUpdate = knowledgeRecordInput.extend({ version: z.number().int().positive() });
export const knowledgeVersion = z.object({ version: z.number().int().positive() }).strict();
export const knowledgeNoteInput = z.object({ title: z.string().trim().min(1).max(500), content: z.string().max(20000).default(''), databaseId: uuid.nullable().default(null), recordId: uuid.nullable().default(null), tagIds: z.array(uuid).max(30).default([]) }).strict().refine((n) => !(n.databaseId && n.recordId), 'Choose a database or record for the note.');
export const knowledgeNoteUpdate = z.object({ version: z.number().int().positive(), title: z.string().trim().min(1).max(500), content: z.string().max(20000), tagIds: z.array(uuid).max(30).default([]) }).strict();
export const knowledgeRelationInput = z.object({ version: z.number().int().positive(), propertyId: uuid.nullable().default(null), kind: knowledgeTargetKind, targetId: uuid, linked: z.boolean() }).strict();
export const knowledgeFileInput = z.object({ version: z.number().int().positive(), propertyId: uuid, attachmentId: uuid, linked: z.boolean() }).strict();
export const knowledgeFilter = z.object({ propertyId: uuid, operator: z.enum(['eq', 'contains', 'exists', 'missing', 'gt', 'gte', 'lt', 'lte']), value: knowledgeValue.optional() }).strict();
export const knowledgeQuery = z.object({ q: z.string().trim().max(200).default(''), limit: z.coerce.number().int().min(1).max(100).default(40), offset: z.coerce.number().int().min(0).max(1000000).default(0), includeDeleted: z.preprocess((v) => v === 'true' ? true : v === 'false' ? false : v, z.boolean()).default(false), favorite: z.preprocess((v) => v === 'true' ? true : v === 'false' ? false : v, z.boolean()).default(false), sort: z.union([z.enum(['title', 'createdAt', 'updatedAt']), uuid]).default('updatedAt'), direction: z.enum(['asc', 'desc']).default('desc'), filters: z.preprocess((v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } }, z.array(knowledgeFilter).max(10)).default([]) }).strict();
export function validKnowledgeValue(property: Pick<KnowledgePropertyInput, 'type' | 'config'>, value: KnowledgeValue): boolean {
  if (value === null) return true;
  switch (property.type) {
    case 'TITLE': return typeof value === 'string' && value.trim().length > 0 && value.length <= 500;
    case 'TEXT': case 'RICH_TEXT': return typeof value === 'string' && value.length <= 20000;
    case 'NUMBER': return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12;
    case 'CHECKBOX': return typeof value === 'boolean';
    case 'DATE': return typeof value === 'string' && trackerDaySchema.safeParse(value).success;
    case 'SELECT': return typeof value === 'string' && property.config.options.includes(value);
    case 'MULTI_SELECT': return Array.isArray(value) && new Set(value).size === value.length && value.every((v) => property.config.options.includes(v));
    case 'URL': { if (typeof value !== 'string') return false; try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; } }
    case 'EMAIL': return typeof value === 'string' && z.string().email().max(254).safeParse(value).success;
    case 'PHONE': return typeof value === 'string' && /^[+\d() .-]{3,40}$/.test(value);
    case 'FILE': case 'RELATION': return false; // Dedicated owned reference commands, never arbitrary JSON.
  }
}
