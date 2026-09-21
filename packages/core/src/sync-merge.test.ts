import { describe, expect, it } from 'vitest';
import { mergeEntity, resolveTimerOverlap } from './sync-merge';

describe('mergeEntity', () => {
  it('SY-03: applies cleanly when the client is up to date', () => {
    const r = mergeEntity({
      local: { title: 'New title' },
      server: { title: 'Old title' },
      baseVersion: 5,
      serverVersion: 5,
    });
    expect(r.clean).toBe(true);
    expect(r.status).toBe('applied');
    expect(r.apply).toEqual({ title: 'New title' });
  });

  it('SY-03: merges edits to different scalar fields without conflict', () => {
    const r = mergeEntity({
      local: { priority: 'HIGH' },
      server: { priority: 'NONE', estimateMinutes: 60 },
      baseVersion: 4,
      serverVersion: 5,
    });
    expect(r.status).toBe('applied');
    expect(r.apply).toEqual({ priority: 'HIGH' });
    expect(r.conflicts).toHaveLength(0);
  });

  it('SY-04: escalates concurrent title edits instead of overwriting', () => {
    const r = mergeEntity({
      local: { title: 'Local title' },
      server: { title: 'Server title' },
      baseVersion: 4,
      serverVersion: 6,
    });
    expect(r.status).toBe('conflict');
    expect(r.conflicts[0]).toMatchObject({
      field: 'title',
      localValue: 'Local title',
      serverValue: 'Server title',
    });
    // The rejected value must survive so nothing is lost.
    expect(r.rejected.title).toBe('Local title');
    expect(r.apply.title).toBeUndefined();
  });

  it('escalates description conflicts too', () => {
    const r = mergeEntity({
      local: { description: 'my notes' },
      server: { description: 'their notes' },
      baseVersion: 1,
      serverVersion: 2,
    });
    expect(r.conflicts.map((c) => c.field)).toEqual(['description']);
  });

  it('SY-05: delete wins, but the local edit is preserved for restore', () => {
    const r = mergeEntity({
      local: { title: 'Edited after delete' },
      server: {},
      baseVersion: 3,
      serverVersion: 4,
      serverDeleted: true,
    });
    expect(r.status).toBe('rejected');
    expect(r.apply).toEqual({});
    expect(r.rejected.title).toBe('Edited after delete');
    expect(r.reason).toMatch(/restored/i);
  });

  it('SY-06: server completion outranks a concurrent status edit', () => {
    const r = mergeEntity({
      local: { status: 'ACTIVE', dueAt: '2026-09-10T10:00:00Z' },
      server: { status: 'COMPLETED' },
      baseVersion: 2,
      serverVersion: 3,
      serverCompleted: true,
    });
    expect(r.apply.status).toBeUndefined();
    expect(r.rejected.status).toBe('ACTIVE');
    // The reschedule still applies — it does not conflict with completion.
    expect(r.apply.dueAt).toBe('2026-09-10T10:00:00Z');
  });

  it('treats identical concurrent values as agreement, not conflict', () => {
    const r = mergeEntity({
      local: { title: 'Same' },
      server: { title: 'Same' },
      baseVersion: 1,
      serverVersion: 9,
    });
    expect(r.conflicts).toHaveLength(0);
    expect(r.status).toBe('applied');
  });

  it('never loses a value: everything is either applied, conflicted, or rejected', () => {
    const local = { title: 'T', description: 'D', priority: 'HIGH', estimateMinutes: 30 };
    const r = mergeEntity({
      local,
      server: { title: 'X', description: 'Y', priority: 'LOW', estimateMinutes: 10 },
      baseVersion: 1,
      serverVersion: 2,
    });
    const accounted = new Set([
      ...Object.keys(r.apply),
      ...r.conflicts.map((c) => c.field),
      ...Object.keys(r.rejected),
    ]);
    for (const key of Object.keys(local)) expect(accounted.has(key)).toBe(true);
  });

  it('handles a null baseVersion (offline create) as non-clean', () => {
    const r = mergeEntity({ local: { title: 'A' }, server: { title: 'B' }, baseVersion: null, serverVersion: 1 });
    expect(r.clean).toBe(false);
  });
});

describe('resolveTimerOverlap', () => {
  it('SY-07: keeps both sessions and marks the older one overlapped', () => {
    const existing = { id: 'a', startedAt: new Date('2026-09-08T10:00:00Z') };
    const incoming = { id: 'b', startedAt: new Date('2026-09-08T10:05:00Z') };
    const r = resolveTimerOverlap(existing, incoming);
    expect(r.canonicalId).toBe('b');
    expect(r.overlappedId).toBe('a');
  });

  it('prefers the later start even when it arrives first', () => {
    const existing = { id: 'a', startedAt: new Date('2026-09-08T11:00:00Z') };
    const incoming = { id: 'b', startedAt: new Date('2026-09-08T10:00:00Z') };
    expect(resolveTimerOverlap(existing, incoming).canonicalId).toBe('a');
  });
});
