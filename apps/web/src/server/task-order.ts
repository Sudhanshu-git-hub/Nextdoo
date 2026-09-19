import { createHash } from 'node:crypto';
import { and, asc, desc, isNull, or, sql, type SQL } from 'drizzle-orm';
import { AppError, isoDateTime, uuid, type TaskQueryInput } from '@nextdoo/contracts';
import { tasks, projects } from '@nextdoo/db';

/** Whitelisted SQL expressions and exact textual cursor keys; never interpolate client SQL. */
export function taskOrder(workspaceId: string, query: TaskQueryInput) {
  const sort = query.sortBy ?? 'createdAt';
  const direction = query.sortOrder ?? (sort === 'createdAt' || sort === 'priority' ? 'desc' : 'asc');
  const fingerprint = createHash('sha256').update(JSON.stringify({ workspaceId, sort, direction,
    status: query.status ?? null, projectId: query.projectId ?? null, tagId: query.tagId ?? null,
    parentTaskId: query.parentTaskId ?? null, dependencyOfTaskId: query.dependencyOfTaskId ?? null,
    priority: query.priority ?? null, q: query.q ?? '', unfiled: query.unfiled ?? false,
    hasDueDate: query.hasDueDate ?? null, dueAfter: query.dueAfter ?? null, dueBefore: query.dueBefore ?? null,
    includeArchived: query.includeArchived ?? false,
  })).digest('hex');
  const values = {
    createdAt: sql`${tasks.createdAt}`, dueAt: sql`${tasks.dueAt}`, estimateMinutes: sql`${tasks.estimateMinutes}`,
    priority: sql`case ${tasks.priority} when 'HIGH' then 3 when 'MEDIUM' then 2 when 'LOW' then 1 else 0 end`,
    position: sql`${tasks.position}`, project: sql`lower(${projects.name}) collate "C"`,
  };
  const value = values[sort];
  const timestamp = sort === 'createdAt' || sort === 'dueAt';
  const selection = timestamp ? sql<string | null>`to_char(${value} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` : sql<string | null>`${value}::text`;
  let after: SQL | undefined;
  if (query.cursor) {
    try {
      const token = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (!token || typeof token !== 'object' || Array.isArray(token)) throw new Error('shape');
      let key: unknown;
      // Previously issued cursors remain accepted only under their original order.
      if (token.v === undefined) {
        if (sort !== 'createdAt' || direction !== 'desc') throw new Error('legacy order');
        key = token.c;
      } else {
        if (token.v !== 1 || token.f !== fingerprint || token.s !== sort || token.d !== direction) throw new Error('query mismatch');
        key = token.k;
      }
      const id = uuid.parse(token.i);
      if (key !== null && typeof key !== 'string') throw new Error('key');
      if (key === null && (sort === 'createdAt' || sort === 'priority' || sort === 'position')) throw new Error('nonnullable key');
      let bound: SQL | undefined;
      if (typeof key === 'string') {
        if (timestamp) {
          isoDateTime.parse(key); if (key.startsWith('0000-')) throw new Error('year');
          bound = sql`${key}::timestamptz`;
        } else if (sort === 'project') {
          if (key.length > 800 || key.includes('\0')) throw new Error('project key');
          bound = sql`${key}::text collate "C"`;
        } else if (sort === 'position') {
          if (!/^-?\d{1,20}(\.\d{1,10})?$/.test(key)) throw new Error('position key');
          bound = sql`${key}::numeric`;
        } else {
          if (!/^\d{1,10}$/.test(key) || Number(key) > (sort === 'priority' ? 3 : 2147483647)) throw new Error('integer key');
          bound = sql`${key}::integer`;
        }
      }
      const nextId = direction === 'asc' ? sql`${tasks.id} > ${id}::uuid` : sql`${tasks.id} < ${id}::uuid`;
      after = bound ? or(direction === 'asc' ? sql`${value} > ${bound}` : sql`${value} < ${bound}`, and(sql`${value} = ${bound}`, nextId), isNull(value)) : and(isNull(value), nextId);
    } catch { throw new AppError('VALIDATION_FAILED', 'Invalid pagination cursor or changed filters/order. Refresh the task list.'); }
  }
  return { selection, after,
    orderBy: [sql`${direction === 'asc' ? asc(value) : desc(value)} nulls last`, direction === 'asc' ? asc(tasks.id) : desc(tasks.id)],
    cursor: (row: { id: string; cursorKey: string | null }) => Buffer.from(JSON.stringify({ v: 1, f: fingerprint, s: sort, d: direction, k: row.cursorKey, i: row.id })).toString('base64url'),
  };
}
