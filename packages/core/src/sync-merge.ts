/**
 * Sync conflict detection and resolution (PRD §10.5–§10.6).
 *
 * The governing rule: **never silently discard user-authored content.**
 * Scalar fields may last-write-wins, but free-text fields (title, description)
 * escalate to the user, and anything we refuse to apply is returned so the caller
 * can persist a recoverable snapshot.
 */

export type FieldResolution = 'local' | 'server' | 'conflict';

/** Free-text fields where a silent overwrite would destroy authored content. */
export const USER_AUTHORED_FIELDS = new Set(['title', 'description']);

export interface MergeInput {
  /** Field values the client wants to write. */
  local: Record<string, unknown>;
  /** Current server row. */
  server: Record<string, unknown>;
  /** Server version the client based its edit on. */
  baseVersion: number | null;
  /** Current server version. */
  serverVersion: number;
  /** Server-side deletion tombstone present. */
  serverDeleted?: boolean;
  /** Server-side completion, which outranks a concurrent edit. */
  serverCompleted?: boolean;
}

export interface FieldOutcome {
  field: string;
  resolution: FieldResolution;
  localValue: unknown;
  serverValue: unknown;
}

export interface MergeResult {
  /** True when the client's base version matched — a clean fast-forward. */
  clean: boolean;
  /** Fields safe to write. */
  apply: Record<string, unknown>;
  /** Fields needing user adjudication. */
  conflicts: FieldOutcome[];
  /** Values we declined to apply; persist these so nothing is lost. */
  rejected: Record<string, unknown>;
  status: 'applied' | 'conflict' | 'rejected';
  reason?: string;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

export function mergeEntity(input: MergeInput): MergeResult {
  const { local, server, baseVersion, serverVersion } = input;

  // PRD §10.6: delete wins, but the payload is preserved for restore.
  if (input.serverDeleted) {
    return {
      clean: false,
      apply: {},
      conflicts: [],
      rejected: { ...local },
      status: 'rejected',
      reason: 'The item was deleted on another device. Your edit was kept so it can be restored.',
    };
  }

  // Fast path: client was up to date.
  if (baseVersion !== null && baseVersion === serverVersion) {
    return { clean: true, apply: { ...local }, conflicts: [], rejected: {}, status: 'applied' };
  }

  // Stale base — decide field by field.
  const apply: Record<string, unknown> = {};
  const conflicts: FieldOutcome[] = [];
  const rejected: Record<string, unknown> = {};

  for (const [field, localValue] of Object.entries(local)) {
    const serverValue = server[field];

    // No divergence: applying is a no-op but harmless and keeps intent.
    if (sameValue(localValue, serverValue)) {
      apply[field] = localValue;
      continue;
    }

    // Completion outranks a concurrent edit to status (PRD §10.6).
    if (field === 'status' && input.serverCompleted && localValue !== 'COMPLETED') {
      rejected[field] = localValue;
      continue;
    }

    if (USER_AUTHORED_FIELDS.has(field)) {
      conflicts.push({ field, resolution: 'conflict', localValue, serverValue });
      rejected[field] = localValue;
      continue;
    }

    // Scalar: last-write-wins is acceptable because no authored content is lost.
    apply[field] = localValue;
  }

  if (conflicts.length > 0) {
    return { clean: false, apply, conflicts, rejected, status: 'conflict' };
  }
  return { clean: false, apply, conflicts, rejected, status: 'applied' };
}

/** Timer overlap: keep both sessions and flag, never delete (PRD §10.6). */
export function resolveTimerOverlap(
  existing: { id: string; startedAt: Date },
  incoming: { id: string; startedAt: Date },
): { canonicalId: string; overlappedId: string } {
  return incoming.startedAt.getTime() >= existing.startedAt.getTime()
    ? { canonicalId: incoming.id, overlappedId: existing.id }
    : { canonicalId: existing.id, overlappedId: incoming.id };
}
