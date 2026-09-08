import { describe, expect, it } from 'vitest';
import { AppError, type TaskStatus } from '@nextdoo/contracts';
import { allowedActions, canPurge, canTransition, nextStatus, type TaskAction } from './task-state';

const ALL_STATUSES: TaskStatus[] = ['ACTIVE', 'COMPLETED', 'ARCHIVED', 'DELETED'];
const ALL_ACTIONS: TaskAction[] = ['complete', 'reopen', 'archive', 'restore', 'delete', 'purge'];

describe('task state machine', () => {
  describe('permitted transitions', () => {
    const cases: Array<[TaskStatus, TaskAction, string]> = [
      ['ACTIVE', 'complete', 'COMPLETED'],
      ['ACTIVE', 'archive', 'ARCHIVED'],
      ['ACTIVE', 'delete', 'DELETED'],
      ['COMPLETED', 'reopen', 'ACTIVE'],
      ['COMPLETED', 'archive', 'ARCHIVED'],
      ['COMPLETED', 'delete', 'DELETED'],
      ['ARCHIVED', 'restore', 'ACTIVE'],
      ['ARCHIVED', 'delete', 'DELETED'],
      ['DELETED', 'restore', 'ACTIVE'],
      ['DELETED', 'purge', 'PURGED'],
    ];

    it.each(cases)('%s + %s -> %s', (from, action, expected) => {
      expect(canTransition(from, action)).toBe(true);
      expect(nextStatus(from, action)).toBe(expected);
    });
  });

  describe('rejected transitions', () => {
    it('cannot complete an already completed task', () => {
      expect(canTransition('COMPLETED', 'complete')).toBe(false);
      expect(() => nextStatus('COMPLETED', 'complete')).toThrow(AppError);
    });

    it('cannot reopen a task that was never completed', () => {
      expect(canTransition('ACTIVE', 'reopen')).toBe(false);
    });

    it('cannot purge anything that is not deleted', () => {
      for (const status of ['ACTIVE', 'COMPLETED', 'ARCHIVED'] as TaskStatus[]) {
        expect(canTransition(status, 'purge')).toBe(false);
      }
    });

    it('cannot archive a deleted task — it must be restored first', () => {
      expect(canTransition('DELETED', 'archive')).toBe(false);
    });

    it('explains the refusal in language a user could read', () => {
      expect(() => nextStatus('ARCHIVED', 'complete')).toThrow(/cannot complete a task that is archived/i);
    });
  });

  describe('totality', () => {
    it('every status/action pair either transitions or throws — never returns undefined', () => {
      for (const status of ALL_STATUSES) {
        for (const action of ALL_ACTIONS) {
          if (canTransition(status, action)) {
            expect(nextStatus(status, action)).toBeTruthy();
          } else {
            expect(() => nextStatus(status, action)).toThrow(AppError);
          }
        }
      }
    });

    it('allowedActions agrees with canTransition for every pair', () => {
      for (const status of ALL_STATUSES) {
        const allowed = allowedActions(status);
        for (const action of ALL_ACTIONS) {
          expect(allowed.includes(action)).toBe(canTransition(status, action));
        }
      }
    });

    it('every status can still be left, so no task can become permanently stuck', () => {
      for (const status of ALL_STATUSES) {
        expect(allowedActions(status).length).toBeGreaterThan(0);
      }
    });

    it('deletion is reachable from every live status', () => {
      for (const status of ['ACTIVE', 'COMPLETED', 'ARCHIVED'] as TaskStatus[]) {
        expect(canTransition(status, 'delete')).toBe(true);
      }
    });
  });

  describe('purge guard', () => {
    it('allows purge only when deleted, retention elapsed and no retained history', () => {
      expect(canPurge('DELETED', false, true)).toBe(true);
    });

    it('refuses while the retention window is still open', () => {
      expect(canPurge('DELETED', false, false)).toBe(false);
    });

    it('refuses while immutable tracking history still references the task', () => {
      expect(canPurge('DELETED', true, true)).toBe(false);
    });

    it('refuses for any status other than DELETED', () => {
      for (const status of ['ACTIVE', 'COMPLETED', 'ARCHIVED'] as TaskStatus[]) {
        expect(canPurge(status, false, true)).toBe(false);
      }
    });
  });
});
